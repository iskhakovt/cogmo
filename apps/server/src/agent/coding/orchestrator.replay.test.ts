/**
 * Inngest replay tests for the plan (`coding-task-start`) and execute
 * (`coding-task-execute`) orchestrators.
 *
 * Driven through `@inngest/test`, whose engine re-invokes the whole function
 * body once per step boundary with earlier steps served from cache — what
 * production does on every clean run, not a retry simulation. Anything left
 * in the bare body therefore runs N+1 times for N steps.
 *
 * Pinned here: the billable CLI session runs once per task and emits its
 * progress once; neither orchestrator short-circuits on a status its own
 * step wrote; a genuinely duplicate event still skips.
 *
 * See .agents/rules/inngest.md and design/crash-recovery.md.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { InngestTestEngine } from "@inngest/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { inngest } from "../../inngest/client.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import {
  codingAuthSecrets,
  codingRepoRow,
  codingTaskRow,
  FIXTURE_TASK_ID,
  fakeCodingSandbox,
  statefulCodingStore,
} from "../../test/coding-fixtures.js";
import { emittedEventNames, fakeRunInTx, spyOnInngestSend } from "../../test/factories.js";
import type { CodingBackend, CodingEvent } from "./backend.js";
import {
  type CodingOrchestratorDeps,
  createCodingExecuteOrchestrator,
  createCodingOrchestrator,
} from "./orchestrator.js";
import type { ExecuteStreamHandle, PlanStreamHandle } from "./progress-stream.js";
import type { CodingTaskRow } from "./store/index.js";

const execFileP = promisify(execFile);

let baseDir: string;
let repoPath: string;
let sendSpy: ReturnType<typeof spyOnInngestSend>;

beforeAll(async () => {
  // `allocate-worktree` clones for real, so the plan orchestrator needs an
  // actual repository behind `repo.localPath`.
  baseDir = mkdtempSync(join(tmpdir(), "cogmo-replay-test-"));
  repoPath = join(baseDir, "repo");
  await execFileP("git", ["init", "--initial-branch=main", repoPath]);
  await execFileP("git", ["-C", repoPath, "config", "user.email", "t@t"]);
  await execFileP("git", ["-C", repoPath, "config", "user.name", "t"]);
  await execFileP("git", ["-C", repoPath, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(repoPath, "README.md"), "x");
  await execFileP("git", ["-C", repoPath, "add", "."]);
  await execFileP("git", ["-C", repoPath, "commit", "-m", "init"]);
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

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

const PLAN_EVENTS: CodingEvent[] = [
  { kind: "session_started", sessionId: "sess-AAA" },
  { kind: "text_delta", text: "## Plan\n" },
  { kind: "plan_ready", plan: "## Plan\n1. Do X\n" },
  { kind: "complete", exitCode: 0, isError: false },
];

const EXECUTE_EVENTS: CodingEvent[] = [
  { kind: "session_started", sessionId: "sess-AAA" },
  { kind: "text_delta", text: "Editing foo.ts\n" },
  {
    kind: "complete",
    exitCode: 0,
    isError: false,
    usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.05 },
  },
];

/** Counts invocations so a per-boundary re-entry shows up as a second call. */
function countingBackend(events: { plan?: CodingEvent[]; execute?: CodingEvent[] }): {
  backend: CodingBackend;
  planCalls: () => number;
  executeCalls: () => number;
} {
  let planCalls = 0;
  let executeCalls = 0;
  return {
    backend: {
      plan: async function* () {
        planCalls++;
        for (const ev of events.plan ?? []) yield ev;
      },
      execute: async function* () {
        executeCalls++;
        for (const ev of events.execute ?? []) yield ev;
      },
    },
    planCalls: () => planCalls,
    executeCalls: () => executeCalls,
  };
}

function recordingPlanStream(): { handle: PlanStreamHandle; text: string[]; finalized: string[] } {
  const text: string[] = [];
  const finalized: string[] = [];
  return {
    text,
    finalized,
    handle: {
      appendText: async (delta) => {
        text.push(delta);
      },
      finalize: async (plan) => {
        finalized.push(plan);
      },
      fail: async () => {},
    },
  };
}

function recordingExecuteStream(): {
  handle: ExecuteStreamHandle;
  started: () => number;
  text: () => string[];
} {
  let started = 0;
  const text: string[] = [];
  return {
    started: () => started,
    text: () => text,
    handle: {
      started: async () => {
        started++;
      },
      appendText: async (delta) => {
        text.push(delta);
      },
      toolCall: async () => {},
      toolResult: async () => {},
      complete: async () => {},
      fail: async () => {},
    },
  };
}

function makeDeps(overrides: Partial<CodingOrchestratorDeps>): CodingOrchestratorDeps {
  return {
    runInTx: fakeRunInTx,
    store: statefulCodingStore(codingTaskRow()).store,
    sandbox: fakeCodingSandbox().sandbox,
    backend: countingBackend({}).backend,
    secretsStore: codingAuthSecrets(),
    devbaseImage: "cogmo/devbase:test",
    defaultResourceLimits: { cpus: 0.5, memory_bytes: 256 * 1024 * 1024, pids: 64 },
    taskTtlMs: 60_000,
    worktreesDir: join(baseDir, "worktrees"),
    askpassBaseDir: join(baseDir, "askpass"),
    ...overrides,
  };
}

/** The plan orchestrator clones `repo.localPath`, so point it at the fixture. */
const localRepo = () => codingRepoRow({ localPath: repoPath, remoteUrl: "git@github.com:u/c.git" });

describe("coding-task-start — Inngest replay", () => {
  it("runs the billable plan session once across the run's step boundaries", async () => {
    const { store, current } = statefulCodingStore(codingTaskRow(), localRepo());
    const backend = countingBackend({ plan: PLAN_EVENTS });
    const planStream = recordingPlanStream();
    const fn = createCodingOrchestrator(
      makeDeps({
        store,
        backend: backend.backend,
        openPlanStream: async () => planStream.handle,
      }),
      inngest,
    );

    const engine = new InngestTestEngine({
      function: fn,
      events: [{ name: "coding/task/start", data: { taskId: FIXTURE_TASK_ID } }],
    });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    expect(result).toEqual({ status: "awaiting_approval", plan: "## Plan\n1. Do X\n" });
    expect(current().status).toBe("awaiting_approval");

    // The load-bearing assertion. `backend.plan` spawns a paid `claude -p`
    // session with no `--resume`, so a bare-body call would replan from
    // scratch at each of the ~8 remaining boundaries and re-render the plan
    // into the user's message every time.
    expect(backend.planCalls()).toBe(1);
    expect(planStream.text).toEqual(["## Plan\n"]);
    expect(planStream.finalized).toEqual(["## Plan\n1. Do X\n"]);
  });

  it("a run in flight across the deploy that replaced `set-status-failed` still announces the failure", async () => {
    // The superseded step wrote `failed` and memoized `void`; the claim and
    // the failed plan session are in state. `transition-failed` executes
    // once, finds the row `already_terminal` at `failed`, and the failure
    // flow — the event, the teardown — carries on as recorded.
    const { store, current } = statefulCodingStore(
      codingTaskRow({
        status: "failed",
        failureReason: "cli_exit_error",
        failureDetail: "plan exited with code 2",
      }),
      localRepo(),
    );
    const backend = countingBackend({ plan: PLAN_EVENTS });
    const sandbox = fakeCodingSandbox();
    const fn = createCodingOrchestrator(
      makeDeps({ store, backend: backend.backend, sandbox: sandbox.sandbox }),
      inngest,
    );

    const engine = new InngestTestEngine({
      function: fn,
      events: [{ name: "coding/task/start", data: { taskId: FIXTURE_TASK_ID } }],
      steps: [
        { id: "claim-task-planning", handler: () => ({ kind: "transitioned" }) },
        {
          id: "plan-cli",
          handler: () => ({ isError: true, failureReason: "plan exited with code 2" }),
        },
      ],
    });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    // The memoized `plan-cli` result predates `failure`: its `failureReason`
    // text reads as the `cli_exit_error` detail.
    expect(result).toEqual({
      status: "failed",
      failure: { reason: "cli_exit_error", detail: "plan exited with code 2" },
    });
    expect(current().status).toBe("failed");
    expect(backend.planCalls()).toBe(0);
    expect(emittedEventNames(sendSpy)).toContain("coding/task/failed");
    expect(sandbox.teardownCalls()).toBe(1);
  });

  it("skips a duplicate start event instead of re-planning", async () => {
    // What a re-delivered `coding/task/start` finds once the first run has
    // moved the row past `queued`. Without the conditional transition this
    // mints a second container and pays for a second plan session.
    const { store, current } = statefulCodingStore(
      codingTaskRow({ status: "awaiting_approval", plan: "## Plan\n1. Do X\n" }),
      localRepo(),
    );
    const backend = countingBackend({ plan: PLAN_EVENTS });
    const sandbox = fakeCodingSandbox();
    const fn = createCodingOrchestrator(
      makeDeps({ store, backend: backend.backend, sandbox: sandbox.sandbox }),
      inngest,
    );

    const engine = new InngestTestEngine({
      function: fn,
      events: [{ name: "coding/task/start", data: { taskId: FIXTURE_TASK_ID } }],
    });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    expect(result).toEqual({ status: "skipped" });
    expect(backend.planCalls()).toBe(0);
    expect(sandbox.sandbox.create).not.toHaveBeenCalled();
    expect(current().status).toBe("awaiting_approval");
  });
});

describe("coding-task-execute — Inngest replay", () => {
  const approvedTask = (overrides: Partial<CodingTaskRow> = {}): CodingTaskRow =>
    codingTaskRow({
      status: "awaiting_approval",
      planApprovedAt: new Date("2026-08-20T00:01:00Z"),
      sessionId: "sess-AAA",
      plan: "## Plan\n1. Do X\n",
      worktreeAssignment: {
        type: "host-path",
        branch: "cogmo/abc",
        worktreePath: join(baseDir, "worktrees", "cogmo", "abc"),
      },
      ...overrides,
    });

  const approvedEvent = {
    name: "coding/task/plan-approved",
    data: { taskId: FIXTURE_TASK_ID, approvedAt: "2026-08-20T00:01:00.000Z" },
  } as const;

  it("does not short-circuit on the `executing` status its own step wrote", async () => {
    const { store, current } = statefulCodingStore(approvedTask(), localRepo());
    const backend = countingBackend({ execute: EXECUTE_EVENTS });
    const stream = recordingExecuteStream();
    const fn = createCodingExecuteOrchestrator(
      makeDeps({
        store,
        backend: backend.backend,
        openExecuteStream: async () => stream.handle,
      }),
      inngest,
    );

    const engine = new InngestTestEngine({ function: fn, events: [approvedEvent] });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    // `set-status-executing` flips the row to `executing` on the first
    // invocation. Every later re-invocation re-reads that row at the top of
    // the body; a bare-body `status !== "awaiting_approval"` guard would
    // return `skipped` there and strand the task mid-execute.
    expect(result).toEqual({ status: "pending_verify" });
    expect(current().status).toBe("pending_verify");
    expect(backend.executeCalls()).toBe(1);
    expect(stream.started()).toBe(1);
    expect(stream.text()).toEqual(["Editing foo.ts\n"]);
  });

  it("reads an `execute-cli` memo predating `failure` as a cli_exit_error", async () => {
    // A run in flight across the deploy memoized `{ isError, failureReason }`;
    // the failure it records carries that text as the detail.
    const { store, current } = statefulCodingStore(approvedTask(), localRepo());
    const backend = countingBackend({ execute: EXECUTE_EVENTS });
    const fn = createCodingExecuteOrchestrator(
      makeDeps({ store, backend: backend.backend }),
      inngest,
    );

    const engine = new InngestTestEngine({
      function: fn,
      events: [approvedEvent],
      steps: [
        { id: "set-status-executing", handler: () => ({ kind: "transitioned" }) },
        { id: "try-resume", handler: () => null },
        {
          id: "execute-cli",
          handler: () => ({ isError: true, failureReason: "claude exit code 2" }),
        },
      ],
    });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    expect(result).toEqual({
      status: "failed",
      failure: { reason: "cli_exit_error", detail: "claude exit code 2" },
    });
    expect(current().failureReason).toBe("cli_exit_error");
    expect(current().failureDetail).toBe("claude exit code 2");
    expect(backend.executeCalls()).toBe(0);
  });

  it("carries on past a memoized `check-credentials` when the OAuth token is removed later in the run", async () => {
    // The verdict is memoized: a token deleted after `create-container`
    // does not send a replay down the credentials failure exit, which would
    // fail a task that has already moved on and tear down its worktree.
    const { store, current } = statefulCodingStore(approvedTask(), localRepo());
    const backend = countingBackend({ execute: EXECUTE_EVENTS });
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecret.mockResolvedValue(undefined);
    const fn = createCodingExecuteOrchestrator(
      makeDeps({ store, backend: backend.backend, secretsStore }),
      inngest,
    );

    const engine = new InngestTestEngine({
      function: fn,
      events: [approvedEvent],
      steps: [
        { id: "try-resume", handler: () => null },
        { id: "check-credentials", handler: () => ({ kind: "present" }) },
        {
          id: "create-container",
          handler: () => ({
            type: "local-docker",
            taskId: FIXTURE_TASK_ID,
            containerRowId: "row-1",
            dockerId: "docker-1",
          }),
        },
        {
          id: "execute-cli",
          handler: () => ({ kind: "completed", usage: { inputTokens: 100, outputTokens: 20 } }),
        },
      ],
    });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    expect(result).toEqual({ status: "pending_verify" });
    expect(current().status).toBe("pending_verify");
    expect(current().failureReason).toBeNull();
    expect(backend.executeCalls()).toBe(0);
  });

  it("reads an `execute-cli` memo of the errored shape as its failure", async () => {
    const { store, current } = statefulCodingStore(approvedTask(), localRepo());
    const backend = countingBackend({ execute: EXECUTE_EVENTS });
    const fn = createCodingExecuteOrchestrator(
      makeDeps({ store, backend: backend.backend }),
      inngest,
    );

    const engine = new InngestTestEngine({
      function: fn,
      events: [approvedEvent],
      steps: [
        { id: "set-status-executing", handler: () => ({ kind: "transitioned" }) },
        { id: "try-resume", handler: () => null },
        {
          id: "execute-cli",
          handler: () => ({
            kind: "errored",
            failure: { reason: "cli_exit_error", detail: "claude exit code 3" },
          }),
        },
      ],
    });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    expect(result).toEqual({
      status: "failed",
      failure: { reason: "cli_exit_error", detail: "claude exit code 3" },
    });
    expect(current().failureReason).toBe("cli_exit_error");
    expect(backend.executeCalls()).toBe(0);
  });

  it("still skips a duplicate event, because the conditional UPDATE matches no row", async () => {
    // Same shape as above except the row is already terminal — what a
    // genuinely duplicate `plan-approved` event finds.
    const { store, current } = statefulCodingStore(
      approvedTask({ status: "pr_open" }),
      localRepo(),
    );
    const backend = countingBackend({ execute: EXECUTE_EVENTS });
    const fn = createCodingExecuteOrchestrator(
      makeDeps({ store, backend: backend.backend }),
      inngest,
    );

    const engine = new InngestTestEngine({ function: fn, events: [approvedEvent] });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    expect(result).toEqual({ status: "skipped" });
    expect(backend.executeCalls()).toBe(0);
    expect(current().status).toBe("pr_open");
  });
});
