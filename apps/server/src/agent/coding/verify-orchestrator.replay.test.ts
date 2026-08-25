/**
 * Inngest replay tests for the verify → push → PR orchestrator
 * (`coding-task-verify`).
 *
 * Driven through `@inngest/test`, whose engine re-invokes the whole function
 * body once per step boundary with earlier steps served from cache — the
 * shape of a clean production run, not a retry simulation.
 *
 * Pinned here: the test suite runs once per task, `git push` once, and
 * `pulls.create` once (a second POST returns 422 `validation_failed`, which
 * this function reads as a failure, so a re-POST would have the run that
 * just opened the PR mark its own task `failed`); the run doesn't
 * short-circuit on the `verifying` its own step wrote; a duplicate event
 * skips before reaching the failure machinery; and the `finally` fires once,
 * at the end.
 *
 * See .claude/rules/inngest.md and design/crash-recovery.md.
 */

import { InngestTestEngine } from "@inngest/test";
import type { Octokit } from "@octokit/rest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { inngest } from "../../inngest/client.js";
import {
  type GitHubIdentity,
  gitHubIdentitySecretName,
  serializeGitHubIdentity,
} from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import {
  codingTaskRow,
  type FakeCodingSandbox,
  FIXTURE_TASK_ID,
  fakeCodingSandbox,
  fakeExecHandle,
  type StatefulCodingStore,
  statefulCodingStore,
} from "../../test/coding-fixtures.js";
import { fakeRunInTx, spyOnInngestSend } from "../../test/factories.js";
import type { CodingTaskRow } from "./store/index.js";
import {
  createCodingVerifyOrchestrator,
  type VerifyOrchestratorDeps,
} from "./verify-orchestrator.js";

const HEAD_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const IDENTITY: GitHubIdentity = {
  pat: "ghp_dummy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nABC\n-----END OPENSSH PRIVATE KEY-----",
  sshPublicKey: "ssh-ed25519 AAAA cogmo-bot",
  login: "cogmo-bot",
  id: "12345",
};

let sendSpy: ReturnType<typeof spyOnInngestSend>;

beforeEach(() => {
  // The engine drives `inngest._send` for `step.sendEvent`; without a stub
  // each emit waits out an ECONNREFUSED retry against a dev server that
  // isn't running.
  sendSpy = spyOnInngestSend(inngest);
  sendSpy.mockResolvedValue({ ids: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A task that has finished execute and is waiting to be verified. */
function verifiableTask(overrides: Partial<CodingTaskRow> = {}): CodingTaskRow {
  return codingTaskRow({
    goal: "fix the thing",
    worktreeAssignment: {
      type: "host-path",
      branch: "cogmo/abc12345",
      worktreePath: "/tmp/worktrees/abc12345",
    },
    sessionId: "sess-AAA",
    plan: "1. step\n2. step",
    planApprovedAt: new Date("2026-08-20T00:01:00Z"),
    status: "pending_verify",
    ...overrides,
  });
}

interface ExecLog {
  verify: number;
  push: number;
  revParse: number;
}

/** Scripts the container's git + verify commands and counts each kind. */
function countingExec(log: ExecLog) {
  return async (cmd: ReadonlyArray<string>) => {
    if (cmd[0] === "bash") {
      log.verify++;
      return fakeExecHandle({ stdout: "PASS\n", exitCode: 0 });
    }
    const sub = cmd.slice(1).find((a) => !a.startsWith("-c") && !a.includes("="));
    if (sub === "push") log.push++;
    if (sub === "rev-parse") {
      log.revParse++;
      return fakeExecHandle({ stdout: `${HEAD_SHA}\n`, exitCode: 0 });
    }
    if (sub === "status") return fakeExecHandle({ stdout: "M src/foo.ts\n", exitCode: 0 });
    return fakeExecHandle({ exitCode: 0 });
  };
}

function fakeSecrets(): SecretsStore {
  const values = new Map<string, string>([
    [gitHubIdentitySecretName("default"), serializeGitHubIdentity(IDENTITY)],
    ["claude_code_oauth_token", "sk-test-claude-code-oauth-token"],
  ]);
  const store = mock<SecretsStore>();
  store.getSecret.mockImplementation(async (_tx, name: string) => values.get(name));
  return store;
}

interface Harness {
  deps: VerifyOrchestratorDeps;
  store: StatefulCodingStore;
  sandbox: FakeCodingSandbox;
  log: ExecLog;
  create: ReturnType<typeof vi.fn>;
}

function setup(task: CodingTaskRow): Harness {
  const log: ExecLog = { verify: 0, push: 0, revParse: 0 };
  const store = statefulCodingStore(task);
  const sandbox = fakeCodingSandbox(countingExec(log));
  const create = vi.fn(async () => ({
    data: {
      html_url: "https://github.com/user/cogmo/pull/7",
      number: 7,
      head: { sha: HEAD_SHA },
      created_at: "2026-08-20T00:02:00Z",
    },
  }));
  return {
    log,
    store,
    sandbox,
    create,
    deps: {
      runInTx: fakeRunInTx,
      store: store.store,
      sandbox: sandbox.sandbox,
      secretsStore: fakeSecrets(),
      askpassBaseDir: "/tmp/cogmo-replay-askpass",
      devbaseImage: "alpine",
      defaultResourceLimits: { cpus: 1, memory_bytes: 1 << 30, pids: 64 },
      taskTtlMs: 60_000,
      octokitFactory: () => ({ pulls: { create } }) as unknown as Octokit,
    },
  };
}

const cliDoneEvent = {
  name: "coding/task/cli-done",
  data: { taskId: FIXTURE_TASK_ID },
} as const;

describe("coding-task-verify — Inngest replay", () => {
  it("verifies, pushes, and opens the PR exactly once across the run's boundaries", async () => {
    const h = setup(verifiableTask());
    const fn = createCodingVerifyOrchestrator(h.deps, inngest);

    const engine = new InngestTestEngine({ function: fn, events: [cliDoneEvent] });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    // `set-status-verifying` flips the row to `verifying` on the first
    // invocation, and every later re-invocation re-reads it at the top of
    // the body. A bare-body `status !== "pending_verify"` guard returns
    // `skipped` there — the task never reaches `pr_open` and sits in
    // `verifying` forever.
    expect(result).toEqual({
      status: "pr_open",
      prUrl: "https://github.com/user/cogmo/pull/7",
      prNumber: 7,
    });
    expect(h.store.current().status).toBe("pr_open");

    // One test-suite run, one push, one PR — not one per remaining boundary.
    expect(h.log.verify).toBe(1);
    expect(h.log.push).toBe(1);
    expect(h.create).toHaveBeenCalledTimes(1);

    // Cleanup runs once, at the end. A step that has been planned but not
    // yet executed hands the body a promise the SDK never settles, so the
    // invocation ends with the function abandoned mid-`await` and the
    // `finally` does not fire on a boundary unwind. The design leans on
    // that: were it otherwise, this run would tear down its own sandbox
    // between `create-container` and the verify that needs it.
    expect(h.sandbox.teardownCalls()).toBe(1);

    // `openedAt` is stamped by `runOpenPr` at call time — now inside the
    // memoized step, so it is pinned to the one invocation that opened the
    // PR instead of drifting with each re-invocation.
    expect(h.store.current().prMetadata).toEqual({
      url: "https://github.com/user/cogmo/pull/7",
      number: 7,
      branchSha: HEAD_SHA,
      openedAt: expect.any(String),
    });
  });

  it("serves a cached verify verdict without re-running the suite", async () => {
    const h = setup(verifiableTask());
    const fn = createCodingVerifyOrchestrator(h.deps, inngest);

    const engine = new InngestTestEngine({
      function: fn,
      events: [cliDoneEvent],
      // Simulate: a prior attempt already ran the suite and Inngest is
      // re-invoking with that result in state.
      steps: [
        {
          id: "run-verify",
          handler: () => ({
            ok: true,
            exitCode: 0,
            output: "[cached PASS]",
            durationMs: 42,
            timedOut: false,
          }),
        },
      ],
    });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ status: "pr_open" });
    expect(h.log.verify).toBe(0);
    // The cached output is what reaches the PR body — proof the memoized
    // value flows through rather than being silently recomputed.
    expect(h.create).toHaveBeenCalledTimes(1);
    const body = h.create.mock.calls[0]?.[0] as { body: string } | undefined;
    expect(body?.body).toContain("[cached PASS]");
  });

  it("skips a duplicate event before reaching the failure machinery", async () => {
    // A duplicate `cli-done` for a task that already finished. The
    // conditional UPDATE matches no row, so the run must return `skipped`
    // without running identity resolution — whose failure would otherwise
    // flip an already-terminal task to `failed`.
    const h = setup(verifiableTask({ status: "pr_open" }));
    const fn = createCodingVerifyOrchestrator(h.deps, inngest);

    const engine = new InngestTestEngine({ function: fn, events: [cliDoneEvent] });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    expect(result).toEqual({ status: "skipped" });
    expect(h.store.current().status).toBe("pr_open");
    expect(h.log.verify).toBe(0);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.deps.store.updateTaskStatus).not.toHaveBeenCalled();
    // Returning ahead of the try block means the loser doesn't sweep the
    // sandbox either — relevant the day per-task concurrency is relaxed.
    expect(h.sandbox.teardownCalls()).toBe(0);
  });
});
