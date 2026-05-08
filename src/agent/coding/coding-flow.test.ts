import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import type {
  ExecStreamingHandle,
  LocalDockerSessionState,
  SandboxClient,
  SandboxSession,
} from "../../sandbox/index.js";
import { DrizzleSandboxStore } from "../../sandbox/store/index.js";
import { mockAgentStore, mockTransportStore } from "../../test/factories.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { createTransport } from "../../transport/transport.js";
import type { CodingBackend, CodingEvent } from "./backend.js";
import {
  type ExecuteStreamHandle,
  type PlanStreamHandle,
  runCodingExecute,
  runCodingTask,
  type StepRun,
} from "./orchestrator.js";
import { CodingProgressSubscriber } from "./progress-subscriber.js";
import { createCodingService } from "./service.js";
import { DrizzleCodingStore } from "./store/index.js";
import { type CodingStreamEvent, CodingStreamingRegistry } from "./streaming-registry.js";

const execFileP = promisify(execFile);

// biome-ignore lint/suspicious/noExplicitAny: stepRun shim mirrors Inngest's signature
const stepRun = ((_: string, fn: () => Promise<unknown>) => fn()) as any as StepRun;
const RESOURCE_LIMITS = { cpus: 0.5, memory_bytes: 256 * 1024 * 1024, pids: 64 };

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleCodingStore;
let sandboxStore: DrizzleSandboxStore;
let baseDir: string;
let repoPath: string;
let instanceId: string;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleCodingStore(tx);
  sandboxStore = new DrizzleSandboxStore(tx);

  baseDir = mkdtempSync(join(tmpdir(), "cogmo-flow-test-"));
  repoPath = join(baseDir, "repo");
  await execFileP("git", ["init", "--initial-branch=main", repoPath]);
  await execFileP("git", ["-C", repoPath, "config", "user.email", "t@t"]);
  await execFileP("git", ["-C", repoPath, "config", "user.name", "t"]);
  await execFileP("git", ["-C", repoPath, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(repoPath, "README.md"), "x");
  await execFileP("git", ["-C", repoPath, "add", "."]);
  await execFileP("git", ["-C", repoPath, "commit", "-m", "init"]);
});

beforeEach(async () => {
  await truncateAll(db);
  instanceId = (await sandboxStore.insertInstance({ host: "test", pid: 1 })).id;
});

afterAll(async () => {
  rmSync(baseDir, { recursive: true, force: true });
  await close();
});

/**
 * Backend driver that yields different events for plan vs execute. Both
 * generators capture the orchestrator-supplied container so the test can
 * assert it's the same handle across phases (container reuse).
 */
function flowBackend(args: {
  planEvents: CodingEvent[];
  executeEvents: CodingEvent[];
}): CodingBackend {
  return {
    plan: async function* () {
      for (const ev of args.planEvents) yield ev;
    },
    execute: async () => ({
      events: (async function* () {
        for (const ev of args.executeEvents) yield ev;
      })(),
      respondPermission: async () => {},
    }),
  };
}

function fakeSandbox(): {
  sandbox: SandboxClient<LocalDockerSessionState>;
  createCalls: string[];
  stopCalls: string[];
  liveContainerDockerIds: Set<string>;
} {
  const createCalls: string[] = [];
  const stopCalls: string[] = [];
  const liveContainerDockerIds = new Set<string>();
  let lastSessionState: LocalDockerSessionState | null = null;

  const exec = (): ExecStreamingHandle => ({
    stdout: process.stdin,
    stderr: process.stdin,
    wait: async () => ({ exitCode: 0 }),
    dispose: async () => {},
  });

  function makeSession(state: LocalDockerSessionState): SandboxSession<LocalDockerSessionState> {
    return {
      state,
      execStreaming: vi.fn(async () => exec()),
      exec: vi.fn(async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
        wallTimeSeconds: 0,
        truncated: false,
      })),
    };
  }

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
    create: vi.fn(async (spec) => {
      createCalls.push(spec.taskId);
      const row = await sandboxStore.insertContainer({
        dockerId: `docker-${Math.random().toString(36).slice(2)}`,
        parentId: null,
        rootTaskId: spec.taskId,
        depth: 0,
        image: spec.image,
        runtime: "runc",
        labels: {
          "cogmo.managed": "true",
          "cogmo.instance": instanceId,
          "cogmo.root_task": spec.taskId,
          "cogmo.parent": "",
          "cogmo.depth": "0",
        },
        resourceLimits: spec.resourceLimits,
        ttlExpiresAt: spec.expiresAt,
        instanceId,
      });
      await sandboxStore.updateContainerStatus({ id: row.id, status: "running" });
      liveContainerDockerIds.add(row.dockerId);
      lastSessionState = {
        type: "local-docker",
        taskId: spec.taskId,
        containerRowId: row.id,
        dockerId: row.dockerId,
      };
      return makeSession(lastSessionState);
    }),
    resume: vi.fn(async (state) => makeSession(state)),
    tryResumeByTaskId: vi.fn(async (_taskId) => {
      // Reuse path: return a session for the most-recently-created live
      // container, mirroring production behaviour.
      if (lastSessionState && liveContainerDockerIds.has(lastSessionState.dockerId)) {
        return makeSession(lastSessionState);
      }
      return null;
    }),
    delete: vi.fn(async () => {}),
    deleteByTaskId: vi.fn(async (taskId) => {
      stopCalls.push(taskId);
    }),
    serializeState: (state) => state as unknown as Record<string, unknown>,
    deserializeState: (payload) => payload as unknown as LocalDockerSessionState,
    shutdown: async () => {},
  };

  return { sandbox, createCalls, stopCalls, liveContainerDockerIds };
}

describe("coding flow — plan → approve → execute → pending_verify", () => {
  it("end-to-end: delegate submits, plan posts, approve fires execute, status reaches pending_verify", async () => {
    // ── Setup ──────────────────────────────────────────────────────────
    const _repo = await store.insertRepo({
      name: "cogmo",
      localPath: repoPath,
      defaultBranch: "main",
      remoteUrl: "git@github.com:user/cogmo.git",
      devcontainer: null,
      allowedBackends: ["claude"],
      verifyCommand: "true",
      taskTokenBudget: 100_000,
      taskWallTimeSeconds: 600,
      maxConcurrentTasks: 1,
    });

    const conversationId = "019d0000-0000-7000-8000-000000000001";
    const ownerUserId = "user-owner";

    const { sandbox, createCalls, stopCalls, liveContainerDockerIds } = fakeSandbox();
    const registry = new CodingStreamingRegistry();
    const collected: CodingStreamEvent[] = [];

    // ── Step 1: delegate via Service.coding ────────────────────────────
    // Use the real service so the admission check + insert path is
    // exercised. Inngest is a stub here — we drive the orchestrator
    // directly below to keep the test in-process.
    const inngestSend = vi.fn().mockResolvedValue({ ids: ["evt-start"] });
    const service = createCodingService(
      {
        codingStore: store,
        // biome-ignore lint/suspicious/noExplicitAny: minimal Inngest stub
        inngest: { send: inngestSend } as any,
        sandboxAvailable: true,
      },
      conversationId,
    );

    const submitResult = await service.delegate({
      goal: "x".repeat(20),
      repoName: "cogmo",
    });
    expect(submitResult.status).toBe("queued");
    if (submitResult.status !== "queued") throw new Error("type guard");
    const taskId = submitResult.taskId;

    // delegate emitted the start event — Inngest would consume it. Assert
    // the contract before advancing.
    expect(inngestSend).toHaveBeenCalledWith({
      name: "coding/task/start",
      data: { taskId },
    });

    // Subscribe the test observer to the registry so we can see what the
    // Telegram subscriber would have rendered.
    registry.subscribe(taskId, (e) => collected.push(e));

    // ── Step 2: orchestrator runs the plan flow ────────────────────────
    const backend = flowBackend({
      planEvents: [
        { kind: "session_started", sessionId: "sess-from-plan" },
        { kind: "text_delta", text: "## Plan\n" },
        { kind: "text_delta", text: "1. Edit foo.ts\n" },
        { kind: "plan_ready", plan: "## Plan\n1. Edit foo.ts\n" },
        { kind: "complete", exitCode: 0, isError: false },
      ],
      executeEvents: [
        { kind: "session_started", sessionId: "sess-from-plan" },
        { kind: "text_delta", text: "Editing foo.ts...\n" },
        { kind: "tool_call", tool: "Edit", input: { file_path: "foo.ts" } },
        { kind: "tool_result", tool: "Edit", ok: true, summary: "wrote 1 line" },
        {
          kind: "complete",
          exitCode: 0,
          isError: false,
          usage: { inputTokens: 250, outputTokens: 50, costUsd: 0.012 },
        },
      ],
    });

    const planStream: PlanStreamHandle = {
      appendText: async (delta) => registry.publish(taskId, { kind: "text", delta }),
      finalize: async (plan) => registry.publish(taskId, { kind: "plan_finalized", plan }),
      fail: async (reason) => registry.publish(taskId, { kind: "failed", reason }),
    };

    const planResult = await runCodingTask({
      taskId,
      deps: {
        store,
        sandbox,
        backend,
        devbaseImage: "cogmo/devbase:test",
        defaultResourceLimits: RESOURCE_LIMITS,
        taskTtlMs: 60_000,
        worktreesDir: join(baseDir, "worktrees"),
        openPlanStream: async () => planStream,
      },
      stepRun,
    });

    expect(planResult.status).toBe("awaiting_approval");
    expect(planResult.plan).toBe("## Plan\n1. Edit foo.ts\n");

    const afterPlan = await store.getTask(taskId);
    expect(afterPlan?.status).toBe("awaiting_approval");
    expect(afterPlan?.sessionId).toBe("sess-from-plan");
    expect(afterPlan?.plan).toBe("## Plan\n1. Edit foo.ts\n");
    expect(afterPlan?.worktreeAssignment).not.toBeNull();
    expect(afterPlan?.containerId).not.toBeNull();
    expect(createCalls).toEqual([taskId]);

    // ── Step 3: approve via Transport.coding (same path as Telegram callback) ──
    // Build a Transport with the right identity wiring. The tapper's
    // platform handle resolves to the conversation owner via mocked
    // resolveUser, so the identity check passes.
    const transportInngestSend = vi.fn().mockResolvedValue({ ids: ["evt-approved"] });
    const transport = createTransport({
      channelId: "ch-1",
      defaultUserId: ownerUserId,
      defaultProfileId: "profile-1",
      transportStore: mockTransportStore({
        resolveUser: vi.fn().mockResolvedValue({ userId: ownerUserId }),
      }),
      agentStore: mockAgentStore({
        getConversation: vi.fn().mockResolvedValue({
          id: conversationId,
          userId: ownerUserId,
          profileId: "p",
          isPrivate: true,
        }),
      }),
      codingStore: store,
      // biome-ignore lint/suspicious/noExplicitAny: minimal Inngest stub
      inngest: { send: transportInngestSend } as any,
      // biome-ignore lint/suspicious/noExplicitAny: not exercised
      inboundArrived: { create: vi.fn() } as any,
      // biome-ignore lint/suspicious/noExplicitAny: not exercised
      attachments: {} as any,
      idleTimeoutMs: 0,
    });

    const approveResult = await transport.coding.approvePlan(taskId, "owner-tg-id");
    expect(approveResult.isOk()).toBe(true);
    expect(transportInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "coding/task/plan-approved",
        data: expect.objectContaining({ taskId }),
      }),
    );

    const afterApprove = await store.getTask(taskId);
    expect(afterApprove?.planApprovedAt).toBeInstanceOf(Date);
    expect(afterApprove?.status).toBe("awaiting_approval"); // unchanged until execute starts

    // ── Step 4: execute orchestrator runs (would be triggered by the event) ──
    // Container is still alive (TTL hasn't expired), so reuse path runs —
    // no second createTaskContainer call.
    const executeStream: ExecuteStreamHandle = {
      started: async () => registry.publish(taskId, { kind: "execute_started" }),
      appendText: async (delta) => registry.publish(taskId, { kind: "text", delta }),
      toolCall: async (tool) => registry.publish(taskId, { kind: "tool_call", tool }),
      toolResult: async (tool, ok, summary) =>
        registry.publish(taskId, {
          kind: "tool_result",
          tool,
          ok,
          ...(summary !== undefined && { summary }),
        }),
      complete: async (ok, tokens) =>
        registry.publish(taskId, {
          kind: "execute_complete",
          ok,
          ...(tokens !== undefined && { tokens }),
        }),
      fail: async (reason) => registry.publish(taskId, { kind: "failed", reason }),
    };

    const executeResult = await runCodingExecute({
      taskId,
      deps: {
        store,
        sandbox,
        backend,
        devbaseImage: "cogmo/devbase:test",
        defaultResourceLimits: RESOURCE_LIMITS,
        taskTtlMs: 60_000,
        worktreesDir: join(baseDir, "worktrees"),
        openExecuteStream: async () => executeStream,
      },
      stepRun,
      // biome-ignore lint/suspicious/noExplicitAny: test shim — never awaited
      stepWaitForEvent: (async () => null) as any,
      inngest: { send: vi.fn().mockResolvedValue(undefined) },
    });

    expect(executeResult.status).toBe("pending_verify");

    const afterExecute = await store.getTask(taskId);
    expect(afterExecute?.status).toBe("pending_verify");
    expect(afterExecute?.resourceUsage).toEqual({
      tokens_input: 250,
      tokens_output: 50,
      cost_usd: 0.012,
    });

    // Container reused, not recreated. stopTask called for teardown.
    expect(createCalls).toEqual([taskId]); // no second create
    expect(stopCalls).toEqual([taskId]);
    expect(liveContainerDockerIds.size).toBe(1);

    // ── Step 5: registry produced the expected event sequence ──────────
    const kinds = collected.map((e) => e.kind);
    // Plan phase: text deltas + plan_finalized
    expect(kinds).toContain("text");
    expect(kinds).toContain("plan_finalized");
    // Execute phase: started + text + tool_call + tool_result + complete
    expect(kinds).toContain("execute_started");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("execute_complete");

    // The execute_complete event carried tokens — what 2.0g's subscriber
    // surfaces as the final status line.
    const completeEvent = collected.find((e) => e.kind === "execute_complete");
    expect(completeEvent).toMatchObject({
      kind: "execute_complete",
      ok: true,
      tokens: { input: 250, output: 50 },
    });
  });

  it("approve from a different user is rejected; task stays awaiting_approval, no event emitted", async () => {
    const repo = await store.insertRepo({
      name: "cogmo",
      localPath: repoPath,
      defaultBranch: "main",
      remoteUrl: "git@github.com:user/cogmo.git",
      devcontainer: null,
      allowedBackends: ["claude"],
      verifyCommand: "true",
      taskTokenBudget: 100_000,
      taskWallTimeSeconds: 600,
      maxConcurrentTasks: 1,
    });

    const conversationId = "019d0000-0000-7000-8000-000000000002";
    const task = await store.insertTask({
      repoId: repo.id,
      conversationId,
      goal: "g",
      triggerSource: "user",
      backend: "claude",
      allowPrivilegedRunc: false,
    });
    await store.updateTaskStatus({ id: task.id, status: "awaiting_approval" });

    const transportInngestSend = vi.fn();
    const transport = createTransport({
      channelId: "ch-1",
      defaultUserId: "owner",
      defaultProfileId: "p",
      transportStore: mockTransportStore({
        resolveUser: vi.fn().mockResolvedValue({ userId: "different-user" }),
      }),
      agentStore: mockAgentStore({
        getConversation: vi.fn().mockResolvedValue({
          id: conversationId,
          userId: "owner",
          profileId: "p",
          isPrivate: true,
        }),
      }),
      codingStore: store,
      // biome-ignore lint/suspicious/noExplicitAny: minimal Inngest stub
      inngest: { send: transportInngestSend } as any,
      // biome-ignore lint/suspicious/noExplicitAny: not exercised
      inboundArrived: { create: vi.fn() } as any,
      // biome-ignore lint/suspicious/noExplicitAny: not exercised
      attachments: {} as any,
      idleTimeoutMs: 0,
    });

    const result = await transport.coding.approvePlan(task.id, "stranger-tg-id");
    expect(result._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    expect(transportInngestSend).not.toHaveBeenCalled();

    const reloaded = await store.getTask(task.id);
    expect(reloaded?.planApprovedAt).toBeNull();
    expect(reloaded?.status).toBe("awaiting_approval");
  });

  it("CodingProgressSubscriber renders the plan + execute message lifecycle from the same registry", async () => {
    const registry = new CodingStreamingRegistry();
    const sent: { text: string; replyMarkup?: unknown }[] = [];
    const edits: { text: string; replyMarkup?: unknown }[] = [];
    const taskId = "019d0000-0000-7000-8000-000000000003";

    CodingProgressSubscriber.start({
      taskId,
      chatId: 100,
      goal: "ship the slice",
      channelId: "ch-1",
      bot: {
        sendMessage: vi.fn(async (_, text, opts) => {
          sent.push({
            text,
            ...(opts?.reply_markup && { replyMarkup: opts.reply_markup }),
          });
          return { message_id: 7 };
        }),
        editMessageText: vi.fn(async (_chat, _msg, text, opts) => {
          edits.push({
            text,
            ...(opts?.reply_markup && { replyMarkup: opts.reply_markup }),
          });
          return {};
        }),
      },
      registry,
      editIntervalMs: 0,
    });

    // Drive the same event stream the orchestrator emits.
    registry.publish(taskId, { kind: "text", delta: "drafting..." });
    await tick();
    registry.publish(taskId, {
      kind: "plan_finalized",
      plan: "## Plan\nedit foo",
    });
    await tick();
    registry.publish(taskId, { kind: "execute_started" });
    await tick();
    registry.publish(taskId, { kind: "tool_call", tool: "Edit" });
    await tick();
    registry.publish(taskId, {
      kind: "execute_complete",
      ok: true,
      tokens: { input: 100, output: 20 },
    });
    await tick();

    expect(sent).toHaveLength(1); // single message, edited in place from then on
    const final = edits.at(-1);
    expect(final?.text).toContain("Execute done");
    expect(final?.text).toContain("120 tokens");
    // The plan_finalized edit attached the keyboard.
    expect(edits.some((e) => Boolean(e.replyMarkup))).toBe(true);
  });
});

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
