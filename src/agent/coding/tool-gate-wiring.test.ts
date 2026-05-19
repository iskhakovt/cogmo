/**
 * Tool gate wiring test — drives `runCodingExecute` through the
 * permission_request path with a fake backend handle, verifies the
 * orchestrator's auto-allow / decision-log replay / Telegram-prompt /
 * deny branches all behave correctly.
 *
 * Telegram delivery itself isn't exercised here — the orchestrator emits
 * `coding/task/permission-requested` and the Telegram adapter's Inngest
 * function picks it up. That's `slice 3.0j` e2e territory. This test
 * stops at the Inngest event boundary: assert the right event was sent,
 * resolve the wait shim with a fake decision payload, and check the
 * decision log.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Inngest } from "inngest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import type { StepWaitForEvent } from "../../inngest/index.js";
import {
  type ExecStreamingHandle,
  type LocalDockerSessionState,
  LocalDockerSessionStateSchema,
  type SandboxClient,
} from "../../sandbox/index.js";
import { DrizzleSandboxStore } from "../../sandbox/store/index.js";
import type { ResourceLimits } from "../../sandbox/types.js";
import { makeStepRun, nullStepSendEvent } from "../../test/factories.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleAgentStore } from "../store/index.js";
import type {
  CodingBackend,
  CodingEvent,
  CodingExecuteHandle,
  PermissionResponse,
} from "./backend.js";
import {
  type CodingOrchestratorDeps,
  type ExecuteStreamHandle,
  NULL_EXECUTE_STREAM,
  runCodingExecute,
} from "./orchestrator.js";
import { type CodingRepoRow, type CodingTaskRow, DrizzleCodingStore } from "./store/index.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleCodingStore;
let agentStore: DrizzleAgentStore;
let sandboxStore: DrizzleSandboxStore;
let baseDir: string;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleCodingStore();
  agentStore = new DrizzleAgentStore();
  sandboxStore = new DrizzleSandboxStore();
  baseDir = mkdtempSync(join(tmpdir(), "cogmo-tool-gate-test-"));
});

beforeEach(async () => {
  // Insert a sandbox instance row — required by `containers.instance_id`'s
  // FK when the orchestrator stamps a container row mid-test.
  await tx((trx) => sandboxStore.insertInstance(trx, { host: "h", pid: 1 }));
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  rmSync(baseDir, { recursive: true, force: true });
  await close();
});

const RESOURCE_LIMITS: ResourceLimits = {
  cpus: 0.5,
  memory_bytes: 256 * 1024 * 1024,
  pids: 64,
};

const stepRun = makeStepRun();
const stepSendEvent = nullStepSendEvent();

async function seedRepoAndTask(): Promise<{ repo: CodingRepoRow; task: CodingTaskRow }> {
  const repo = await tx((trx) =>
    store.insertRepo(trx, {
      name: `repo-${Math.random().toString(36).slice(2)}`,
      localPath: `${baseDir}/repo`,
      defaultBranch: "main",
      remoteUrl: "git@example.com:x.git",
      devcontainer: null,
      allowedBackends: ["claude"],
      verifyCommand: "true",
      taskTokenBudget: 100_000,
      taskWallTimeSeconds: 60,
      maxConcurrentTasks: 1,
    }),
  );
  const task = await tx((trx) =>
    store.insertTask(trx, {
      repoId: repo.id,
      goal: "test",
      triggerSource: "user",
      backend: "claude",
      allowPrivilegedRunc: false,
    }),
  );
  await tx((trx) => store.setTaskSessionId(trx, task.id, "sess-x"));
  await tx((trx) =>
    store.setTaskWorktreeAssignment(trx, task.id, {
      type: "host-path",
      branch: "cogmo/x",
      worktreePath: `${baseDir}/wt`,
    }),
  );
  await tx((trx) =>
    store.updateTaskStatus(trx, {
      id: task.id,
      status: "awaiting_approval",
      planApprovedAt: new Date(),
    }),
  );
  const reloaded = (await tx((trx) => store.getTask(trx, task.id))) as CodingTaskRow;
  return { repo, task: reloaded };
}

/**
 * Variant of `seedRepoAndTask` that wires the task to a real
 * profile/conversation chain with `coding_autoapprove_mode = 'on'`.
 * Used by the autoapprove-bypass test — `seedRepoAndTask` alone leaves
 * `conversation_id` null, which the join returns as null, which the
 * orchestrator treats as the default `off`.
 */
async function seedRepoAndTaskWithAutoapprove(): Promise<{
  repo: CodingRepoRow;
  task: CodingTaskRow;
}> {
  const repo = await tx((trx) =>
    store.insertRepo(trx, {
      name: `repo-${Math.random().toString(36).slice(2)}`,
      localPath: `${baseDir}/repo`,
      defaultBranch: "main",
      remoteUrl: "git@example.com:x.git",
      devcontainer: null,
      allowedBackends: ["claude"],
      verifyCommand: "true",
      taskTokenBudget: 100_000,
      taskWallTimeSeconds: 60,
      maxConcurrentTasks: 1,
    }),
  );
  const user = await tx((trx) => agentStore.createUser(trx));
  const profile = await tx((trx) =>
    agentStore.createProfile(trx, {
      userId: user.id,
      name: `prof-${Math.random().toString(36).slice(2)}`,
      basePrompt: "test",
      model: "claude-haiku-4-5-20251001",
      toolSet: [],
    }),
  );
  await tx((trx) => agentStore.updateProfile(trx, profile.id, { codingAutoapproveMode: "on" }));
  const conv = await tx((trx) =>
    agentStore.createConversation(trx, {
      userId: user.id,
      profileId: profile.id,
      isPrivate: true,
    }),
  );
  const task = await tx((trx) =>
    store.insertTask(trx, {
      repoId: repo.id,
      conversationId: conv.id,
      goal: "test",
      triggerSource: "user",
      backend: "claude",
      allowPrivilegedRunc: false,
    }),
  );
  await tx((trx) => store.setTaskSessionId(trx, task.id, "sess-x"));
  await tx((trx) =>
    store.setTaskWorktreeAssignment(trx, task.id, {
      type: "host-path",
      branch: "cogmo/x",
      worktreePath: `${baseDir}/wt`,
    }),
  );
  await tx((trx) =>
    store.updateTaskStatus(trx, {
      id: task.id,
      status: "awaiting_approval",
      planApprovedAt: new Date(),
    }),
  );
  const reloaded = (await tx((trx) => store.getTask(trx, task.id))) as CodingTaskRow;
  return { repo, task: reloaded };
}

interface FakeBackendHandle {
  events: CodingEvent[];
  responses: Array<{ requestId: string; response: PermissionResponse }>;
}

function fakeBackend(events: CodingEvent[]): { backend: CodingBackend; handle: FakeBackendHandle } {
  const responses: { requestId: string; response: PermissionResponse }[] = [];
  // AsyncIterable whose first `next()` throws — used as a `plan` stub in
  // tests that only exercise `execute`. Hand-rolled to dodge biome's
  // `useYield` rule on a generator that has nothing to yield.
  const throwingPlan: AsyncIterable<CodingEvent> = {
    [Symbol.asyncIterator]: () => ({
      async next(): Promise<IteratorResult<CodingEvent>> {
        throw new Error("plan not exercised by this test");
      },
    }),
  };
  const backend: CodingBackend = {
    plan: () => throwingPlan,
    execute: async (): Promise<CodingExecuteHandle> => ({
      events: (async function* () {
        for (const ev of events) yield ev;
      })(),
      respondPermission: async (requestId, response) => {
        responses.push({ requestId, response });
      },
    }),
  };
  return { backend, handle: { events, responses } };
}

function fakeSandbox(): { sandbox: SandboxClient<LocalDockerSessionState>; stopCalls: string[] } {
  const stopCalls: string[] = [];

  const noopExec = (): ExecStreamingHandle => ({
    stdout: process.stdin,
    stderr: process.stdin,
    wait: async () => ({ exitCode: 0 }),
    dispose: async () => {},
  });

  const session = {
    state: {
      type: "local-docker" as const,
      taskId: "task",
      containerRowId: "row-x",
      dockerId: "docker-x",
    },
    execStreaming: vi.fn(async () => noopExec()),
    exec: vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      wallTimeSeconds: 0,
      truncated: false,
    })),
  };

  const sandbox: SandboxClient<LocalDockerSessionState> = {
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
    create: vi.fn(),
    resume: vi.fn(async () => session),
    tryResumeByTaskId: vi.fn(async () => session),
    delete: vi.fn(async () => {}),
    deleteByTaskId: vi.fn(async (id: string) => {
      stopCalls.push(id);
    }),
    serializeState: (state) => LocalDockerSessionStateSchema.parse(state),
    deserializeState: (payload) => LocalDockerSessionStateSchema.parse(payload),
    shutdown: async () => {},
  };
  return { sandbox, stopCalls };
}

function makeDeps(args: {
  sandbox: SandboxClient<LocalDockerSessionState>;
  backend: CodingBackend;
}): CodingOrchestratorDeps {
  return {
    runInTx: tx,
    store,
    sandbox: args.sandbox,
    backend: args.backend,
    devbaseImage: "img",
    defaultResourceLimits: RESOURCE_LIMITS,
    taskTtlMs: 60_000,
    worktreesDir: `${baseDir}/worktrees`,
    openExecuteStream: async (): Promise<ExecuteStreamHandle> => NULL_EXECUTE_STREAM,
  };
}

describe("tool gate wiring", () => {
  it("auto-allows a default-allow tool (Read) without prompting", async () => {
    const { task } = await seedRepoAndTask();
    const { sandbox } = fakeSandbox();
    const { backend, handle } = fakeBackend([
      { kind: "session_started", sessionId: "sess-x" },
      {
        kind: "permission_request",
        requestId: "req_read_1",
        tool: "Read",
        input: { path: "/etc/foo" },
      },
      { kind: "complete", exitCode: 0, isError: false },
    ]);

    const inngestSend = vi.fn().mockResolvedValue(undefined);
    const stepWaitForEvent = vi.fn();
    await runCodingExecute({
      taskId: task.id,
      deps: makeDeps({ sandbox, backend }),
      stepRun,
      stepSendEvent,
      stepWaitForEvent,
      inngest: { send: inngestSend } as unknown as Inngest,
    });

    // Auto-allow path: no permission_request event, no waitForEvent. The
    // cli-done event still fires at the end of execute (slice 4.0h handoff).
    const eventNames = inngestSend.mock.calls.map((c) => c[0].name);
    expect(eventNames).not.toContain("coding/task/permission-requested");
    expect(stepWaitForEvent).not.toHaveBeenCalled();
    expect(handle.responses).toEqual([
      { requestId: "req_read_1", response: { behavior: "allow" } },
    ]);
    // Decision logged for audit (scope=once).
    const log = await tx((trx) => store.listToolDecisionsForTask(trx, task.id));
    expect(log).toHaveLength(1);
    expect(log[0]?.decision).toBe("allow");
    expect(log[0]?.scope).toBe("once");
    expect(log[0]?.tool).toBe("Read");
  });

  it("replays a task-scoped decision-log entry without prompting", async () => {
    const { task } = await seedRepoAndTask();
    // User previously granted "Allow for task" on git push.
    await tx((trx) =>
      store.insertToolDecision(trx, {
        taskId: task.id,
        tool: "Bash",
        pattern: "Bash(git push *)",
        decision: "allow",
        scope: "task",
      }),
    );

    const { sandbox } = fakeSandbox();
    const { backend, handle } = fakeBackend([
      { kind: "session_started", sessionId: "sess-x" },
      {
        kind: "permission_request",
        requestId: "req_push_1",
        tool: "Bash",
        input: { command: "git push origin main" },
      },
      { kind: "complete", exitCode: 0, isError: false },
    ]);

    const inngestSend = vi.fn().mockResolvedValue(undefined);
    const stepWaitForEvent = vi.fn();
    await runCodingExecute({
      taskId: task.id,
      deps: makeDeps({ sandbox, backend }),
      stepRun,
      stepSendEvent,
      stepWaitForEvent,
      inngest: { send: inngestSend } as unknown as Inngest,
    });

    // Replay path: no permission_request emit, no waitForEvent. The
    // cli-done event still fires at the end of execute (slice 4.0h handoff).
    const eventNames = inngestSend.mock.calls.map((c) => c[0].name);
    expect(eventNames).not.toContain("coding/task/permission-requested");
    expect(stepWaitForEvent).not.toHaveBeenCalled();
    expect(handle.responses[0]?.response).toEqual({ behavior: "allow" });
    // Log unchanged (only the seeded task row remains).
    const log = await tx((trx) => store.listToolDecisionsForTask(trx, task.id));
    expect(log).toHaveLength(1);
    expect(log[0]?.scope).toBe("task");
  });

  it("prompts via Telegram + waits for user, applies allow_task to the log", async () => {
    const { task } = await seedRepoAndTask();
    const { sandbox } = fakeSandbox();
    const { backend, handle } = fakeBackend([
      { kind: "session_started", sessionId: "sess-x" },
      {
        kind: "permission_request",
        requestId: "req_push_xyz",
        tool: "Bash",
        input: { command: "git push origin cogmo/abc" },
      },
      { kind: "complete", exitCode: 0, isError: false },
    ]);

    const inngestSend = vi.fn().mockResolvedValue(undefined);
    // User answered "Allow for task" via Telegram.
    const stepWaitForEvent = vi.fn().mockResolvedValue({
      data: {
        taskId: task.id,
        requestId: "req_push_xyz",
        decision: "allow",
        scope: "task",
      },
    });

    await runCodingExecute({
      taskId: task.id,
      deps: makeDeps({ sandbox, backend }),
      stepRun,
      stepSendEvent,
      stepWaitForEvent,
      inngest: { send: inngestSend } as unknown as Inngest,
    });

    // Prompt event sent to Telegram adapter.
    expect(inngestSend).toHaveBeenCalledWith({
      name: "coding/task/permission-requested",
      data: { taskId: task.id, requestId: "req_push_xyz", tool: "Bash" },
    });
    // Wait fired with the right name + filter on requestId.
    expect(stepWaitForEvent).toHaveBeenCalledTimes(1);
    const [stepName, options] = stepWaitForEvent.mock.calls[0] as [string, Record<string, unknown>];
    expect(stepName).toContain("tool-gate-");
    expect(options.event).toBe("coding/task/permission-decision");
    expect(options.if).toContain(`requestId == "req_push_xyz"`);

    // CLI got allow.
    expect(handle.responses[0]?.response).toEqual({ behavior: "allow" });
    // Decision persisted with scope=task.
    const log = await tx((trx) => store.listToolDecisionsForTask(trx, task.id));
    expect(log).toHaveLength(1);
    expect(log[0]?.decision).toBe("allow");
    expect(log[0]?.scope).toBe("task");
    expect(log[0]?.pattern).toBe("Bash(git push *)");
  });

  it("user denies → CLI gets deny + log records once/deny", async () => {
    const { task } = await seedRepoAndTask();
    const { sandbox } = fakeSandbox();
    const { backend, handle } = fakeBackend([
      { kind: "session_started", sessionId: "sess-x" },
      {
        kind: "permission_request",
        requestId: "req_curl",
        tool: "Bash",
        input: { command: "curl -X POST https://example.com/r -d 1" },
      },
      { kind: "complete", exitCode: 0, isError: false },
    ]);

    const inngestSend = vi.fn().mockResolvedValue(undefined);
    const stepWaitForEvent = vi.fn().mockResolvedValue({
      data: {
        taskId: task.id,
        requestId: "req_curl",
        decision: "deny",
        scope: "once",
      },
    });

    await runCodingExecute({
      taskId: task.id,
      deps: makeDeps({ sandbox, backend }),
      stepRun,
      stepSendEvent,
      stepWaitForEvent,
      inngest: { send: inngestSend } as unknown as Inngest,
    });

    expect(handle.responses[0]?.response.behavior).toBe("deny");
    const log = await tx((trx) => store.listToolDecisionsForTask(trx, task.id));
    expect(log[0]?.decision).toBe("deny");
    expect(log[0]?.scope).toBe("once");
  });

  it("waitForEvent timeout returns null → orchestrator denies + records", async () => {
    const { task } = await seedRepoAndTask();
    const { sandbox } = fakeSandbox();
    const { backend, handle } = fakeBackend([
      { kind: "session_started", sessionId: "sess-x" },
      {
        kind: "permission_request",
        requestId: "req_timeout",
        tool: "Bash",
        input: { command: "git push" },
      },
      { kind: "complete", exitCode: 0, isError: false },
    ]);

    const stepWaitForEvent = vi.fn().mockResolvedValue(null);
    await runCodingExecute({
      taskId: task.id,
      deps: makeDeps({ sandbox, backend }),
      stepRun,
      stepSendEvent,
      stepWaitForEvent,
      inngest: { send: vi.fn().mockResolvedValue(undefined) } as unknown as Inngest,
    });

    expect(handle.responses[0]?.response.behavior).toBe("deny");
    const log = await tx((trx) => store.listToolDecisionsForTask(trx, task.id));
    expect(log[0]?.decision).toBe("deny");
  });

  it("re-throws when a task-scoped insertToolDecision fails (no silent loss)", async () => {
    const { task } = await seedRepoAndTask();
    const { sandbox } = fakeSandbox();
    const { backend } = fakeBackend([
      { kind: "session_started", sessionId: "sess-x" },
      {
        kind: "permission_request",
        requestId: "req_loss",
        tool: "Bash",
        input: { command: "git push" },
      },
      { kind: "complete", exitCode: 0, isError: false },
    ]);

    const inngestSend = vi.fn().mockResolvedValue(undefined);
    const stepWaitForEvent = vi.fn().mockResolvedValue({
      data: { taskId: task.id, requestId: "req_loss", decision: "allow", scope: "task" },
    });

    // Wrap the store so insertToolDecision throws.
    const wrappedStore = new Proxy(store, {
      get(target, prop) {
        if (prop === "insertToolDecision") {
          return async () => {
            throw new Error("synthetic DB failure");
          };
        }
        const value = (target as any)[prop];
        // Bind methods to the underlying target so calls through the
        // Proxy resolve `#db` etc. against the real store, not the Proxy.
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const deps = makeDeps({ sandbox, backend });
    const result = await runCodingExecute({
      taskId: task.id,
      deps: { ...deps, store: wrappedStore },
      stepRun,
      stepSendEvent,
      stepWaitForEvent,
      inngest: { send: inngestSend } as unknown as Inngest,
    });

    // Task-scope DB failure surfaces as a failed task — better loud than
    // silently re-prompting after the user already saw "Allowed for task".
    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("synthetic DB failure");
  });

  it("once-scope insertToolDecision failure is logged and the run continues", async () => {
    const { task } = await seedRepoAndTask();
    const { sandbox } = fakeSandbox();
    const { backend, handle } = fakeBackend([
      { kind: "session_started", sessionId: "sess-x" },
      {
        kind: "permission_request",
        requestId: "req_audit",
        tool: "Read",
        input: { path: "/etc/foo" },
      },
      { kind: "complete", exitCode: 0, isError: false },
    ]);

    const wrappedStore = new Proxy(store, {
      get(target, prop) {
        if (prop === "insertToolDecision") {
          return async () => {
            throw new Error("synthetic audit-log failure");
          };
        }
        const value = (target as any)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const deps = makeDeps({ sandbox, backend });
    const result = await runCodingExecute({
      taskId: task.id,
      deps: { ...deps, store: wrappedStore },
      stepRun,
      stepSendEvent,
      stepWaitForEvent: vi.fn(),
      inngest: { send: vi.fn().mockResolvedValue(undefined) } as unknown as Inngest,
    });

    // Auto-allow path: persistence is audit-only, drop on the floor and
    // continue. The CLI got the allow.
    expect(result.status).toBe("pending_verify");
    expect(handle.responses[0]?.response).toEqual({ behavior: "allow" });
  });

  it("two consecutive prompted requests get independent decisions", async () => {
    const { task } = await seedRepoAndTask();
    const { sandbox } = fakeSandbox();
    const { backend, handle } = fakeBackend([
      { kind: "session_started", sessionId: "sess-x" },
      {
        kind: "permission_request",
        requestId: "req_a",
        tool: "Bash",
        input: { command: "git push origin a" },
      },
      {
        kind: "permission_request",
        requestId: "req_b",
        tool: "Bash",
        input: { command: "npm publish" },
      },
      { kind: "complete", exitCode: 0, isError: false },
    ]);

    const inngestSend = vi.fn().mockResolvedValue(undefined);
    let waitCount = 0;
    // The real `StepWaitForEvent` is a generic Inngest helper whose signature
    // depends on the event registry; this fake only satisfies the call sites
    // the test exercises, so cast through the loose async signature.
    const stepWaitForEvent = (async () => {
      waitCount += 1;
      if (waitCount === 1) {
        return {
          data: { taskId: task.id, requestId: "req_a", decision: "allow", scope: "task" },
        };
      }
      return {
        data: { taskId: task.id, requestId: "req_b", decision: "deny", scope: "once" },
      };
    }) as unknown as StepWaitForEvent;

    await runCodingExecute({
      taskId: task.id,
      deps: makeDeps({ sandbox, backend }),
      stepRun,
      stepSendEvent,
      stepWaitForEvent,
      inngest: { send: inngestSend } as unknown as Inngest,
    });

    expect(handle.responses).toHaveLength(2);
    expect(handle.responses[0]?.response.behavior).toBe("allow");
    expect(handle.responses[1]?.response.behavior).toBe("deny");

    const log = await tx((trx) => store.listToolDecisionsForTask(trx, task.id));
    expect(log.map((r) => `${r.pattern}/${r.decision}/${r.scope}`)).toEqual([
      "Bash(git push *)/allow/task",
      "Bash(npm publish *)/deny/once",
    ]);
  });

  it("profile autoapprove=on flips a policy.prompt to allow without Telegram round trip", async () => {
    const { task } = await seedRepoAndTaskWithAutoapprove();
    const { sandbox } = fakeSandbox();
    const { backend, handle } = fakeBackend([
      { kind: "session_started", sessionId: "sess-x" },
      {
        kind: "permission_request",
        requestId: "req_push_ap",
        tool: "Bash",
        // `git push` is in the policy prompt set; without autoapprove this
        // would route to Telegram. With profile.codingAutoapproveMode='on'
        // it short-circuits to allow.
        input: { command: "git push origin cogmo/abc" },
      },
      { kind: "complete", exitCode: 0, isError: false },
    ]);

    const inngestSend = vi.fn().mockResolvedValue(undefined);
    const stepWaitForEvent = vi.fn();
    await runCodingExecute({
      taskId: task.id,
      deps: makeDeps({ sandbox, backend }),
      stepRun,
      stepSendEvent,
      stepWaitForEvent,
      inngest: { send: inngestSend } as unknown as Inngest,
    });

    const eventNames = inngestSend.mock.calls.map((c) => c[0].name);
    expect(eventNames).not.toContain("coding/task/permission-requested");
    expect(stepWaitForEvent).not.toHaveBeenCalled();
    expect(handle.responses).toEqual([
      { requestId: "req_push_ap", response: { behavior: "allow" } },
    ]);
    const log = await tx((trx) => store.listToolDecisionsForTask(trx, task.id));
    expect(log).toHaveLength(1);
    expect(log[0]?.decision).toBe("allow");
    expect(log[0]?.scope).toBe("once");
    expect(log[0]?.pattern).toBe("Bash(git push *)");
  });

  it("profile autoapprove=on applies to every prompt-worthy call in the run", async () => {
    // Pins the "resolved once per execute run" optimization at the
    // behavioral layer: every subsequent prompt-worthy permission_request
    // must hit the autoapprove path, not just the first. If a future
    // refactor accidentally moves the resolve onto a per-request path
    // and breaks caching, the wiring still works — but if it accidentally
    // moves to "resolve only for the first call," only this multi-call
    // test would catch that regression.
    const { task } = await seedRepoAndTaskWithAutoapprove();
    const { sandbox } = fakeSandbox();
    const { backend, handle } = fakeBackend([
      { kind: "session_started", sessionId: "sess-x" },
      {
        kind: "permission_request",
        requestId: "req_push_1",
        tool: "Bash",
        input: { command: "git push origin cogmo/abc" },
      },
      {
        kind: "permission_request",
        requestId: "req_publish_1",
        tool: "Bash",
        input: { command: "npm publish" },
      },
      {
        kind: "permission_request",
        requestId: "req_push_2",
        tool: "Bash",
        input: { command: "git push origin cogmo/abc --force-with-lease" },
      },
      { kind: "complete", exitCode: 0, isError: false },
    ]);

    const inngestSend = vi.fn().mockResolvedValue(undefined);
    const stepWaitForEvent = vi.fn();
    await runCodingExecute({
      taskId: task.id,
      deps: makeDeps({ sandbox, backend }),
      stepRun,
      stepSendEvent,
      stepWaitForEvent,
      inngest: { send: inngestSend } as unknown as Inngest,
    });

    expect(inngestSend.mock.calls.map((c) => c[0].name)).not.toContain(
      "coding/task/permission-requested",
    );
    expect(stepWaitForEvent).not.toHaveBeenCalled();
    expect(handle.responses.map((r) => r.response.behavior)).toEqual(["allow", "allow", "allow"]);
    const log = await tx((trx) => store.listToolDecisionsForTask(trx, task.id));
    expect(log).toHaveLength(3);
    expect(log.every((r) => r.decision === "allow" && r.scope === "once")).toBe(true);
  });

  it("decision-log task-scoped deny beats profile autoapprove=on", async () => {
    // Pins the gate's evaluation order: replay first, then policy, then
    // autoapprove. A prior user-tapped "Deny for task" on a pattern
    // must hold even if the profile would otherwise auto-approve.
    const { task } = await seedRepoAndTaskWithAutoapprove();
    await tx((trx) =>
      store.insertToolDecision(trx, {
        taskId: task.id,
        tool: "Bash",
        pattern: "Bash(git push *)",
        decision: "deny",
        scope: "task",
      }),
    );

    const { sandbox } = fakeSandbox();
    const { backend, handle } = fakeBackend([
      { kind: "session_started", sessionId: "sess-x" },
      {
        kind: "permission_request",
        requestId: "req_push_denied",
        tool: "Bash",
        input: { command: "git push origin main" },
      },
      { kind: "complete", exitCode: 0, isError: false },
    ]);

    const inngestSend = vi.fn().mockResolvedValue(undefined);
    const stepWaitForEvent = vi.fn();
    await runCodingExecute({
      taskId: task.id,
      deps: makeDeps({ sandbox, backend }),
      stepRun,
      stepSendEvent,
      stepWaitForEvent,
      inngest: { send: inngestSend } as unknown as Inngest,
    });

    // Replay branch wins — no Telegram round trip, no fresh decision-log
    // row (replay matches return early without persistDecision).
    const eventNames = inngestSend.mock.calls.map((c) => c[0].name);
    expect(eventNames).not.toContain("coding/task/permission-requested");
    expect(stepWaitForEvent).not.toHaveBeenCalled();
    expect(handle.responses[0]?.response).toEqual({ behavior: "deny" });
    const log = await tx((trx) => store.listToolDecisionsForTask(trx, task.id));
    expect(log).toHaveLength(1); // the seeded deny, no new row
    expect(log[0]?.decision).toBe("deny");
    expect(log[0]?.scope).toBe("task");
  });
});
