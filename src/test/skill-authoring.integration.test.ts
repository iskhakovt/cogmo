/// <reference path="../../test/vitest.d.ts" />

/**
 * Skill-authoring e2e — chat -> delegate_coding -> register_skill -> invoke.
 *
 * The single integration that proves: a user asking for a skill in chat
 * results in a new tool the agent can call on the next turn. Drives the
 * full pipeline end-to-end against record/replay cassettes:
 *
 *   - `DaytonaMock` proxies all Daytona HTTP + WS traffic (snapshot
 *     lifecycle, sandbox create, fs upload, PTY frames, git clone, exec
 *     sessions, delete). The wrapper `DaytonaSandboxClient` is real;
 *     only the upstream is mocked.
 *   - llmock handles Anthropic `/v1/messages` for the host's agent loop.
 *     In-sandbox claude-cli hits real Anthropic at record time and the
 *     stream-json output gets baked into the DaytonaMock PTY frames; in
 *     replay no real sandbox runs.
 *   - The cogmo-skills coding-repo points at a real GitHub repo set via
 *     `COGMO_TEST_SKILLS_REMOTE` (a throwaway repo the operator
 *     authorized). All test branches sit under
 *     `cogmo/run/skill-author-<uuid>*` + `refs/cogmo-wip/skill-author-<uuid>*`
 *     orphan namespaces — main is never touched. `afterAll` deletes
 *     branches + closes the draft PR.
 *
 * See `design/testing.md` -> Skill-Authoring Integration for the
 * contract.
 *
 * ## To re-record cassettes (operator workflow)
 *
 *   1. Populate `.env` with `DAYTONA_API_KEY`, `ANTHROPIC_API_KEY`,
 *      optionally `DAYTONA_ORGANIZATION_ID`, and
 *      `COGMO_TEST_SKILLS_REMOTE=https://github.com/<owner>/<throwaway>.git`.
 *      A throwaway is strongly recommended over a production skills
 *      repo even though branches stay in the orphan namespace.
 *   2. `gh auth status` — the PAT comes from gh CLI's keyring. Scope
 *      requirements: `repo` (push branches, open + close PRs).
 *   3. `RECORD=1 pnpm test:integration src/test/skill-authoring.integration.test.ts`
 *   4. Re-run without `RECORD=1` to confirm replay is byte-stable.
 *   5. Commit the refreshed fixture + any llmock recordings under
 *      `test/fixtures/recorded/` that bear today's date.
 *
 * The first record run is expected to surface adjustments to the
 * scaffold (timeouts, polling cadence, assertion shapes) — that's the
 * intended feedback loop. Each iteration costs ~$1-2 in Daytona
 * compute + Anthropic tokens.
 */

import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { and, desc, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { connect } from "inngest/connect";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { codingTasks } from "../agent/coding/store/schema.js";
import { conversations, llmProviders, modelProviders, profiles } from "../agent/store/schema.js";
import * as schema from "../db/schemas.js";
import { bootstrap } from "../index.js";
import { directOutbound } from "../inngest/events.js";
import { DaytonaSandboxClient, snapshotNameFor } from "../sandbox/daytona/client.js";
import { deriveMasterKey, encrypt, parseMasterKey, toBase64 } from "../secrets/encryption.js";
import { secrets } from "../secrets/store/schema.js";
import { skills } from "../skills/store/schema.js";
import { channelSessions, channels, inboundMessages } from "../transport/store/schema.js";
import { expectDefined } from "./assertions.js";
import { DaytonaMock, type DaytonaMockOptions } from "./daytona-mock.js";

const execFileP = promisify(execFileCb);

// --- Mode gating ─────────────────────────────────────────────────────

const SCENARIO = "skill-authoring";
const FIXTURE_DIR = "./test/fixtures/daytona";
const FIXTURE_PATH = `${FIXTURE_DIR}/${SCENARIO}.json`;
const IS_RECORD = process.env.RECORD === "1";
const HAS_RECORDING_INPUTS =
  !!process.env.DAYTONA_API_KEY &&
  !!process.env.ANTHROPIC_API_KEY &&
  !!process.env.COGMO_TEST_SKILLS_REMOTE;
const RECORDABLE = IS_RECORD && HAS_RECORDING_INPUTS;
const FIXTURE_EXISTS = existsSync(FIXTURE_PATH);
// Replay mode also requires `COGMO_TEST_SKILLS_REMOTE` because the
// host-side `setOriginAndFetch` step runs unconditionally — the
// Daytona mock doesn't intercept host-side git. CI without the env
// var set skips cleanly; an operator running locally with both the
// fixture and the env present runs the full replay.
const HAS_REPLAY_INPUTS = !!process.env.COGMO_TEST_SKILLS_REMOTE;
const RUNNABLE = RECORDABLE || (FIXTURE_EXISTS && HAS_REPLAY_INPUTS);

// --- Outbound capture (mirrors pipeline.integration.test.ts) ─────────

interface CapturedOutbound {
  platformAddress: string;
  content: string;
}
const capturedOutbound: CapturedOutbound[] = [];

/**
 * Test-run id — encoded in sandbox/session URLs. Stable across both
 * modes so the recorded fixture's paths match what replay produces.
 * Two record runs colliding on `cogmo/run/skill-author-N` would step on
 * each other; not a concern for solo-dev recording.
 */
const TEST_RUN_ID = "skill-author";
const TASK_BRANCH_GLOB = `cogmo/run/${TEST_RUN_ID}`;

describe.skipIf(!RUNNABLE)("skill-authoring e2e", { timeout: 40 * 60_000 }, () => {
  let mock: DaytonaMock;
  let daytonaClient: DaytonaSandboxClient;
  let bootstrapResult: Awaited<ReturnType<typeof bootstrap>>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let connection: Awaited<ReturnType<typeof connect>>;
  let defaultUserId: string;
  let inngestBaseUrl: string;
  /** GitHub remote we push test branches to. From `COGMO_TEST_SKILLS_REMOTE`. */
  let remoteUrl: string;
  /** owner/repo extracted from remoteUrl, used for gh API calls. */
  let remoteSlug: string;
  /** Tracks branches/PRs created during the test so afterAll can clean them up. */
  const createdBranches: string[] = [];
  const createdPrNumbers: number[] = [];

  beforeAll(async () => {
    inngestBaseUrl = inject("inngestBaseUrl");
    const databaseUrl = inject("databaseUrl");
    defaultUserId = inject("defaultUserId");
    db = drizzle({ connection: databaseUrl, schema });

    console.log(`[skill-authoring e2e] TEST_RUN_ID=${TEST_RUN_ID}`);

    if (RECORDABLE) {
      // Pre-build the devbase snapshot from the local Dockerfile so the
      // test stays self-contained — no ghcr push required. Cogmo's
      // `ensureImagePresent` later derives the same name via
      // `snapshotNameFor()` and short-circuits on the pre-built snapshot.
      // Also pre-create + wait for the deps-cache volume so register's
      // lockfile-compile sandbox doesn't race a `pending_create` volume.
      await prebuildDaytonaPrereqs();

      // Reset origin/main on the throwaway skills repo so claude doesn't
      // pull leftover SKILL.md + skill.py from a previous successful run.
      const remote = expectDefined(process.env.COGMO_TEST_SKILLS_REMOTE);
      const { pat } = await readGhAuth();
      await resetRemoteMain(remote, pat);
    }

    const mockOpts: DaytonaMockOptions = RECORDABLE
      ? {
          mode: "record",
          fixturePath: FIXTURE_PATH,
          upstreamUrl: process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api",
          upstreamApiKey: process.env.DAYTONA_API_KEY ?? "",
          ...(process.env.DAYTONA_ORGANIZATION_ID && {
            upstreamOrganizationId: process.env.DAYTONA_ORGANIZATION_ID,
          }),
        }
      : { mode: "replay", fixturePath: FIXTURE_PATH };
    mock = await DaytonaMock.create(mockOpts);
    if (RECORDABLE) mock.beginScenario(SCENARIO);

    // Deterministic random source keeps session IDs stable record↔replay.
    let seq = 0;
    daytonaClient = await DaytonaSandboxClient.create({
      apiKey: RECORDABLE ? (process.env.DAYTONA_API_KEY ?? "") : "test-key",
      apiUrl: mock.url,
      instanceId: "skill-authoring",
      random: () => `${TEST_RUN_ID}-${++seq}`,
      ...(RECORDABLE &&
        process.env.DAYTONA_ORGANIZATION_ID && {
          organizationId: process.env.DAYTONA_ORGANIZATION_ID,
        }),
    });

    // `COGMO_TEST_SKILLS_REMOTE` is required in BOTH record and replay
    // modes. `setOriginAndFetch` below runs a host-side `git fetch
    // origin +refs/heads/main:refs/heads/main` against this URL — the
    // Daytona mock only proxies traffic between Cogmo and Daytona, not
    // host-side git. A placeholder URL fails with "Could not read from
    // remote repository" before the test reaches the mock at all.
    remoteUrl = expectDefined(process.env.COGMO_TEST_SKILLS_REMOTE);
    remoteSlug = parseGitHubSlug(remoteUrl);

    // Fall back to a fake PAT only when gh is missing; other failures surface.
    const ghAuth = await readGhAuth().catch((err: Error) => {
      if (!/enoent|not found|command not found/i.test(err.message)) throw err;
      return { pat: "test-pat", login: "test-user", id: "0" };
    });
    const signingKeypair = await generateSigningKeypair();

    // Init the bare skills repo + wire origin BEFORE `bootstrap()` so
    // `ensureSkillsCodingRepo` reads the right `origin` for the row.
    const skillsPath = expectDefined(
      process.env.COGMO_SKILLS_PATH,
      "COGMO_SKILLS_PATH not set by integration setup",
    );
    const { bootstrapSkillsRepo } = await import("../skills/repo.js");
    await bootstrapSkillsRepo({ path: skillsPath });
    await setOriginAndFetch(skillsPath, remoteUrl, ghAuth.pat);

    await seedSecretsAndProvider({
      db,
      anthropicApiKey: RECORDABLE ? expectDefined(process.env.ANTHROPIC_API_KEY) : "test-key",
      llmockUrl: inject("llmockBaseUrl"),
      identity: {
        pat: ghAuth.pat,
        sshPrivateKey: signingKeypair.privateKey,
        sshPublicKey: signingKeypair.publicKey,
        login: ghAuth.login,
        id: ghAuth.id,
      },
    });

    // 6. LLM provider override for the host's agent loop.
    const { AnthropicProvider } = await import("../llm/anthropic.js");
    const anthropicKey = RECORDABLE ? expectDefined(process.env.ANTHROPIC_API_KEY) : "test-key";
    const provider = new AnthropicProvider(anthropicKey, inject("llmockBaseUrl"));

    // Auto-approve plans so the orchestrator drives plan -> execute
    // -> commit -> PR without a manual gate.
    await db
      .update(profiles)
      .set({ codingAutoapproveMode: "on" })
      .where(eq(profiles.userId, defaultUserId));

    bootstrapResult = await bootstrap({
      providerOverride: provider,
      sandboxClientOverride: daytonaClient,
      codingAuthOverride: async () => {
        const { ok } = await import("neverthrow");
        // Pinned model + disabled thinking match `claude-cli.integration.test.ts`
        // and keep the recorded stream-json output stable across runs.
        return ok({
          ANTHROPIC_API_KEY: anthropicKey,
          ANTHROPIC_MODEL: "claude-haiku-4-5-20251001",
          MAX_THINKING_TOKENS: "0",
        });
      },
    });

    const captureOutbound = bootstrapResult.inngest.createFunction(
      { id: "skill-authoring-capture-outbound", triggers: [directOutbound] },
      async ({ event }) => {
        capturedOutbound.push(event.data);
        return { captured: true };
      },
    );

    connection = await connect({
      apps: [
        {
          client: bootstrapResult.inngest,
          functions: [...bootstrapResult.functions, captureOutbound],
        },
      ],
    });
  }, 10 * 60_000);

  afterAll(async () => {
    if (RECORDABLE && mock) await mock.endScenario();
    if (connection) await connection.close();
    if (bootstrapResult) {
      for (const adapter of bootstrapResult.adapters) await adapter.stop();
      await bootstrapResult.skillRunner.shutdown();
      await bootstrapResult.mcpRegistry.stop();
      if (bootstrapResult.sandbox) await bootstrapResult.sandbox.shutdown();
    }
    if (mock) await mock.stop();
    // gh CLI cleanup runs BEFORE closing the DB pool so a future
    // cleanup step that needs DB access doesn't hit a closed pool.
    // Each step is tolerant of "not found" / "already closed" — the
    // test may have failed before creating any of these.
    if (RECORDABLE) await cleanupGitHub();
    if (db) await db.$client.end();
  });

  it("creates a skill via chat and invokes it on the next turn", async () => {
    // --- Turn 1: ask for the skill ----------------------------------
    // Set auto-approve on ALL profiles right before the task runs —
    // bootstrap's profile-management might reset the default profile's
    // codingAutoapproveMode, so the earlier beforeAll update isn't load-
    // bearing. The orchestrator's resolver reads the conversation's
    // profile via JOIN, so the value at task-run time is what counts.
    //
    // TODO: drop this blanket UPDATE once bootstrap's profile-management
    // is made idempotent on `codingAutoapproveMode` (currently it may
    // overwrite the value on every boot). At single-row scale here the
    // unscoped update is harmless, but it's a smell worth fixing at the
    // source.
    await db.update(profiles).set({ codingAutoapproveMode: "on" });
    const { conversationId, sessionId } = await seedConversation(db, defaultUserId);
    await sendInbound(
      db,
      sessionId,
      conversationId,
      "Create a skill called btc-spot that fetches the current bitcoin USD price " +
        "from coingecko (https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd) " +
        "and returns { price: <number> }. Use Python stdlib (urllib.request + json) " +
        "— no third-party deps. Do NOT declare dependencies in SKILL.md, do NOT " +
        "create a requirements.lock file.",
    );
    await sendEvent(inngestBaseUrl, "inbound/arrived", {
      conversationId,
      inboundMessageId: await latestInboundId(db, conversationId),
    });

    // Full flow: plan + execute + verify + push + open-PR. 30m budget.
    const task = await waitForCodingTask(db, conversationId, 30 * 60_000);
    if (task.status !== "pr_open") {
      console.error(
        `[skill-authoring e2e] task ended in ${task.status} — failureReason="${task.failureReason}"`,
      );
    }
    expect(task.status).toBe("pr_open");

    // Track for cleanup. Branch name = `cogmo/run/<task-id>` (see `runBranchFor`).
    createdBranches.push(`cogmo/run/${task.id}`);
    if (task.prMetadata) createdPrNumbers.push(task.prMetadata.number);

    // Skill registered. `lockfileHash` is null on this stdlib-only path —
    // the deps-bearing flow is a separate follow-up cassette blocked on
    // the slow uv compile in the lockfile-compile sandbox.
    const skillRow = await waitForSkill(db, "btc-spot", 60_000);
    expect(skillRow.name).toBe("btc-spot");

    // --- Turn 2: invoke the new skill -------------------------------
    await sendInbound(db, sessionId, conversationId, "What's bitcoin at?");
    await sendEvent(inngestBaseUrl, "inbound/arrived", {
      conversationId,
      inboundMessageId: await latestInboundId(db, conversationId),
    });

    // Anchor on tens-of-thousands shape so years / HTTP codes don't false-positive.
    const replyRe = /\$?\s?\d{2,3}[,.]?\d{3}|\$?\d+k/i;
    const reply = await waitForOutbound(
      (e) => replyRe.test(e.content) && e.platformAddress === sessionId,
      60_000,
    );
    expect(reply.content).toMatch(replyRe);
  });

  // --- Cleanup helper bound to the describe scope ------------------

  async function cleanupGitHub(): Promise<void> {
    for (const num of createdPrNumbers) {
      try {
        await execFileP("gh", [
          "pr",
          "close",
          String(num),
          "--delete-branch",
          "--repo",
          remoteSlug,
        ]);
        console.log(`[skill-authoring e2e] closed PR ${num}`);
      } catch (err) {
        console.warn(`[skill-authoring e2e] failed to close PR ${num}:`, (err as Error).message);
      }
    }
    // Delete any orphaned test branches that gh pr close didn't catch
    // (e.g. branches pushed before the PR was opened, or the task
    // failed before opening a PR). Glob-match by the test run ID so
    // we don't accidentally delete other runs' branches.
    try {
      const { stdout } = await execFileP("gh", [
        "api",
        `repos/${remoteSlug}/branches`,
        "--paginate",
        "--jq",
        `.[] | select(.name | startswith("${TASK_BRANCH_GLOB}")) | .name`,
      ]);
      for (const branch of stdout.split("\n").filter(Boolean)) {
        try {
          await execFileP("gh", [
            "api",
            `repos/${remoteSlug}/git/refs/heads/${branch}`,
            "-X",
            "DELETE",
          ]);
          console.log(`[skill-authoring e2e] deleted branch ${branch}`);
        } catch (err) {
          console.warn(`[skill-authoring e2e] failed to delete ${branch}:`, (err as Error).message);
        }
      }
    } catch (err) {
      console.warn(`[skill-authoring e2e] branch list failed:`, (err as Error).message);
    }
    // Same for `refs/cogmo-wip/<test-uuid>*` — set on task failure.
    try {
      const { stdout } = await execFileP("gh", [
        "api",
        `repos/${remoteSlug}/git/matching-refs/cogmo-wip/${TEST_RUN_ID}`,
        "--jq",
        ".[] | .ref",
      ]);
      for (const ref of stdout.split("\n").filter(Boolean)) {
        try {
          // ref is `refs/cogmo-wip/<id>`; gh api wants the path AFTER `refs/`.
          const refPath = ref.replace(/^refs\//, "");
          await execFileP("gh", ["api", `repos/${remoteSlug}/git/refs/${refPath}`, "-X", "DELETE"]);
          console.log(`[skill-authoring e2e] deleted WIP ref ${ref}`);
        } catch (err) {
          console.warn(`[skill-authoring e2e] failed to delete ${ref}:`, (err as Error).message);
        }
      }
    } catch (err) {
      console.warn(`[skill-authoring e2e] WIP ref list failed:`, (err as Error).message);
    }
  }
});

// --- Helpers ─────────────────────────────────────────────────────────

/** Owner/repo slug extracted from an HTTPS or SSH GitHub URL. */
function parseGitHubSlug(url: string): string {
  // HTTPS: https://github.com/owner/repo.git
  // SSH: git@github.com:owner/repo.git
  const match = url.match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?$/);
  if (!match?.[1]) {
    throw new Error(`Cannot extract owner/repo from URL: ${url}`);
  }
  return match[1];
}

interface SnapshotApi {
  get(name: string): Promise<{ state: string }>;
  delete(snapshot: unknown): Promise<unknown>;
  create(params: { name: string; image: unknown }): Promise<unknown>;
}
async function ensureSnapshot(
  realSdk: { snapshot: SnapshotApi },
  label: string,
  name: string,
  imageProvider: () => unknown,
): Promise<void> {
  try {
    const existing = await realSdk.snapshot.get(name);
    if (existing.state === "active") {
      console.log(`[skill-authoring e2e] ${label} snapshot ${name} already active — reusing`);
      return;
    }
    console.log(
      `[skill-authoring e2e] ${label} snapshot ${name} in state ${existing.state} — deleting + rebuilding`,
    );
    await realSdk.snapshot.delete(existing);
  } catch (err) {
    if (!/not.found|404/i.test((err as Error).message)) throw err;
  }
  console.log(`[skill-authoring e2e] building ${label} snapshot ${name}...`);
  await realSdk.snapshot.create({ name, image: imageProvider() });
  console.log(`[skill-authoring e2e] ${label} snapshot ${name} ready`);
}

/**
 * Reset origin/main on the test skills repo to a single empty commit so
 * every record run starts from a clean state. Previous run's auto-register
 * mirror-pushed SKILL.md + skill.py to main, and the next run's claude
 * would clone that, see the files already present, and do nothing.
 */
async function resetRemoteMain(remoteUrl: string, pat: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "cogmo-skills-reset-"));
  try {
    const { withGitAskpass } = await import("../secrets/git-askpass.js");
    await execFileP("git", ["init", "--initial-branch=main", dir]);
    await execFileP("git", ["-C", dir, "config", "user.email", "skill-author-test@cogmo"]);
    await execFileP("git", ["-C", dir, "config", "user.name", "skill-author-test"]);
    await execFileP("git", [
      "-C",
      dir,
      "commit",
      "--allow-empty",
      "-m",
      "skill-authoring e2e: reset main to empty",
    ]);
    await withGitAskpass(pat, async (env) =>
      execFileP("git", ["-C", dir, "push", "--force", remoteUrl, "HEAD:refs/heads/main"], {
        env: { ...process.env, ...env },
      }),
    );
    console.log(`[skill-authoring e2e] reset ${remoteUrl} main to empty commit`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function prebuildDaytonaPrereqs(): Promise<void> {
  const imageRef = expectDefined(
    process.env.COGMO_DEVBASE_IMAGE,
    "COGMO_DEVBASE_IMAGE must be set in record mode (snapshot name + cogmo override key — registry doesn't need to exist)",
  );
  const snapshotName = expectDefined(
    snapshotNameFor(imageRef),
    `snapshotNameFor(${imageRef}) returned null — COGMO_DEVBASE_IMAGE must include a non-latest tag`,
  );
  const depsVolumeName = expectDefined(process.env.COGMO_SKILLS_DEPS_VOLUME);
  const { Daytona, Image } = await import("@daytonaio/sdk");
  const apiKey = expectDefined(process.env.DAYTONA_API_KEY);
  const realSdk = new Daytona({
    apiKey,
    apiUrl: process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api",
    ...(process.env.DAYTONA_ORGANIZATION_ID && {
      organizationId: process.env.DAYTONA_ORGANIZATION_ID,
    }),
  });

  // 1a. Devbase snapshot
  await ensureSnapshot(realSdk, "devbase", snapshotName, () =>
    Image.fromDockerfile("images/devbase/Dockerfile"),
  );

  // 1b. cogmo-skills snapshot — register's lockfile-compile sandbox uses
  // this image. The default `:latest` tag is a ghcr.io pull, not a local
  // build; Daytona stages it on first use.
  const skillsImageRef = expectDefined(
    process.env.COGMO_SKILLS_IMAGE ?? "ghcr.io/iskhakovt/cogmo-skills:latest",
  );
  // The default tag is `latest` which `snapshotNameFor` refuses. Fall back
  // to passing the image directly to Daytona so it stages under its own
  // generated name; cogmo's `ensureImagePresent` no-ops on `:latest`.
  const skillsSnapshotName = snapshotNameFor(skillsImageRef);
  if (skillsSnapshotName) {
    await ensureSnapshot(realSdk, "cogmo-skills", skillsSnapshotName, () => skillsImageRef);
  } else {
    console.log(
      `[skill-authoring e2e] cogmo-skills image ${skillsImageRef} is :latest — lazy-pull on first use`,
    );
  }

  // 2. Deps-cache volume — get-or-create then poll until ready. Register's
  // lockfile-compile sandbox attaches this volume; if it's still in
  // `pending_create` when the sandbox boots, register fails with
  // `requirements_lock_transport_failed`.
  console.log(`[skill-authoring e2e] ensuring deps-cache volume ${depsVolumeName} is ready...`);
  await realSdk.volume.get(depsVolumeName, true);
  const start = Date.now();
  while (Date.now() - start < 120_000) {
    const v = await realSdk.volume.get(depsVolumeName);
    if (v.state === "ready") {
      console.log(`[skill-authoring e2e] deps-cache volume ${depsVolumeName} ready`);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`deps-cache volume ${depsVolumeName} did not become ready within 120s`);
}

async function readGhAuth(): Promise<{ pat: string; login: string; id: string }> {
  const { stdout: tokenStdout } = await execFileP("gh", ["auth", "token"]);
  const pat = tokenStdout.trim();
  if (!pat) throw new Error("`gh auth token` returned empty — run `gh auth login` first");
  const { stdout: userStdout } = await execFileP("gh", ["api", "user", "--jq", "{login,id}"]);
  const user = JSON.parse(userStdout) as { login: string; id: number };
  return { pat, login: user.login, id: String(user.id) };
}

/**
 * Generate an Ed25519 keypair in OpenSSH format via `ssh-keygen`.
 * Node's `generateKeyPairSync` only emits PKCS#8 PEM, which the
 * `ssh-keygen -Y sign` signer git invokes under `gpg.format=ssh`
 * rejects. Commits go out "Unverified" — fine for test runs because
 * push / PR-open don't gate on signature verification.
 */
async function generateSigningKeypair(): Promise<{ privateKey: string; publicKey: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cogmo-signing-key-"));
  try {
    const keyPath = join(dir, "key");
    await execFileP("ssh-keygen", [
      "-t",
      "ed25519",
      "-f",
      keyPath,
      "-N",
      "",
      "-C",
      "cogmo-test-signing",
      "-q",
    ]);
    const [privateKey, publicKey] = await Promise.all([
      readFile(keyPath, "utf8"),
      readFile(`${keyPath}.pub`, "utf8"),
    ]);
    return { privateKey, publicKey };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function setOriginAndFetch(
  skillsPath: string,
  remoteUrl: string,
  pat: string,
): Promise<void> {
  // Idempotent origin setup: try `remote add`, fall back to `set-url`.
  // Origin URL is stored without credentials — auth flows through the
  // askpass helper, matching how the orchestrator's own git ops work.
  await execFileP("git", ["-C", skillsPath, "remote", "add", "origin", remoteUrl]).catch(async () =>
    execFileP("git", ["-C", skillsPath, "remote", "set-url", "origin", remoteUrl]),
  );
  // Bare repo: fetch main into refs/heads/main directly so worktrees
  // can branch from it. Uses the project's askpass helper so the PAT
  // never lands on disk in the bare repo's config.
  const { withGitAskpass } = await import("../secrets/git-askpass.js");
  await withGitAskpass(pat, async (env) => {
    await execFileP(
      "git",
      ["-C", skillsPath, "fetch", "origin", "+refs/heads/main:refs/heads/main"],
      { env: { ...process.env, ...env } },
    );
  });
}

async function seedSecretsAndProvider(opts: {
  db: ReturnType<typeof drizzle<typeof schema>>;
  anthropicApiKey: string;
  llmockUrl: string;
  identity: {
    pat: string;
    sshPrivateKey: string;
    sshPublicKey: string;
    login: string;
    id: string;
  };
}): Promise<void> {
  const masterKeyRaw = expectDefined(process.env.COGMO_MASTER_KEY, "COGMO_MASTER_KEY not set");
  const encKey = deriveMasterKey(parseMasterKey(masterKeyRaw), "cogmo/secrets-at-rest/v1");

  const identityEnc = encrypt(encKey, JSON.stringify(opts.identity));
  const anthropicEnc = encrypt(encKey, opts.anthropicApiKey);

  await opts.db.transaction(async (tx) => {
    // `github_identity:default` — `coding_repos.identity_name`
    // resolves to "default" via `ensureSkillsCodingRepo`.
    await tx
      .insert(secrets)
      .values({
        name: "github_identity:default",
        ciphertext: toBase64(identityEnc.ciphertext),
        nonce: toBase64(identityEnc.nonce),
        description: "skill-authoring e2e test",
      })
      .onConflictDoUpdate({
        target: secrets.name,
        set: {
          ciphertext: toBase64(identityEnc.ciphertext),
          nonce: toBase64(identityEnc.nonce),
        },
      });

    // `anthropic_api_key` — not load-bearing for the agent loop here
    // (`providerOverride` short-circuits the resolver) but seeded so
    // any indirect secrets lookup succeeds during bootstrap.
    const [anthropicSecret] = await tx
      .insert(secrets)
      .values({
        name: "anthropic_api_key",
        ciphertext: toBase64(anthropicEnc.ciphertext),
        nonce: toBase64(anthropicEnc.nonce),
        description: "skill-authoring e2e test",
      })
      .onConflictDoUpdate({
        target: secrets.name,
        set: {
          ciphertext: toBase64(anthropicEnc.ciphertext),
          nonce: toBase64(anthropicEnc.nonce),
        },
      })
      .returning({ id: secrets.id });
    if (!anthropicSecret) throw new Error("anthropic_api_key secret insert returned no row");

    // `llm_providers` row + a `model_providers` mapping for the
    // default profile's model.
    const [provider] = await tx
      .insert(llmProviders)
      .values({
        name: "anthropic",
        type: "anthropic",
        baseUrl: opts.llmockUrl,
        secretId: anthropicSecret.id,
        attrs: {},
      })
      .onConflictDoUpdate({
        target: llmProviders.name,
        set: { baseUrl: opts.llmockUrl, secretId: anthropicSecret.id },
      })
      .returning({ id: llmProviders.id });
    if (!provider) throw new Error("llm_providers insert returned no row");

    const profileRows = await tx.select({ model: profiles.model }).from(profiles).limit(1);
    const profileRow = expectDefined(profileRows[0], "Default profile not found");
    await tx
      .insert(modelProviders)
      .values({
        model: profileRow.model,
        providerId: provider.id,
        position: 0,
        userSelectable: true,
      })
      .onConflictDoNothing();
  });
}

async function seedConversation(
  db: ReturnType<typeof drizzle<typeof schema>>,
  userId: string,
): Promise<{ conversationId: string; sessionId: string }> {
  const profileRows = await db.select({ id: profiles.id }).from(profiles).limit(1);
  const channelRows = await db.select({ id: channels.id }).from(channels).limit(1);
  const profileId = expectDefined(profileRows[0]?.id);
  const channelId = expectDefined(channelRows[0]?.id);
  const [conv] = await db
    .insert(conversations)
    .values({ userId, profileId, isPrivate: true })
    .returning({ id: conversations.id });
  const conversationId = expectDefined(conv?.id);
  const [session] = await db
    .insert(channelSessions)
    .values({
      channelId,
      // Encodes TEST_RUN_ID (fixed in replay mode) rather than Date.now()
      // so the platform address is stable across runs and DaytonaMock /
      // any downstream fixture matching that captures it doesn't have to
      // mask the timestamp out.
      platformAddress: `skill-${TEST_RUN_ID}`,
      conversationId,
      status: "active",
      receive: "routed",
    })
    .returning({ id: channelSessions.id, platformAddress: channelSessions.platformAddress });
  const sessionId = expectDefined(session?.id);
  return { conversationId, sessionId: session?.platformAddress ?? sessionId };
}

async function sendInbound(
  db: ReturnType<typeof drizzle<typeof schema>>,
  sessionPlatformAddress: string,
  conversationId: string,
  content: string,
): Promise<void> {
  const sessionRows = await db
    .select({ id: channelSessions.id })
    .from(channelSessions)
    .where(eq(channelSessions.platformAddress, sessionPlatformAddress))
    .limit(1);
  const sessionId = expectDefined(sessionRows[0]?.id);
  await db.insert(inboundMessages).values({
    channelSessionId: sessionId,
    conversationId,
    content,
    platformTs: new Date(),
    source: "user",
  });
}

async function latestInboundId(
  db: ReturnType<typeof drizzle<typeof schema>>,
  conversationId: string,
): Promise<string> {
  const rows = await db
    .select({ id: inboundMessages.id, createdAt: inboundMessages.createdAt })
    .from(inboundMessages)
    .where(eq(inboundMessages.conversationId, conversationId));
  const sorted = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return expectDefined(sorted[0]?.id);
}

async function sendEvent(
  inngestBaseUrl: string,
  name: string,
  data: Record<string, unknown>,
): Promise<void> {
  const resp = await fetch(`${inngestBaseUrl}/e/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data }),
  });
  if (!resp.ok) throw new Error(`Inngest event send failed: ${resp.status} ${await resp.text()}`);
}

async function waitForCodingTask(
  db: ReturnType<typeof drizzle<typeof schema>>,
  conversationId: string,
  timeoutMs: number,
): Promise<typeof codingTasks.$inferSelect> {
  const start = Date.now();
  let lastSeenStatus = "";
  while (Date.now() - start < timeoutMs) {
    const rows = await db
      .select()
      .from(codingTasks)
      .where(and(eq(codingTasks.conversationId, conversationId), ne(codingTasks.status, "queued")))
      .orderBy(desc(codingTasks.createdAt));
    const latest = rows[0];
    if (latest && latest.status !== lastSeenStatus) {
      lastSeenStatus = latest.status;
      console.error(
        `[skill-authoring e2e] task status: ${latest.status} (${Math.round((Date.now() - start) / 1000)}s)`,
      );
    }
    const terminal = rows.find(
      (r) => r.status === "pr_open" || r.status === "failed" || r.status === "cancelled",
    );
    if (terminal) return terminal;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `coding task did not reach terminal state within ${timeoutMs}ms; last status: ${lastSeenStatus}`,
  );
}

async function waitForSkill(
  db: ReturnType<typeof drizzle<typeof schema>>,
  name: string,
  timeoutMs: number,
): Promise<typeof skills.$inferSelect> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await db.select().from(skills).where(eq(skills.name, name)).limit(1);
    if (rows[0]) return rows[0];
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`skill '${name}' was not registered within ${timeoutMs}ms`);
}

async function waitForOutbound(
  predicate: (e: CapturedOutbound) => boolean,
  timeoutMs: number,
): Promise<CapturedOutbound> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const match = capturedOutbound.find(predicate);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for matching directOutbound event`);
}
