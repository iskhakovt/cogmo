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
import type { Database } from "../../db/index.js";
import type { Sandbox } from "../../sandbox/index.js";
import { DrizzleSandboxStore } from "../../sandbox/store/index.js";
import type { ResourceLimits } from "../../sandbox/types.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
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
let close: () => Promise<void>;
let store: DrizzleCodingStore;
let sandboxStore: DrizzleSandboxStore;
let baseDir: string;
let instanceId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  store = new DrizzleCodingStore(db);
  sandboxStore = new DrizzleSandboxStore(db);
  baseDir = mkdtempSync(join(tmpdir(), "cogmo-tool-gate-test-"));
});

beforeEach(async () => {
  const inst = await sandboxStore.insertInstance({ host: "h", pid: 1 });
  instanceId = inst.id;
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

// biome-ignore lint/suspicious/noExplicitAny: test shim
const stepRun = ((_: string, fn: () => Promise<unknown>) => fn()) as any;

async function seedRepoAndTask(): Promise<{ repo: CodingRepoRow; task: CodingTaskRow }> {
  const repo = await store.insertRepo({
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
  });
  const task = await store.insertTask({
    repoId: repo.id,
    goal: "test",
    triggerSource: "user",
    backend: "claude",
    allowPrivilegedRunc: false,
  });
  await store.setTaskSessionId(task.id, "sess-x");
  await store.setTaskWorktreeAssignment(task.id, {
    branch: "cogmo/x",
    worktreePath: `${baseDir}/wt`,
  });
  await store.updateTaskStatus({
    id: task.id,
    status: "awaiting_approval",
    planApprovedAt: new Date(),
  });
  const reloaded = (await store.getTask(task.id)) as CodingTaskRow;
  return { repo, task: reloaded };
}

interface FakeBackendHandle {
  events: CodingEvent[];
  responses: Array<{ requestId: string; response: PermissionResponse }>;
}

function fakeBackend(events: CodingEvent[]): { backend: CodingBackend; handle: FakeBackendHandle } {
  const responses: { requestId: string; response: PermissionResponse }[] = [];
  const backend: CodingBackend = {
    // biome-ignore lint/correctness/useYield: stub never reached
    plan: async function* () {
      throw new Error("plan not exercised by this test");
    },
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

function fakeSandbox(): { sandbox: Sandbox; stopCalls: string[] } {
  const stopCalls: string[] = [];
  const sandbox: Sandbox = {
    healthCheck: async () => ({ ok: true, runtime: "runc" }),
    reconcileCrashedInstances: async () => ({ orphansReaped: 0 }),
    createTaskContainer: vi.fn(),
    getTaskContainer: vi.fn(async (id) => ({
      containerRowId: "row-x",
      dockerId: id,
      // biome-ignore lint/suspicious/noExplicitAny: fake
      exec: vi.fn() as any,
    })),
    stopTask: vi.fn(async (id: string) => {
      stopCalls.push(id);
    }),
    listContainersForTask: async () => [
      {
        id: "row-x",
        dockerId: "docker-x",
        parentId: null,
        rootTaskId: "task",
        depth: 0,
        image: "img",
        runtime: "runc",
        labels: {
          "cogmo.managed": "true",
          "cogmo.instance": instanceId,
          "cogmo.root_task": "task",
          "cogmo.parent": "",
          "cogmo.depth": "0",
        },
        resourceLimits: RESOURCE_LIMITS,
        status: "running",
        exitCode: null,
        ttlExpiresAt: new Date(Date.now() + 60_000),
        startedAt: new Date(),
        exitedAt: null,
        instanceId,
        createdAt: new Date(),
      },
    ],
    inspectContainer: async () => ({ status: "running", runtime: "runc" }),
    shutdown: async () => {},
  };
  return { sandbox, stopCalls };
}

function makeDeps(args: { sandbox: Sandbox; backend: CodingBackend }): CodingOrchestratorDeps {
  return {
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
      stepWaitForEvent,
      inngest: { send: inngestSend } as unknown as Inngest,
    });

    // Auto-allow path: no prompt event, no waitForEvent.
    expect(inngestSend).not.toHaveBeenCalled();
    expect(stepWaitForEvent).not.toHaveBeenCalled();
    expect(handle.responses).toEqual([
      { requestId: "req_read_1", response: { behavior: "allow" } },
    ]);
    // Decision logged for audit (scope=once).
    const log = await store.listToolDecisionsForTask(task.id);
    expect(log).toHaveLength(1);
    expect(log[0]?.decision).toBe("allow");
    expect(log[0]?.scope).toBe("once");
    expect(log[0]?.tool).toBe("Read");
  });

  it("replays a task-scoped decision-log entry without prompting", async () => {
    const { task } = await seedRepoAndTask();
    // User previously granted "Allow for task" on git push.
    await store.insertToolDecision({
      taskId: task.id,
      tool: "Bash",
      pattern: "Bash(git push *)",
      decision: "allow",
      scope: "task",
    });

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
      stepWaitForEvent,
      inngest: { send: inngestSend } as unknown as Inngest,
    });

    // Replay path: no prompt, no policy persistence, the task-scoped row
    // wins immediately.
    expect(inngestSend).not.toHaveBeenCalled();
    expect(stepWaitForEvent).not.toHaveBeenCalled();
    expect(handle.responses[0]?.response).toEqual({ behavior: "allow" });
    // Log unchanged (only the seeded task row remains).
    const log = await store.listToolDecisionsForTask(task.id);
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
    const log = await store.listToolDecisionsForTask(task.id);
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
      stepWaitForEvent,
      inngest: { send: inngestSend } as unknown as Inngest,
    });

    expect(handle.responses[0]?.response.behavior).toBe("deny");
    const log = await store.listToolDecisionsForTask(task.id);
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
      stepWaitForEvent,
      inngest: { send: vi.fn().mockResolvedValue(undefined) } as unknown as Inngest,
    });

    expect(handle.responses[0]?.response.behavior).toBe("deny");
    const log = await store.listToolDecisionsForTask(task.id);
    expect(log[0]?.decision).toBe("deny");
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
    const stepWaitForEvent = vi.fn(async () => {
      waitCount += 1;
      if (waitCount === 1) {
        return {
          data: { taskId: task.id, requestId: "req_a", decision: "allow", scope: "task" },
        };
      }
      return {
        data: { taskId: task.id, requestId: "req_b", decision: "deny", scope: "once" },
      };
    });

    await runCodingExecute({
      taskId: task.id,
      deps: makeDeps({ sandbox, backend }),
      stepRun,
      stepWaitForEvent,
      inngest: { send: inngestSend } as unknown as Inngest,
    });

    expect(handle.responses).toHaveLength(2);
    expect(handle.responses[0]?.response.behavior).toBe("allow");
    expect(handle.responses[1]?.response.behavior).toBe("deny");

    const log = await store.listToolDecisionsForTask(task.id);
    expect(log.map((r) => `${r.pattern}/${r.decision}/${r.scope}`)).toEqual([
      "Bash(git push *)/allow/task",
      "Bash(npm publish *)/deny/once",
    ]);
  });
});
