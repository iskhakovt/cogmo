/**
 * Inngest replay tests for the plan (`coding-task-start`) and execute
 * (`coding-task-execute`) orchestrators.
 *
 * These drive the real functions through `@inngest/test`, whose engine
 * reproduces Inngest's per-boundary model faithfully: it re-invokes the
 * whole function body once per step boundary, feeding earlier steps back
 * from cache. That is what production does on every clean run — it is not
 * a retry simulation — so anything left in the bare body runs N+1 times
 * for N steps.
 *
 * What these tests pin:
 *   1. The billable CLI session runs exactly once per task, even though the
 *      body around it is re-entered a dozen times.
 *   2. Progress pushes for that session are emitted once, not once per
 *      re-invocation.
 *   3. The execute orchestrator does not short-circuit on a status its own
 *      `set-status-executing` step wrote — the re-entry guard is the
 *      conditional UPDATE's memoized result, not a bare-body read.
 *   4. A genuinely duplicate event still skips, because the conditional
 *      UPDATE matches no row.
 *
 * See .claude/rules/inngest.md and design/crash-recovery.md.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { InngestTestEngine } from "@inngest/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inngest } from "../../inngest/client.js";
import {
  codingRepoRow,
  codingTaskRow,
  FIXTURE_TASK_ID,
  fakeCodingSandbox,
  statefulCodingStore,
} from "../../test/coding-fixtures.js";
import { fakeRunInTx, spyOnInngestSend } from "../../test/factories.js";
import type { CodingBackend, CodingEvent } from "./backend.js";
import {
  type CodingOrchestratorDeps,
  createCodingExecuteOrchestrator,
  createCodingOrchestrator,
  type ExecuteStreamHandle,
  type PlanStreamHandle,
} from "./orchestrator.js";
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
