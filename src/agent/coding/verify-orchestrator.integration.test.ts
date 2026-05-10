/**
 * Integration test for `runCodingVerify` (slice 4.0h orchestrator).
 *
 * Layered approach (chosen over real-GitHub-account testing — see
 * slice4-plan.md decision in 4.0i):
 * - **Real `git push`** against a Gitea container started via testcontainers.
 *   Exercises the full git-over-HTTPS auth path: askpass helper → PAT →
 *   Gitea accepting the new branch.
 * - **Scoped fetch interceptor** for octokit (mirroring `src/test/fal-mock.ts`
 *   — no global `globalThis.fetch` patching, so other SDKs stay untouched).
 *   Captures the `pulls.create` payload, returns a canned response, returns
 *   503 for any unexpected URL.
 * - **PGlite** for the coding store — keeps the test self-contained without
 *   the integration tier's full Postgres boot.
 * - **Fake sandbox** that spawns real `git` / `bash` on the host with the
 *   askpass dir provisioned at the same path inside and outside the
 *   "container" (no path translation needed).
 *
 * Asserts:
 *   (a) Happy path — verify passes → branch pushed to Gitea → PR opened →
 *       status reaches `pr_open`, `pr_metadata` populated.
 *   (c) Cleanup — branch is deleted from Gitea after the assert (kept the
 *       fixture repo idempotent across re-runs).
 *   (d) Failure path — failing verify command surfaces `status=failed`,
 *       no branch is pushed.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import type { Octokit } from "@octokit/rest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transactor } from "../../db/index.js";
import type { StepRun } from "../../inngest/index.js";
import {
  type ExecStreamingHandle,
  type LocalDockerSessionState,
  LocalDockerSessionStateSchema,
  type SandboxClient,
  type SandboxSession,
  type SessionSpec,
} from "../../sandbox/index.js";
import {
  type GitHubIdentity,
  gitHubIdentitySecretName,
  serializeGitHubIdentity,
} from "../../secrets/github.js";
import { generateSshKeyPair } from "../../secrets/ssh-keygen.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { FakeDaytonaSandboxClient } from "../../test/daytona-sandbox-fake.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { type CodingBackend, DrizzleCodingStore } from "./store/index.js";
import { runCodingVerify, type VerifyOrchestratorDeps } from "./verify-orchestrator.js";

const execFileP = promisify(execFile);

const stepRun = ((_: string, fn: () => Promise<unknown>) => fn()) as any as StepRun;

// --- Gitea bootstrap ─────────────────────────────────────────────────

const GITEA_USER = "cogmo-test";
const GITEA_PASSWORD = "Cogmo-Test-Password-1234567890";
const GITEA_REPO = "fixture";
const GITEA_DEFAULT_BRANCH = "main";

let gitea: StartedTestContainer;
let giteaUrl: string;
let giteaPat: string;

async function startGitea(): Promise<{ url: string; pat: string }> {
  // Mirrors `dev/containers.ts → gitea(...)`. `INSTALL_LOCK=true` is the
  // only knob required to skip Gitea's web installer; SQLite + Gitea's
  // default paths (under `/data/gitea/`) keep this single-container.
  // Pull from Gitea's own registry rather than Docker Hub — keeps CI off
  // the Docker Hub rate-limit budget that pgvector + inngest still spend.
  const container = await new GenericContainer("docker.gitea.com/gitea:1.22")
    .withExposedPorts(3000)
    .withEnvironment({
      GITEA__security__INSTALL_LOCK: "true",
    })
    .withWaitStrategy(Wait.forHttp("/api/v1/version", 3000))
    .withStartupTimeout(180_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(3000);
  const url = `http://${host}:${port}`;

  // Create the admin user via Gitea CLI inside the container.
  await container.exec([
    "su",
    "git",
    "-c",
    `gitea admin user create --username ${GITEA_USER} --password ${GITEA_PASSWORD} --email ${GITEA_USER}@example.com --admin --must-change-password=false`,
  ]);

  // Generate an access token via the REST endpoint (basic auth using the
  // newly-created user). Scopes cover everything Cogmo needs in this test:
  // create repo, push to repo, open PR.
  const tokenResp = await fetch(`${url}/api/v1/users/${GITEA_USER}/tokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${GITEA_USER}:${GITEA_PASSWORD}`).toString("base64")}`,
    },
    body: JSON.stringify({
      name: `cogmo-test-${Date.now()}`,
      scopes: ["write:repository", "write:user"],
    }),
  });
  if (!tokenResp.ok) {
    throw new Error(`gitea token creation failed: ${tokenResp.status} ${await tokenResp.text()}`);
  }
  const tokenJson = (await tokenResp.json()) as { sha1: string };
  const pat = tokenJson.sha1;

  // Create the fixture repo.
  const repoResp = await fetch(`${url}/api/v1/user/repos`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `token ${pat}`,
    },
    body: JSON.stringify({
      name: GITEA_REPO,
      auto_init: true,
      default_branch: GITEA_DEFAULT_BRANCH,
      private: false,
    }),
  });
  if (!repoResp.ok) {
    throw new Error(`gitea repo creation failed: ${repoResp.status} ${await repoResp.text()}`);
  }

  gitea = container;
  return { url, pat };
}

// --- Octokit scoped fetch ────────────────────────────────────────────

interface CapturedPullsCreate {
  body: Record<string, unknown>;
  headers: Headers;
}

function makeOctokitFactory(opts: {
  capture: CapturedPullsCreate[];
  /** When set, the mock returns this status + JSON instead of a 201 success. */
  fail?: { status: number; message: string };
}): (pat: string) => Octokit {
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/repos/") || !url.endsWith("/pulls")) {
      // Strict — anything we didn't anticipate must be a misconfiguration.
      return new Response(`scoped octokit fetch: unexpected url ${url}`, { status: 503 });
    }

    const headers = new Headers(init?.headers);
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    opts.capture.push({ body, headers });

    if (opts.fail) {
      return new Response(JSON.stringify({ message: opts.fail.message }), {
        status: opts.fail.status,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        html_url: `https://github.example/owner/repo/pull/1`,
        number: 1,
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  };

  return (pat: string) =>
    ({
      pulls: {
        create: async (params: Record<string, unknown>) => {
          const url = `https://api.github.com/repos/${params.owner}/${params.repo}/pulls`;
          const resp = await fetchImpl(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${pat}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(params),
          });
          if (resp.status >= 400) {
            const body = await resp.json();
            throw Object.assign(new Error((body as { message: string }).message), {
              status: resp.status,
              // Mark as RequestError-shaped so `error instanceof RequestError`
              // checks in `runOpenDraftPr` recognise it; we don't actually
              // import the constructor here to keep this fixture loose.
              name: "HttpError",
            });
          }
          return { data: await resp.json() };
        },
      },
    }) as unknown as Octokit;
}

// --- Fake sandbox that spawns on host ────────────────────────────────

const HOST_ASKPASS_BASE = mkdtempSync(join(tmpdir(), "cogmo-int-askpass-"));

/**
 * Fake `Sandbox` whose `exec` runs commands on the host. The askpass mount
 * is reflected as-is — we set `containerDir = hostDir` in `provisionAskpass`'s
 * input so the orchestrator's env-thread code (`GIT_ASKPASS=<containerDir>/helper`)
 * resolves to a real host path that `git` can execute. Same trick keeps the
 * signing-key path valid.
 */
function fakeSandbox(opts: { worktreePath: string }): {
  sandbox: SandboxClient<LocalDockerSessionState>;
  createCalls: SessionSpec[];
  stopCalls: string[];
} {
  const createCalls: SessionSpec[] = [];
  const stopCalls: string[] = [];
  let lastSpec: SessionSpec | null = null;

  function rewrite(s: string, hostDir: string, containerDir: string): string {
    return s.split(containerDir).join(hostDir);
  }

  const handle = (spec: SessionSpec): SandboxSession<LocalDockerSessionState> => ({
    state: {
      type: "local-docker",
      taskId: spec.taskId,
      containerRowId: "fake-row",
      dockerId: `fake-docker-${spec.taskId}`,
    },
    exec: async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      wallTimeSeconds: 0,
      truncated: false,
    }),
    execStreaming: async (cmd, execOpts) => {
      const hostDir = spec.askpass?.hostDir;
      const containerDir = spec.askpass?.containerDir;
      const cwd =
        execOpts?.workingDir === "/workspace"
          ? opts.worktreePath
          : (execOpts?.workingDir ?? opts.worktreePath);

      const env: Record<string, string> = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      if (execOpts?.env) {
        for (const [k, v] of Object.entries(execOpts.env)) {
          env[k] = hostDir && containerDir ? rewrite(v, hostDir, containerDir) : v;
        }
      }
      const args =
        hostDir && containerDir ? cmd.map((a) => rewrite(a, hostDir, containerDir)) : [...cmd];

      const { stdout, stderr, exitCode } = await execFileP(args[0] ?? "", args.slice(1), {
        cwd,
        env,
      }).then(
        (r) => ({ stdout: r.stdout, stderr: r.stderr, exitCode: 0 }),
        (err: NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string }) => ({
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? String(err),
          exitCode: typeof err.code === "number" ? err.code : 1,
        }),
      );

      const stdoutStream = streamFromBuffer(Buffer.from(stdout));
      const stderrStream = streamFromBuffer(Buffer.from(stderr));
      const result: ExecStreamingHandle = {
        stdout: stdoutStream,
        stderr: stderrStream,
        wait: async () => ({ exitCode }),
        dispose: async () => {},
      };
      return result;
    },
  });

  return {
    sandbox: {
      backendId: "fake",
      capabilities: {
        siblingContainers: "host-proxy",
        hostBindMount: true,
        customImage: true,
        volumes: "docker",
        workingTreeTransport: "bind-mount",
      },
      healthCheck: async () => ({ ok: true, runtime: "runc" }),
      reconcileCrashedInstances: async () => ({ orphansReaped: 0 }),
      ensureImagePresent: vi.fn(async () => {}),
      create: vi.fn(async (spec) => {
        createCalls.push(spec);
        lastSpec = spec;
        // The askpass helper script's body embeds the *container* path
        // (`/.cogmo-askpass/pat`). Host execution needs that to resolve to
        // the host path. Rewrite the helper file on disk so `cat` reads
        // the actual file. Same-shell-quoting kept by the rewrite — the
        // helper just contains the literal path under single quotes.
        if (spec.askpass) {
          const helperPath = `${spec.askpass.hostDir}/helper`;
          const original = readFileSync(helperPath, "utf8");
          const rewritten = original.split(spec.askpass.containerDir).join(spec.askpass.hostDir);
          writeFileSync(helperPath, rewritten, { mode: 0o700 });
        }
        return handle(spec);
      }),
      resume: vi.fn(async () => {
        if (!lastSpec) throw new Error("resume called before create");
        return handle(lastSpec);
      }),
      tryResumeByTaskId: vi.fn(async () => null),
      delete: vi.fn(async () => {}),
      deleteByTaskId: vi.fn(async (taskId) => {
        stopCalls.push(taskId);
      }),
      serializeState: (state) => LocalDockerSessionStateSchema.parse(state),
      deserializeState: (payload) => LocalDockerSessionStateSchema.parse(payload),
      shutdown: async () => {},
    },
    createCalls,
    stopCalls,
  };
}

function streamFromBuffer(buf: Buffer): Readable {
  return new Readable({
    read() {
      this.push(buf);
      this.push(null);
    },
  });
}

// --- Secrets store stub ──────────────────────────────────────────────

function makeFakeSecretsStore(): {
  secrets: SecretsStore;
  set: (name: string, value: string) => void;
} {
  const values = new Map<string, string>();
  const secrets = mock<SecretsStore>();
  secrets.getSecret.mockImplementation(async (_tx, name: string) => values.get(name));
  return {
    secrets,
    set: (name, value) => values.set(name, value),
  };
}

// --- Test setup ──────────────────────────────────────────────────────

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleCodingStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleCodingStore();
  ({ url: giteaUrl, pat: giteaPat } = await startGitea());
}, 120_000);

afterAll(async () => {
  await close();
  if (gitea) await gitea.stop();
  rmSync(HOST_ASKPASS_BASE, { recursive: true, force: true });
});

afterEach(async () => {
  await truncateAll(db);
});

// --- Helpers ─────────────────────────────────────────────────────────

let secretsStore: SecretsStore;
let setSecret: (name: string, value: string) => void;
let worktreePath: string;
let workspaceRoot: string;

beforeEach(async () => {
  ({ secrets: secretsStore, set: setSecret } = makeFakeSecretsStore());
  // Real Ed25519 keypair so `git commit -S` actually signs (the verify
  // orchestrator hard-codes `-c gpg.format=ssh -c user.signingkey=...`
  // and a placeholder string makes ssh-keygen fail with `couldn't load
  // signing key`). Identity bundle is otherwise a stub — the SSH side of
  // GitHub auth isn't exercised here (git push uses HTTPS + PAT via
  // askpass; signing is a separate ssh-keygen invocation that just needs
  // a real keyfile to read).
  const keys = generateSshKeyPair("cogmo-test@integration");
  const identity: GitHubIdentity = {
    pat: giteaPat,
    sshPrivateKey: keys.privateKey,
    sshPublicKey: keys.publicKey,
    login: GITEA_USER,
    id: "1",
  };
  setSecret(gitHubIdentitySecretName("default"), serializeGitHubIdentity(identity));
  // Subscription auth: orchestrator demands the OAuth token before
  // creating the container (see auth.ts → loadCodingSandboxEnv). Test
  // value is opaque to the verify path — the orchestrator only forwards
  // it as `CLAUDE_CODE_OAUTH_TOKEN` env, and verify never invokes
  // `claude -p` (it runs the repo's verify_command + git, not the CLI).
  setSecret("claude_code_oauth_token", "sk-test-claude-code-oauth-token");

  // Fresh worktree per test — clone the fixture repo from Gitea via the
  // configured PAT so origin is set correctly and HEAD points at the
  // initial commit.
  workspaceRoot = mkdtempSync(join(tmpdir(), "cogmo-int-wt-"));
  worktreePath = join(workspaceRoot, "fixture");

  // PAT-in-URL is fine for local clone setup — the orchestrator's actual
  // push goes through askpass with a clean URL.
  const cloneUrl = `${giteaUrl}/${GITEA_USER}/${GITEA_REPO}.git`.replace(
    "://",
    `://${GITEA_USER}:${giteaPat}@`,
  );
  await execFileP("git", ["clone", "--quiet", cloneUrl, worktreePath]);
  await execFileP("git", ["-C", worktreePath, "config", "user.email", "test@example.com"]);
  await execFileP("git", ["-C", worktreePath, "config", "user.name", "test"]);
  // Disable signing in the local repo's hooks; the orchestrator passes
  // `-c user.signingkey=...` per-invocation, which `git -c gpg.format=ssh`
  // tries to use. ssh-keygen may or may not be available; tolerate either.
  // (Tests below override the orchestrator's signing path via opts when needed.)

  // Set the remote URL Cogmo will see — bare, no creds. Askpass provides them.
  await execFileP("git", [
    "-C",
    worktreePath,
    "remote",
    "set-url",
    "origin",
    `${giteaUrl}/${GITEA_USER}/${GITEA_REPO}.git`,
  ]);
});

afterEach(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
});

async function seedTask(opts?: {
  remoteUrl?: string;
  verifyCommand?: string;
}): Promise<{ taskId: string; branch: string }> {
  const repoRow = await tx((trx) =>
    store.insertRepo(trx, {
      name: "fixture",
      localPath: worktreePath,
      defaultBranch: GITEA_DEFAULT_BRANCH,
      remoteUrl: opts?.remoteUrl ?? `${giteaUrl}/${GITEA_USER}/${GITEA_REPO}.git`,
      devcontainer: null,
      allowedBackends: ["claude"] as ReadonlyArray<CodingBackend>,
      verifyCommand: opts?.verifyCommand ?? "true",
      taskTokenBudget: 200_000,
      taskWallTimeSeconds: 1800,
      maxConcurrentTasks: 1,
      verifyTimeoutSeconds: 30,
    }),
  );

  const task = await tx((trx) =>
    store.insertTask(trx, {
      repoId: repoRow.id,
      goal: "integration test fixture goal",
      triggerSource: "user",
      backend: "claude",
      allowPrivilegedRunc: false,
    }),
  );

  // Branch derived from the first 8 chars of the task UUID — orchestrator
  // doesn't read this, just uses worktreeAssignment.branch directly.
  const branch = `cogmo/${task.id.slice(0, 8)}`;
  await execFileP("git", ["-C", worktreePath, "checkout", "-b", branch]);

  await tx((trx) =>
    store.setTaskWorktreeAssignment(trx, task.id, {
      type: "host-path",
      branch,
      worktreePath,
    }),
  );
  await tx((trx) => store.setTaskPlan(trx, task.id, "1. add a file\n2. verify"));
  await tx((trx) => store.updateTaskStatus(trx, { id: task.id, status: "pending_verify" }));

  return { taskId: task.id, branch };
}

function makeDeps(opts: {
  capture: CapturedPullsCreate[];
  failPr?: { status: number; message: string };
}): VerifyOrchestratorDeps {
  const { sandbox } = fakeSandbox({ worktreePath });
  return {
    runInTx: tx,
    store,
    sandbox,
    secretsStore,
    askpassBaseDir: HOST_ASKPASS_BASE,
    devbaseImage: "ignored",
    defaultResourceLimits: { cpus: 1, memory_bytes: 1 << 30, pids: 64 },
    taskTtlMs: 60_000,
    octokitFactory: makeOctokitFactory({
      capture: opts.capture,
      ...(opts.failPr && { fail: opts.failPr }),
    }),
  };
}

// --- Tests ───────────────────────────────────────────────────────────

describe("verify orchestrator integration — gitea + scoped octokit", () => {
  it("happy path: verify passes → branch pushed to gitea → PR opened, status pr_open", async () => {
    // Make a tracked change so the commit step has something to record.
    writeFileSync(join(worktreePath, "TASK.md"), "fixture change\n");
    await execFileP("git", ["-C", worktreePath, "add", "."]);

    const { taskId, branch } = await seedTask();
    const capture: CapturedPullsCreate[] = [];
    const deps = makeDeps({ capture });
    const inngestSend = vi.fn().mockResolvedValue(undefined);

    const result = await runCodingVerify({
      taskId,
      deps,
      stepRun,
      inngest: { send: inngestSend },
    });

    expect(result.status).toBe("pr_open");

    // Branch lives on Gitea — query via the API.
    const branchResp = await fetch(
      `${giteaUrl}/api/v1/repos/${GITEA_USER}/${GITEA_REPO}/branches/${encodeURIComponent(branch)}`,
      { headers: { Authorization: `token ${giteaPat}` } },
    );
    expect(branchResp.status).toBe(200);

    // Octokit POST happened with the right payload shape.
    expect(capture).toHaveLength(1);
    expect(capture[0]?.body).toMatchObject({
      owner: GITEA_USER,
      repo: GITEA_REPO,
      head: branch,
      base: GITEA_DEFAULT_BRANCH,
      draft: true,
    });
    expect(capture[0]?.body.title).toMatch(/integration test fixture goal/);

    // pr_metadata persisted with the canned mock URL + number.
    const reloaded = await tx((trx) => store.getTask(trx, taskId));
    expect(reloaded?.status).toBe("pr_open");
    expect(reloaded?.prMetadata).toMatchObject({
      url: "https://github.example/owner/repo/pull/1",
      number: 1,
    });

    // Cleanup — delete the branch upstream so re-runs don't pile up.
    await fetch(
      `${giteaUrl}/api/v1/repos/${GITEA_USER}/${GITEA_REPO}/branches/${encodeURIComponent(branch)}`,
      {
        method: "DELETE",
        headers: { Authorization: `token ${giteaPat}` },
      },
    );

    expect(inngestSend.mock.calls.map((c) => c[0].name)).toEqual([
      "coding/task/verify-complete",
      "coding/task/pushed",
      "coding/task/pr-opened",
    ]);
  }, 120_000);

  it("failure path: verify exit≠0 → status=failed, no branch pushed", async () => {
    const { taskId, branch } = await seedTask({ verifyCommand: "exit 7" });
    const capture: CapturedPullsCreate[] = [];
    const deps = makeDeps({ capture });
    const inngestSend = vi.fn().mockResolvedValue(undefined);

    const result = await runCodingVerify({
      taskId,
      deps,
      stepRun,
      inngest: { send: inngestSend },
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failureReason).toMatch(/verify failed \(exit 7\)/);
    }

    // Branch must NOT exist on Gitea.
    const branchResp = await fetch(
      `${giteaUrl}/api/v1/repos/${GITEA_USER}/${GITEA_REPO}/branches/${encodeURIComponent(branch)}`,
      { headers: { Authorization: `token ${giteaPat}` } },
    );
    expect(branchResp.status).toBe(404);

    // Octokit not called.
    expect(capture).toHaveLength(0);

    // verify-complete fired (with ok=false), pushed/pr-opened did not.
    const eventNames = inngestSend.mock.calls.map((c) => c[0].name);
    expect(eventNames).toContain("coding/task/verify-complete");
    expect(eventNames).not.toContain("coding/task/pushed");
    expect(eventNames).not.toContain("coding/task/pr-opened");
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────
// git-remote transport — uses FakeDaytonaSandboxClient against the same
// Gitea testcontainer. Exercises the orchestrator's git-remote arms:
// SDK-style clone from `cogmo/run/<task-id>`, post-create checkout, host-
// side commit + push, post-PR fetchFeatureBranch.

async function seedTaskGitRemote(): Promise<{ taskId: string; branch: string; runRef: string }> {
  const repoRow = await tx((trx) =>
    store.insertRepo(trx, {
      name: "fixture",
      localPath: worktreePath,
      defaultBranch: GITEA_DEFAULT_BRANCH,
      remoteUrl: `${giteaUrl}/${GITEA_USER}/${GITEA_REPO}.git`,
      devcontainer: null,
      allowedBackends: ["claude"] as ReadonlyArray<CodingBackend>,
      verifyCommand: "true",
      taskTokenBudget: 200_000,
      taskWallTimeSeconds: 1800,
      maxConcurrentTasks: 1,
      verifyTimeoutSeconds: 30,
    }),
  );

  const task = await tx((trx) =>
    store.insertTask(trx, {
      repoId: repoRow.id,
      goal: "git-remote integration fixture goal",
      triggerSource: "user",
      backend: "claude",
      allowPrivilegedRunc: false,
    }),
  );

  const branch = `cogmo/${task.id.slice(0, 8)}`;
  const runRef = `cogmo/run/${task.id}`;
  await tx((trx) => store.setTaskWorktreeAssignment(trx, task.id, { type: "git-remote", branch }));
  await tx((trx) => store.setTaskPlan(trx, task.id, "1. add a file\n2. verify"));
  await tx((trx) => store.updateTaskStatus(trx, { id: task.id, status: "pending_verify" }));

  return { taskId: task.id, branch, runRef };
}

async function pushRunBranchToGitea(runRef: string): Promise<void> {
  // Plan-orchestrator would have run `pushTaskBranchToRemote` in the
  // real flow; integration test simulates that pre-state directly so
  // verify-orchestrator can clone from it.
  const authedUrl = `${giteaUrl}/${GITEA_USER}/${GITEA_REPO}.git`.replace(
    "://",
    `://${GITEA_USER}:${giteaPat}@`,
  );
  await execFileP("git", ["-C", worktreePath, "push", authedUrl, `HEAD:refs/heads/${runRef}`]);
}

async function deleteGiteaBranch(branch: string): Promise<void> {
  await fetch(
    `${giteaUrl}/api/v1/repos/${GITEA_USER}/${GITEA_REPO}/branches/${encodeURIComponent(branch)}`,
    {
      method: "DELETE",
      headers: { Authorization: `token ${giteaPat}` },
    },
  );
}

describe("verify orchestrator integration — git-remote transport (fake daytona)", () => {
  let fakeBaseDir: string;
  let fakeSandboxClient: FakeDaytonaSandboxClient;
  // Branches that need cleanup on Gitea regardless of test outcome —
  // failed-early tests would otherwise leak `cogmo/<idShort>` and
  // `cogmo/run/<task-id>` refs across re-runs.
  let branchesToCleanup: string[];

  beforeEach(async () => {
    fakeBaseDir = mkdtempSync(join(tmpdir(), "cogmo-int-fake-base-"));
    fakeSandboxClient = await FakeDaytonaSandboxClient.create({
      baseDir: fakeBaseDir,
      instanceId: "test-instance",
    });
    branchesToCleanup = [];
  });

  afterEach(async () => {
    await fakeSandboxClient.shutdown();
    rmSync(fakeBaseDir, { recursive: true, force: true });
    // Best-effort upstream cleanup. Swallow per-branch failures so a
    // missing branch (already cleaned, never pushed) doesn't mask the
    // original test failure.
    for (const branch of branchesToCleanup) {
      await deleteGiteaBranch(branch).catch(() => {});
    }
  });

  it("happy path: sandbox clones run-branch, verify passes, feature branch pushed, PR opened, fetch back", async () => {
    // Pre-stage a change on the local mirror so the run-branch we push
    // upstream has something distinct from `main`. Keeps the assertion
    // about feature-branch divergence honest even though the orchestrator
    // itself doesn't write files.
    writeFileSync(join(worktreePath, "TASK.md"), "git-remote fixture\n");
    await execFileP("git", ["-C", worktreePath, "add", "."]);
    await execFileP("git", [
      "-C",
      worktreePath,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "wip change",
    ]);

    const { taskId, branch, runRef } = await seedTaskGitRemote();
    // Register both refs for afterEach cleanup before any operation
    // that might fail — guarantees we don't leak refs upstream when
    // the test errors mid-flight.
    branchesToCleanup.push(branch, runRef);
    await pushRunBranchToGitea(runRef);

    const capture: CapturedPullsCreate[] = [];
    const deps: VerifyOrchestratorDeps = {
      runInTx: tx,
      store,
      sandbox: fakeSandboxClient,
      secretsStore,
      askpassBaseDir: HOST_ASKPASS_BASE,
      devbaseImage: "ignored",
      defaultResourceLimits: { cpus: 1, memory_bytes: 1 << 30, pids: 64 },
      taskTtlMs: 60_000,
      octokitFactory: makeOctokitFactory({ capture }),
    };
    const inngestSend = vi.fn().mockResolvedValue(undefined);

    const result = await runCodingVerify({
      taskId,
      deps,
      stepRun,
      inngest: { send: inngestSend },
    });

    expect(result.status).toBe("pr_open");

    // The fake sandbox saw the orchestrator's git-remote spec — meaning
    // `buildWorktreeSpec` correctly branched on `workingTreeTransport`.
    expect(fakeSandboxClient.createCalls).toHaveLength(1);
    const spec = fakeSandboxClient.createCalls[0];
    if (!spec) throw new Error("expected one create call");
    expect(spec.worktree?.type).toBe("git-remote");
    if (spec.worktree?.type === "git-remote") {
      expect(spec.worktree.branch).toBe(runRef);
      expect(spec.worktree.url).toContain(`${GITEA_USER}/${GITEA_REPO}.git`);
    }

    // Feature branch landed on Gitea — the sandbox-side push succeeded.
    const branchResp = await fetch(
      `${giteaUrl}/api/v1/repos/${GITEA_USER}/${GITEA_REPO}/branches/${encodeURIComponent(branch)}`,
      { headers: { Authorization: `token ${giteaPat}` } },
    );
    expect(branchResp.status).toBe(200);

    // PR-create was captured by the scoped octokit factory.
    expect(capture).toHaveLength(1);
    expect(capture[0]?.body).toMatchObject({
      owner: GITEA_USER,
      repo: GITEA_REPO,
      head: branch,
      base: GITEA_DEFAULT_BRANCH,
      draft: true,
    });

    // Post-PR `fetchFeatureBranch` updated the local mirror's
    // remote-tracking ref. Resolves to a 40-char SHA on success.
    const refOut = await execFileP("git", [
      "-C",
      worktreePath,
      "rev-parse",
      `refs/remotes/origin/${branch}`,
    ]);
    expect(refOut.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);

    // Lifecycle events fired in order.
    expect(inngestSend.mock.calls.map((c) => c[0].name)).toEqual([
      "coding/task/verify-complete",
      "coding/task/pushed",
      "coding/task/pr-opened",
    ]);
    // Branch cleanup handled by afterEach via `branchesToCleanup`.
  }, 120_000);
});
