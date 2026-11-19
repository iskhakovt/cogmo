/// <reference path="../../test/vitest.d.ts" />

/**
 * Skill-authoring e2e — chat -> delegate_coding -> auto-register -> invoke.
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
 *   - The authored skill's `ctx.http` call is answered in-process by a
 *     stand-in network (`skillCtxHttpOverride`) in both modes, so the
 *     suite never reaches CoinGecko. The skill's allowlist and address
 *     checks still run against what the stand-in answers.
 *   - Record mode points the cogmo-skills coding repo at the throwaway
 *     GitHub repo `COGMO_TEST_SKILLS_REMOTE` names. `beforeAll`
 *     force-resets its main to an empty commit and register mirror-pushes
 *     the new skill onto it; `afterAll` closes the PR and deletes the test
 *     branches and `refs/cogmo-wip/` refs. Replay uses a local bare remote
 *     and a stub Octokit (`makeStubOctokitFactory`).
 *   - Replay's git history is the record run's: the pushed branch and its
 *     ancestry, which the record run bundles into `HISTORY_BUNDLE_PATH`.
 *     The remote and the skills repo start at the recorded `main`, and the
 *     replayed sandbox push lands the recorded tip (`landRecordedPush`), so
 *     the skills repo's pre-submit dry-runs the commit the sandbox pushed.
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
 *      repo even though branches stay in the orphan namespace. Set
 *      `COGMO_DEVBASE_IMAGE` and `COGMO_SKILLS_IMAGE` to tags naming the
 *      tree (`…:rec-<sha>`): `beforeAll` builds both snapshots from this
 *      tree's Dockerfiles under those names, and reuses an active snapshot
 *      a name already has.
 *   2. `gh auth status` — the PAT comes from gh CLI's keyring. Scope
 *      requirements: `repo` (push branches, open + close PRs).
 *   3. Delete `test/fixtures/recorded/suites/skill-authoring/`: llmock
 *      records only misses, and a new sandbox run changes the host's turns.
 *   4. `RECORD=1 pnpm test:integration src/test/skill-authoring.integration.test.ts`
 *      writes the Daytona cassette, the history bundle and the llmock misses.
 *   5. Re-run without `RECORD=1` to confirm replay is byte-stable.
 *   6. Commit the refreshed fixtures: the cassette, the bundle and the
 *      llmock recordings under `test/fixtures/recorded/`.
 *
 * The first record run is expected to surface adjustments to the
 * scaffold (timeouts, polling cadence, assertion shapes) — that's the
 * intended feedback loop. Each iteration costs ~$1-2 in Daytona
 * compute + Anthropic tokens.
 *
 * ## When the cassette needs a refresh
 *
 *   - Anthropic / OpenAI SDK bump that changes the wire shape.
 *   - `@daytona/sdk` bump that adds calls or renames endpoints.
 *   - Prompt restructure (system prompt, tool definitions, skill
 *     conventions) that the model's response would differ on.
 *   - Pinned model swap (currently `claude-haiku-4-5-20251001`).
 *   - The cogmo-skills repo's `SKILL.md` template or skill.py shape
 *     changes.
 *   - The release's skills-repo toolchain changes (`images/skills/toolchain/`,
 *     `images/skills/src/cogmo_ctx/`): replay's boot commits it over the
 *     recorded `main`, and `beforeAll` fails naming both shas.
 */

import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Daytona, Image } from "@daytona/sdk";
import { Octokit } from "@octokit/rest";
import { and, desc, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { connect } from "inngest/connect";
import { ok } from "neverthrow";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { codingTasks } from "../agent/coding/store/schema.js";
import { conversations, llmProviders, modelProviders, profiles } from "../agent/store/schema.js";
import * as schema from "../db/schemas.js";
import { type BootstrapOptions, bootstrap } from "../index.js";
import { directOutbound } from "../inngest/events.js";
import { AnthropicProvider } from "../llm/anthropic.js";
import { DaytonaSandboxClient, snapshotNameFor } from "../sandbox/daytona/client.js";
import { deriveMasterKey, encrypt, parseMasterKey, toBase64 } from "../secrets/encryption.js";
import { withGitAskpass } from "../secrets/git-askpass.js";
import { secrets } from "../secrets/store/schema.js";
import { getMainSha, runGitIn } from "../skills/git-ops.js";
import { bootstrapSkillsRepo } from "../skills/repo.js";
import { skillRuns, skills } from "../skills/store/schema.js";
import { channelSessions, channels, inboundMessages } from "../transport/store/schema.js";
import { expectDefined } from "./assertions.js";
import { printBakeTarget, withArgDefaults } from "./bake.js";
import { CASSETTE_CHAT_MODEL, pinOrgProfileToCassetteModel } from "./cassette-model.js";
import { DaytonaMock, type DaytonaMockOptions } from "./daytona-mock.js";
import { fileDatabaseUrl, fileDefaultUserId, fileLlmockUrl } from "./integration-file.js";
import { workerInngestBaseUrl } from "./worker-inngest.js";

const execFileP = promisify(execFileCb);

// --- Mode gating ─────────────────────────────────────────────────────

const SCENARIO = "skill-authoring";
const FIXTURE_DIR = "./test/fixtures/daytona";
const FIXTURE_PATH = `${FIXTURE_DIR}/${SCENARIO}.json`;
// The history the record run's dry run judged, as a git bundle: `main`, and
// the pushed tip under `RECORDED_TIP_REF`. Refresh together with the cassette.
const HISTORY_BUNDLE_PATH = "./test/fixtures/skill-authoring-history.bundle";
/** Outside `refs/heads/`, so no fetch of a branch names it. */
const RECORDED_TIP_REF = "refs/recorded/tip";
/**
 * The commit author cogmo writes in both modes (`commit-push.ts` composes it
 * from the identity's `login` and `id`). A stand-in, so a recording carries no
 * account's name or noreply address; the PAT alone authenticates the pushes.
 */
const COMMIT_AUTHOR = { login: "test-user", id: "0" } as const;
const IS_RECORD = process.env.RECORD === "1";
const HAS_RECORDING_INPUTS =
  !!process.env.DAYTONA_API_KEY &&
  !!process.env.ANTHROPIC_API_KEY &&
  !!process.env.COGMO_TEST_SKILLS_REMOTE;
const RECORDABLE = IS_RECORD && HAS_RECORDING_INPUTS;
const FIXTURE_EXISTS = existsSync(FIXTURE_PATH);
const RUNNABLE = RECORDABLE || FIXTURE_EXISTS;

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
  /** Tmp path for the replay-mode local bare remote; removed in afterAll. */
  let bareRemotePath: string | undefined;
  /** The history replay is built from; unset in record mode, which writes it. */
  let recorded: RecordedHistory | undefined;
  /** The bare skills repo `bootstrap()` registers and register reads. */
  let skillsPath: string;

  beforeAll(async () => {
    inngestBaseUrl = workerInngestBaseUrl();
    const databaseUrl = fileDatabaseUrl();
    defaultUserId = fileDefaultUserId();
    db = drizzle({ connection: databaseUrl, schema });

    console.log(`[skill-authoring e2e] TEST_RUN_ID=${TEST_RUN_ID}`);

    // Record → real GitHub. Replay → a local bare repo (file://) built from
    // the recorded history.
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
      remoteUrl = expectDefined(process.env.COGMO_TEST_SKILLS_REMOTE);
      remoteSlug = parseGitHubSlug(remoteUrl);
      await resetRemoteMain(remoteUrl, await readGhPat());
    } else {
      const bare = await createBareRemoteFromHistory();
      remoteUrl = bare.url;
      bareRemotePath = bare.path;
      recorded = bare.recorded;
      remoteSlug = "replay/local";
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
      : {
          mode: "replay",
          fixturePath: FIXTURE_PATH,
          onExec: landRecordedPush(expectDefined(bareRemotePath), expectDefined(recorded).tip),
        };
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

    // Replay doesn't talk to real GitHub — file:// remote needs no PAT
    // and the octokit stub ignores the token. Record-mode surfaces gh
    // failures (missing OR unauthenticated) so the operator notices.
    const pat = RECORDABLE ? await readGhPat() : "test-pat";
    const signingKeypair = await generateSigningKeypair();

    // Init the bare skills repo + wire origin BEFORE `bootstrap()` so
    // `ensureSkillsCodingRepo` reads the right `origin` for the row.
    skillsPath = expectDefined(
      process.env.COGMO_SKILLS_PATH,
      "COGMO_SKILLS_PATH not set by integration setup",
    );
    await bootstrapSkillsRepo({ path: skillsPath });
    await setOriginAndFetch(skillsPath, remoteUrl, pat);

    await seedSecretsAndProvider({
      db,
      anthropicApiKey: RECORDABLE ? expectDefined(process.env.ANTHROPIC_API_KEY) : "test-key",
      llmockUrl: fileLlmockUrl(),
      identity: {
        pat,
        sshPrivateKey: signingKeypair.privateKey,
        sshPublicKey: signingKeypair.publicKey,
        ...COMMIT_AUTHOR,
      },
    });

    // 6. LLM provider override for the host's agent loop. llmock records the
    // host's missing chat turns whenever `RECORD=1`, so it needs the key even
    // when the Daytona cassette replays.
    const anthropicKey = IS_RECORD ? expectDefined(process.env.ANTHROPIC_API_KEY) : "test-key";
    const provider = new AnthropicProvider(anthropicKey, fileLlmockUrl());

    // Auto-approve plans so the orchestrator drives plan -> execute
    // -> commit -> PR without a manual gate.
    await db
      .update(profiles)
      .set({ codingAutoapproveMode: "on" })
      .where(eq(profiles.userId, defaultUserId));

    bootstrapResult = await bootstrap({
      providerOverride: provider,
      sandboxClientOverride: daytonaClient,
      // Both modes: the cassette covers the chat and the sandbox, not the
      // skill's own request, so a live CoinGecko would make the run depend
      // on its uptime and rate limits in replay and record alike.
      skillCtxHttpOverride: makeStubSkillNetwork(),
      codingAuthOverride: async () =>
        // Pinned model + disabled thinking match `claude-cli.integration.test.ts`
        // and keep the recorded stream-json output stable across runs.
        ok({
          ANTHROPIC_API_KEY: anthropicKey,
          ANTHROPIC_MODEL: "claude-haiku-4-5-20251001",
          MAX_THINKING_TOKENS: "0",
        }),
      // Replay-only: stub the GitHub bits the cassette can't reach. The git
      // bits need no stub: the bare remote holds the recorded history, so
      // every host-side fetch, the dry run's and the register's included,
      // runs its production path.
      ...(!RECORDABLE && { octokitFactory: makeStubOctokitFactory() }),
    });

    // The dry run needs `main` to be an ancestor of the recorded tip. A boot
    // on the recorded `main` leaves it there while the release's toolchain is
    // the recording's; a changed one is committed on top.
    if (recorded) {
      const main = await getMainSha(skillsPath);
      if (main !== recorded.main) {
        throw new Error(
          `the boot moved the skills repo's main from the recorded ${recorded.main} to ${main}: the release's toolchain differs from the recording's, so re-record`,
        );
      }
    }

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
      for (const { adapter } of bootstrapResult.adapters) await adapter.stop();
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
    // Best-effort: removing the bare-remote tmpdir is housekeeping;
    // an ENOENT on a half-built path shouldn't fail the suite.
    if (bareRemotePath) {
      await rm(bareRemotePath, { recursive: true, force: true }).catch(() => undefined);
    }
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
    const { conversationId, sessionId } = await seedConversation(
      db,
      defaultUserId,
      bootstrapResult.profile.id,
    );
    await sendInbound(
      db,
      sessionId,
      conversationId,
      "Create a skill called btc-spot that fetches the current bitcoin USD price " +
        "from coingecko (https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd) " +
        "and returns { price: <number> }. Fetch it with `await ctx.http.get(url)`, which " +
        "returns a dict with 'status' and 'body' — parse the body with json.loads. Do NOT " +
        "use urllib or any third-party HTTP library, do NOT declare dependencies in " +
        "SKILL.md, do NOT create a requirements.lock file.",
    );
    await sendEvent(inngestBaseUrl, "inbound/arrived", {
      conversationId,
      inboundMessageId: await latestInboundId(db, conversationId),
    });

    // Record runs span the real Daytona round-trip; replay should
    // reach terminal status in <1m or it's silently stuck.
    const taskTimeoutMs = RECORDABLE ? 30 * 60_000 : 60_000;
    const task = await waitForCodingTask(db, conversationId, taskTimeoutMs);
    // Track for cleanup before any assertion, so a failed record run still
    // closes its PR. Branch name = `cogmo/run/<task-id>` (see `runBranchFor`).
    createdBranches.push(`cogmo/run/${task.id}`);
    if (task.prMetadata) createdPrNumbers.push(task.prMetadata.number);
    if (task.status !== "pr_open") {
      console.error(
        `[skill-authoring e2e] task ended in ${task.status} — failureReason="${task.failureReason}"`,
      );
    }
    expect(task.status).toBe("pr_open");
    // The dry run passed the pushed tip on the first verify run. Replay lands
    // one recorded push, so a recording that took a fix pass fails here.
    expect(task.presubmitVerdict).toMatchObject({ kind: "passed", fixPass: 0 });
    const judged = expectDefined(task.presubmitVerdict?.sha, "the judged tip");
    if (RECORDABLE) {
      // The branch was cut at `baseSha`, the skills repo's `main` when the
      // dry run read it: nothing advances `main` between the boot and the PR.
      const main = expectDefined(task.worktreeAssignment?.baseSha, "the task's base");
      await writeRecordedHistory(skillsPath, { main, tip: judged });
    } else {
      expect(judged).toBe(expectDefined(recorded).tip);
    }

    // Skill registered. It is stdlib-only, so `lockfileHash` is null;
    // `runner.sysbox.integration.test.ts` covers a skill with a lockfile.
    const skillRow = await waitForSkill(db, "btc-spot", 60_000);
    expect(skillRow.name).toBe("btc-spot");

    // --- Turn 2: invoke the new skill -------------------------------
    // Names the skill: the turn tests that the new tool is offered and runs,
    // not which of it and `web_answer` the model prefers for a price.
    await sendInbound(db, sessionId, conversationId, "What's bitcoin at? Use the btc-spot skill.");
    await sendEvent(inngestBaseUrl, "inbound/arrived", {
      conversationId,
      inboundMessageId: await latestInboundId(db, conversationId),
    });

    // Assert on the skill's own run, not on the reply text. The prose the
    // model writes is a weak proxy — it can produce a plausible number
    // from any source, which is how this test passed for months while the
    // skill itself was erroring and the agent quietly fell back to
    // `web_answer`. A completed run whose output carries a numeric price
    // is the thing the suite exists to prove.
    const run = await waitForSkillRun(db, skillRow.id, 60_000);
    expect(run.status).toBe("success");
    // Only the stand-in network answers with this exact figure, so a match
    // proves the skill's request never left the test process.
    const price = (run.output as { price?: unknown } | null)?.price;
    expect(price).toBe(STUB_BTC_USD);

    // And the number reaches the user. Anchored on tens-of-thousands shape
    // so years / HTTP codes don't false-positive.
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

/** The history the record run's dry run judged: `main` as it read it, and the tip. */
interface RecordedHistory {
  main: string;
  tip: string;
}

/**
 * Record mode: bundle the judged history into `HISTORY_BUNDLE_PATH`. The
 * scratch repo borrows the skills repo's objects, which hold the tip once the
 * dry run has fetched it, so no ref of the skills repo moves.
 */
async function writeRecordedHistory(skillsPath: string, history: RecordedHistory): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "skill-auth-history-"));
  try {
    await execFileP("git", ["init", "--bare", scratch]);
    await writeFile(
      join(scratch, "objects", "info", "alternates"),
      `${resolve(skillsPath, "objects")}\n`,
    );
    await runGitIn(scratch, ["update-ref", "refs/heads/main", history.main]);
    await runGitIn(scratch, ["update-ref", RECORDED_TIP_REF, history.tip]);
    await runGitIn(scratch, [
      "bundle",
      "create",
      resolve(HISTORY_BUNDLE_PATH),
      "refs/heads/main",
      RECORDED_TIP_REF,
    ]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Replay-mode remote: a bare repo on disk holding the recorded history, with
 * `main` at the recorded `main`, which `setOriginAndFetch` gives the skills
 * repo, and the tip's objects under `RECORDED_TIP_REF`.
 */
async function createBareRemoteFromHistory(): Promise<{
  url: string;
  path: string;
  recorded: RecordedHistory;
}> {
  if (!existsSync(HISTORY_BUNDLE_PATH)) {
    throw new Error(`${HISTORY_BUNDLE_PATH} is missing: a record run writes it with the cassette`);
  }
  const bareDir = await mkdtemp(join(tmpdir(), "skill-auth-replay-remote-"));
  try {
    await execFileP("git", ["init", "--bare", "--initial-branch=main", bareDir]);
    await runGitIn(bareDir, ["fetch", resolve(HISTORY_BUNDLE_PATH), "+refs/*:refs/*"]);
    const at = async (ref: string) => (await runGitIn(bareDir, ["rev-parse", ref])).trim();
    const recorded = { main: await at("refs/heads/main"), tip: await at(RECORDED_TIP_REF) };
    return { url: `file://${bareDir}`, path: bareDir, recorded };
  } catch (err) {
    // Partial failure between mkdtemp and successful return: caller
    // doesn't have `bareDir` to clean up. Drop it here, then rethrow.
    await rm(bareDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Replay's stand-in for the sandbox's push of the task branch, which the
 * cassette swallows: a replayed `git push origin <branch>` lands the recorded
 * tip on `<branch>` in the bare remote, as the record run's push did, before
 * the dry run fetches it. The execute run's push of the run branch
 * (`HEAD:refs/heads/cogmo/run/…`) is left alone: no host-side step reads it
 * back. Any other push throws, naming the command, rather than landing nothing.
 */
function landRecordedPush(remotePath: string, tip: string): (command: string) => Promise<void> {
  return async (command) => {
    if (!command.includes("'push'")) return;
    const refspec = /'push' 'origin' '([^']+)'$/.exec(command)?.[1];
    if (refspec?.startsWith("HEAD:refs/heads/cogmo/run/")) return;
    if (refspec === undefined || refspec.includes(":")) {
      throw new Error(`landRecordedPush: a push it does not replay: ${command}`);
    }
    await runGitIn(remotePath, ["update-ref", `refs/heads/${refspec}`, tip]);
  };
}

/** The one endpoint the stand-in network serves. */
const COINGECKO_PRICE_URL = "https://api.coingecko.com/api/v3/simple/price";
/**
 * BTC/USD as the stand-in network reports it — the figure in the recorded
 * turn-2 reply, so the skill's output and the replayed prose agree.
 */
const STUB_BTC_USD = 64725;

/**
 * Stand-in network for the authored skill's `ctx.http`: one host that
 * resolves to a public address and answers GET on one endpoint. Any other
 * host, path or method fails the way a missing host or an unreachable server
 * would, which surfaces in the skill run's `error` rather than as a silent
 * live request. The query is deliberately not matched — a re-recorded skill
 * may add harmless parameters, and one that asks for another coin fails on
 * the missing key anyway.
 */
function makeStubSkillNetwork(): NonNullable<BootstrapOptions["skillCtxHttpOverride"]> {
  return {
    resolveHost: async (hostname) => {
      if (hostname !== new URL(COINGECKO_PRICE_URL).hostname) {
        throw new Error(`stand-in network has no DNS entry for ${hostname}`);
      }
      return [{ address: "104.18.32.7", family: 4 }];
    },
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      // As in `fetch` itself, `init.method` wins over the Request's own.
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method !== "GET" || `${url.origin}${url.pathname}` !== COINGECKO_PRICE_URL) {
        throw new Error(`stand-in network has no route for ${method} ${url.origin}${url.pathname}`);
      }
      return new Response(JSON.stringify({ bitcoin: { usd: STUB_BTC_USD } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

/**
 * Real Octokit + stub fetch — synthesizes the GitHub calls replay can't reach.
 * The PR's head branch is already on the bare remote, where
 * `landRecordedPush` put it at the sandbox's push.
 */
function makeStubOctokitFactory(): (pat: string) => Octokit {
  const stubFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const pullsMatch = url.match(/\/repos\/([^/]+)\/([^/]+)\/pulls$/);
    if (method === "POST" && pullsMatch) {
      const [, owner, repo] = pullsMatch;
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const body = bodyText ? (JSON.parse(bodyText) as { head?: string }) : {};
      return new Response(
        JSON.stringify({
          number: 1,
          html_url: `https://github.example/${owner}/${repo}/pull/1`,
          head: { sha: "0".repeat(40), ref: body.head ?? "" },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    // The cleanup-run-branch subscriber DELETEs the per-task branch
    // after the task reaches a terminal state. Accept either form of
    // ref encoding (heads%2F<branch> or heads/<branch>) so an Octokit
    // bump that flips URL-templating doesn't silently 503 us.
    if (method === "DELETE" && /\/repos\/[^/]+\/[^/]+\/git\/refs\/(heads%2F|heads\/)/.test(url)) {
      return new Response(null, { status: 204 });
    }
    // Fail loud: a 503 here would surface as a generic Octokit retry
    // exhaustion several layers from the missing handler. Throwing
    // puts the unsupported call directly in the test stack trace.
    // Extend this stub (above) when adding new GitHub touchpoints.
    throw new Error(`stub octokit: unsupported ${method} ${url}`);
  };
  return (pat: string) => new Octokit({ auth: pat, request: { fetch: stubFetch } });
}

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
  const apiKey = expectDefined(process.env.DAYTONA_API_KEY);
  const realSdk = new Daytona({
    apiKey,
    apiUrl: process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api",
    ...(process.env.DAYTONA_ORGANIZATION_ID && {
      organizationId: process.env.DAYTONA_ORGANIZATION_ID,
    }),
  });

  // 1a. Devbase snapshot.
  const devbase = await bakedDevbaseImage();
  await ensureSnapshot(realSdk, "devbase", snapshotName, () => devbase);

  // 1b. cogmo-skills snapshot, built from this tree's skills image as
  // devbase's is: register's check session runs this commit's
  // `cogmo_skills_runtime.check` and tools venv, which no published image
  // carries yet. A tag naming the tree keeps an older active snapshot of the
  // same name from standing in for it.
  const skillsImageRef = expectDefined(
    process.env.COGMO_SKILLS_IMAGE,
    "COGMO_SKILLS_IMAGE must be set in record mode (snapshot name + cogmo override key — registry doesn't need to exist)",
  );
  const skillsSnapshotName = expectDefined(
    snapshotNameFor(skillsImageRef),
    `snapshotNameFor(${skillsImageRef}) returned null — COGMO_SKILLS_IMAGE must include a non-latest tag`,
  );
  const skills = await bakedSkillsImage();
  await ensureSnapshot(realSdk, "cogmo-skills", skillsSnapshotName, () => skills);

  // 2. Deps-cache volume — get-or-create then poll until ready. Register's
  // lockfile-compile sandbox attaches this volume; if it's still in
  // `pending_create` when the sandbox boots, register fails with
  // `requirements_lock_transport_failed`.
  console.log(`[skill-authoring e2e] ensuring deps-cache volume ${depsVolumeName} is ready...`);
  await realSdk.volume.get(depsVolumeName, true);
  await vi.waitFor(
    async () => {
      const v = await realSdk.volume.get(depsVolumeName);
      if (v.state !== "ready") {
        throw new Error(`deps-cache volume ${depsVolumeName} state=${v.state}`);
      }
    },
    { timeout: 120_000, interval: 2000 },
  );
  console.log(`[skill-authoring e2e] deps-cache volume ${depsVolumeName} ready`);
}

/**
 * The devbase image as Daytona should build it. Daytona builds the Dockerfile
 * it is handed with no build args, and the toolchain versions exist only in
 * docker-bake.hcl, so they are written in as ARG defaults first.
 * `fromDockerfile` reads the file on the spot, and devbase COPYs nothing from
 * its context, so the temp directory can go straight after.
 */
async function bakedDevbaseImage(): Promise<Image> {
  const devbase = await printBakeTarget("devbase");
  const dir = await mkdtemp(join(tmpdir(), "cogmo-devbase-"));
  try {
    const dockerfile = join(dir, "Dockerfile");
    await writeFile(
      dockerfile,
      withArgDefaults(await readFile(devbase.dockerfilePath, "utf8"), devbase.args),
    );
    return Image.fromDockerfile(dockerfile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The skills image as Daytona should build it, with bake's args written in as
 * ARG defaults like devbase's. Its Dockerfile COPYs from `images/skills/`, and
 * `fromDockerfile` takes the context from the Dockerfile's own directory, so
 * the rendered file sits there until `fromDockerfile` has read it and listed
 * the context it uploads at `snapshot.create`.
 */
async function bakedSkillsImage(): Promise<Image> {
  const skills = await printBakeTarget("skills");
  const rendered = join(dirname(skills.dockerfilePath), `.Dockerfile.daytona-${process.pid}`);
  await writeFile(
    rendered,
    withArgDefaults(await readFile(skills.dockerfilePath, "utf8"), skills.args),
  );
  try {
    return Image.fromDockerfile(rendered);
  } finally {
    await rm(rendered, { force: true });
  }
}

async function readGhPat(): Promise<string> {
  const { stdout } = await execFileP("gh", ["auth", "token"]);
  const pat = stdout.trim();
  if (!pat) throw new Error("`gh auth token` returned empty — run `gh auth login` first");
  return pat;
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

    // Route the cassette's model, so the host agent loop replays against
    // the recorded fixtures.
    await pinOrgProfileToCassetteModel(tx);
    await tx
      .insert(modelProviders)
      .values({
        model: CASSETTE_CHAT_MODEL,
        providerId: provider.id,
        position: 0,
        userSelectable: true,
      })
      .onConflictDoNothing();
  });
}

/**
 * `profileId` is the org profile `bootstrap()` resolves as the default, not an
 * unordered pick of a `profiles` row.
 */
async function seedConversation(
  db: ReturnType<typeof drizzle<typeof schema>>,
  userId: string,
  profileId: string,
): Promise<{ conversationId: string; sessionId: string }> {
  const channelRows = await db.select({ id: channels.id }).from(channels).limit(1);
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
  return vi.waitFor(
    async () => {
      const rows = await db
        .select()
        .from(codingTasks)
        .where(
          and(eq(codingTasks.conversationId, conversationId), ne(codingTasks.status, "queued")),
        )
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
      if (!terminal) {
        throw new Error(`coding task not terminal yet; last status: ${lastSeenStatus}`);
      }
      return terminal;
    },
    { timeout: timeoutMs, interval: 1000 },
  );
}

async function waitForSkill(
  db: ReturnType<typeof drizzle<typeof schema>>,
  name: string,
  timeoutMs: number,
): Promise<typeof skills.$inferSelect> {
  return vi.waitFor(
    async () => {
      const rows = await db.select().from(skills).where(eq(skills.name, name)).limit(1);
      const row = rows[0];
      if (!row) throw new Error(`skill '${name}' not yet registered`);
      return row;
    },
    { timeout: timeoutMs, interval: 500 },
  );
}

/** Newest run for the skill, once it has left `running`. */
async function waitForSkillRun(
  db: ReturnType<typeof drizzle<typeof schema>>,
  skillId: string,
  timeoutMs: number,
): Promise<typeof skillRuns.$inferSelect> {
  return vi.waitFor(
    async () => {
      const rows = await db
        .select()
        .from(skillRuns)
        .where(and(eq(skillRuns.skillId, skillId), ne(skillRuns.status, "running")))
        .orderBy(desc(skillRuns.createdAt))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error(`no finished skill_runs row for skill ${skillId}`);
      return row;
    },
    { timeout: timeoutMs, interval: 500 },
  );
}

async function waitForOutbound(
  predicate: (e: CapturedOutbound) => boolean,
  timeoutMs: number,
): Promise<CapturedOutbound> {
  return vi.waitFor(
    () => {
      const match = capturedOutbound.find(predicate);
      if (!match) throw new Error("no matching directOutbound event yet");
      return match;
    },
    { timeout: timeoutMs, interval: 200 },
  );
}
