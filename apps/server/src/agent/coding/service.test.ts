import type { Inngest } from "inngest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { expectDefined } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleAgentStore } from "../store/index.js";
import { createCodingService } from "./service.js";
import { DrizzleCodingStore } from "./store/index.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleCodingStore;
let agentStore: DrizzleAgentStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleCodingStore();
  agentStore = new DrizzleAgentStore();
});

// A real conversation per test for `coding_tasks.conversation_id`'s FK —
// reset because afterEach truncates everything.
let conversationId: string;
beforeEach(async () => {
  const user = await tx((trx) => agentStore.createUser(trx));
  const profile = await tx((trx) =>
    agentStore.createProfile(trx, {
      userId: user.id,
      name: "default",
      basePrompt: "p",
      model: "test-model",
      toolSet: [],
    }),
  );
  const conv = await tx((trx) =>
    agentStore.createConversation(trx, { userId: user.id, profileId: profile.id, isPrivate: true }),
  );
  conversationId = conv.id;
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

function fakeInngest(): Pick<Inngest, "send"> & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn().mockResolvedValue({ ids: ["evt-1"] }) };
}

async function seedRepo(name = "cogmo", maxConcurrentTasks = 1): Promise<string> {
  const row = await tx((trx) =>
    store.insertRepo(trx, {
      name,
      localPath: `/var/lib/cogmo/repos/${name}`,
      defaultBranch: "main",
      remoteUrl: `git@github.com:user/${name}.git`,
      devcontainer: null,
      allowedBackends: ["claude"],
      verifyCommand: "pnpm test",
      taskTokenBudget: 200_000,
      taskWallTimeSeconds: 1800,
      maxConcurrentTasks,
    }),
  );
  return row.id;
}

describe("createCodingService", () => {
  it("inserts a queued task and emits coding/task/start", async () => {
    const repoId = await seedRepo("cogmo");
    const inngest = fakeInngest();
    const service = createCodingService(
      {
        runInTx: tx,
        codingStore: store,
        inngest: inngest as unknown as Inngest,
        sandboxAvailable: true,
      },
      conversationId,
    );

    const result = await service.delegate({ goal: "x".repeat(20), repoName: "cogmo" });

    expect(result.status).toBe("queued");
    if (result.status !== "queued") throw new Error("type guard");
    expect(result.taskId).toMatch(/^[0-9a-f-]{36}$/);

    const inserted = await tx((trx) => store.getTask(trx, result.taskId));
    expect(inserted?.repoId).toBe(repoId);
    expect(inserted?.conversationId).toBe(conversationId);
    expect(inserted?.status).toBe("queued");
    expect(inserted?.triggerSource).toBe("user");

    expect(inngest.send).toHaveBeenCalledWith({
      name: "coding/task/start",
      data: { taskId: result.taskId },
      id: `task-start-${result.taskId}`,
    });
  });

  it("rejects when sandbox is unavailable — no task inserted, no event emitted", async () => {
    await seedRepo("cogmo");
    const inngest = fakeInngest();
    const service = createCodingService(
      {
        runInTx: tx,
        codingStore: store,
        inngest: inngest as unknown as Inngest,
        sandboxAvailable: false,
      },
      conversationId,
    );

    await expect(service.delegate({ goal: "x".repeat(20), repoName: "cogmo" })).rejects.toThrow(
      /sandbox module is not initialized/,
    );
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it("throws when the repo is not registered", async () => {
    const inngest = fakeInngest();
    const service = createCodingService(
      {
        runInTx: tx,
        codingStore: store,
        inngest: inngest as unknown as Inngest,
        sandboxAvailable: true,
      },
      conversationId,
    );

    await expect(service.delegate({ goal: "x".repeat(20), repoName: "ghost" })).rejects.toThrow(
      /Repo not registered: ghost/,
    );
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it("rejects when the repo has reached its concurrency cap", async () => {
    const repoId = await seedRepo("cogmo", 1);
    // Seed one already-active task via the store so countActiveTasksForRepo returns 1.
    await tx((trx) =>
      store.insertTask(trx, {
        repoId,
        goal: "g",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      }),
    );

    const inngest = fakeInngest();
    const service = createCodingService(
      {
        runInTx: tx,
        codingStore: store,
        inngest: inngest as unknown as Inngest,
        sandboxAvailable: true,
      },
      conversationId,
    );

    const result = await service.delegate({ goal: "x".repeat(20), repoName: "cogmo" });

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("type guard");
    expect(result.taskId).toBeNull();
    expect(result.reason).toMatch(/active task/);
    expect(result.reason).toMatch(/limit 1/);
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it("marks the task failed and rethrows when inngest.send throws — no orphan in queued", async () => {
    await seedRepo("cogmo");
    const sendErr = new Error("inngest gateway unreachable");
    const inngest = { send: vi.fn().mockRejectedValue(sendErr) };
    const service = createCodingService(
      {
        runInTx: tx,
        codingStore: store,
        inngest: inngest as unknown as Inngest,
        sandboxAvailable: true,
      },
      conversationId,
    );

    await expect(service.delegate({ goal: "x".repeat(20), repoName: "cogmo" })).rejects.toThrow(
      /inngest gateway unreachable/,
    );

    // Without the cleanup, the task would sit in `queued` forever and
    // count against maxConcurrentTasks. Verify the row was marked failed
    // so the admission slot frees up.
    const tasks = await tx((trx) => store.listTasksForConversation(trx, conversationId));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("failed");
    expect(tasks[0]?.failureReason).toMatch(/inngest gateway unreachable/);
  });

  it("recovers the original task when a keyed submission is retried", async () => {
    // The crash window the key exists for: `delegate` runs inside the
    // tool's durable `step.run`, so a process death between this row
    // committing and Inngest recording the step result re-runs the body.
    // Without the key that mints a second task and a second sandbox.
    await seedRepo("cogmo", 1);
    const inngest = fakeInngest();
    const service = createCodingService(
      {
        runInTx: tx,
        codingStore: store,
        inngest: inngest as unknown as Inngest,
        sandboxAvailable: true,
      },
      conversationId,
    );

    const first = await service.delegate({
      goal: "x".repeat(20),
      repoName: "cogmo",
      idempotencyKey: "delegate_coding:inbound-1:i1:p0",
    });
    const retry = await service.delegate({
      goal: "x".repeat(20),
      repoName: "cogmo",
      idempotencyKey: "delegate_coding:inbound-1:i1:p0",
    });

    expect(retry.taskId).toBe(first.taskId);
    expect(retry.status).toBe("recovered");
    const tasks = await tx((trx) => store.listTasksForConversation(trx, conversationId));
    expect(tasks).toHaveLength(1);
    // The recovery re-emits rather than returning early. The prior attempt
    // may have died between the row committing and its send, and skipping
    // the emit would leave the task in `queued` with no orchestrator run.
    // Both emits carry the same idempotency id, so the bus collapses them —
    // and past its dedup window the plan orchestrator's `queued -> planning`
    // transition skips the second run.
    expect(inngest.send).toHaveBeenCalledTimes(2);
    const ids = inngest.send.mock.calls.map(([payload]) => (payload as { id: string }).id);
    expect(ids).toEqual([`task-start-${first.taskId}`, `task-start-${first.taskId}`]);
  });

  it("re-emits on recovery so a submission that died before its send still starts", async () => {
    // The window the re-emit exists for: the row committed and the process
    // died before `inngest.send` ran, so the row is still `queued` and
    // nothing is driving it. Staged directly, because a crash leaves no
    // catch behind to simulate.
    await seedRepo("cogmo", 1);
    const repoId = await tx((trx) => store.getRepoByName(trx, "cogmo")).then(
      (r) => expectDefined(r, "repo").id,
    );
    const key = "delegate_coding:inbound-5:deadbeefdeadbeef";
    const stranded = await tx((trx) =>
      store.insertOrRecoverTask(trx, {
        repoId,
        conversationId,
        goal: "x".repeat(20),
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
        idempotencyKey: key,
      }),
    );

    const inngest = fakeInngest();
    const service = createCodingService(
      {
        runInTx: tx,
        codingStore: store,
        inngest: inngest as unknown as Inngest,
        sandboxAvailable: true,
      },
      conversationId,
    );
    const retry = await service.delegate({
      goal: "x".repeat(20),
      repoName: "cogmo",
      idempotencyKey: key,
    });

    expect(retry).toEqual({ taskId: stranded.row.id, status: "recovered", priorStatus: "queued" });
    expect(inngest.send).toHaveBeenCalledTimes(1);
    const tasks = await tx((trx) => store.listTasksForConversation(trx, conversationId));
    expect(tasks).toHaveLength(1);
  });

  it("frees the slot when the re-emit for a recovered `queued` row fails", async () => {
    // The recovery path re-emits for a row nothing is driving. If that send
    // throws, the row must not be left `queued`: it counts against
    // `maxConcurrentTasks` (default 1, so the repo is blocked), no
    // `inngest/function.failed` fires so reconcile never looks at it, and
    // nothing retries with this key — `handle-message` converts every
    // `tool-iter*` throw to `NonRetriableError`, and the model's own retry
    // gets fresh coordinates and therefore a fresh key.
    await seedRepo("cogmo", 1);
    const repoId = await tx((trx) => store.getRepoByName(trx, "cogmo")).then(
      (r) => expectDefined(r, "repo").id,
    );
    const key = "delegate_coding:inbound-9:beefbeefbeefbeef";
    const stranded = await tx((trx) =>
      store.insertOrRecoverTask(trx, {
        repoId,
        conversationId,
        goal: "x".repeat(20),
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
        idempotencyKey: key,
      }),
    );

    const inngest = { send: vi.fn().mockRejectedValue(new Error("bus down")) };
    const service = createCodingService(
      {
        runInTx: tx,
        codingStore: store,
        inngest: inngest as unknown as Inngest,
        sandboxAvailable: true,
      },
      conversationId,
    );

    await expect(
      service.delegate({ goal: "x".repeat(20), repoName: "cogmo", idempotencyKey: key }),
    ).rejects.toThrow(/bus down/);

    const reloaded = expectDefined(
      await tx((trx) => store.getTask(trx, stranded.row.id)),
      "recovered task",
    );
    expect(reloaded.status).toBe("failed");
    // Terminal, so the repo's single admission slot is free again.
    expect(await tx((trx) => store.countActiveTasksForRepo(trx, repoId))).toBe(0);
  });

  it("keeps the idempotency key when a send failure fails the row", async () => {
    // A throw from `inngest.send` is ambiguous — the bus may have accepted the
    // event and failed only on the response. Releasing the key would let a
    // retry mint a second task while the accepted event still drives the
    // first, which is the duplicate sandbox this key exists to prevent. So the
    // key stays, the retry recovers the failed row, and the model is told
    // honestly. One task either way, and the slot frees because the row is
    // terminal.
    await seedRepo("cogmo", 2);
    const inngest = { send: vi.fn().mockRejectedValueOnce(new Error("bus down")) };
    const service = createCodingService(
      {
        runInTx: tx,
        codingStore: store,
        inngest: inngest as unknown as Inngest,
        sandboxAvailable: true,
      },
      conversationId,
    );

    const key = "delegate_coding:inbound-8:cafecafecafecafe";
    await expect(
      service.delegate({ goal: "x".repeat(20), repoName: "cogmo", idempotencyKey: key }),
    ).rejects.toThrow(/bus down/);
    const failed = expectDefined(
      await tx((trx) => store.getTaskByIdempotencyKey(trx, key)),
      "failed task",
    );
    expect(failed.status).toBe("failed");

    inngest.send.mockResolvedValue(undefined);
    const retry = await service.delegate({
      goal: "x".repeat(20),
      repoName: "cogmo",
      idempotencyKey: key,
    });

    expect(retry).toEqual({ taskId: failed.id, status: "recovered", priorStatus: "failed" });
    const tasks = await tx((trx) => store.listTasksForConversation(trx, conversationId));
    expect(tasks).toHaveLength(1);
    // Not re-emitted: a terminal row can't be driven, and the accepted-event
    // case is already covered by the orchestrator's `queued -> planning` claim.
    expect(inngest.send).toHaveBeenCalledTimes(1);
  });

  it("recovers rather than tripping the concurrency cap on retry", async () => {
    // The retry's own task counts against `maxConcurrentTasks`, so a
    // recovery check placed after the admission count would reject the
    // submission it is supposed to recover. With a cap of 1 that is the
    // common case, not an edge one.
    await seedRepo("cogmo", 1);
    const inngest = fakeInngest();
    const service = createCodingService(
      {
        runInTx: tx,
        codingStore: store,
        inngest: inngest as unknown as Inngest,
        sandboxAvailable: true,
      },
      conversationId,
    );

    const first = await service.delegate({
      goal: "x".repeat(20),
      repoName: "cogmo",
      idempotencyKey: "delegate_coding:inbound-2:i1:p0",
    });
    const retry = await service.delegate({
      goal: "x".repeat(20),
      repoName: "cogmo",
      idempotencyKey: "delegate_coding:inbound-2:i1:p0",
    });

    expect(retry.status).toBe("recovered");
    expect(retry.taskId).toBe(first.taskId);
  });

  it("reports a recovered task's real status instead of claiming it is queued", async () => {
    // A terminal task recovered by its key will never run again. Announcing
    // it as freshly `queued` would have the model tell the user work is
    // under way that is not.
    await seedRepo("cogmo", 2);
    const inngest = fakeInngest();
    const service = createCodingService(
      {
        runInTx: tx,
        codingStore: store,
        inngest: inngest as unknown as Inngest,
        sandboxAvailable: true,
      },
      conversationId,
    );

    const key = "delegate_coding:inbound-6:i1:p0";
    const first = await service.delegate({
      goal: "x".repeat(20),
      repoName: "cogmo",
      idempotencyKey: key,
    });
    const taskId = expectDefined(first.taskId, "first taskId");
    await tx((trx) =>
      store.updateTaskStatus(trx, { id: taskId, status: "failed", failureReason: "boom" }),
    );
    inngest.send.mockClear();

    const retry = await service.delegate({
      goal: "x".repeat(20),
      repoName: "cogmo",
      idempotencyKey: key,
    });

    expect(retry).toEqual({ taskId, status: "recovered", priorStatus: "failed" });
    // Not re-emitted — the plan orchestrator only claims `queued` rows, so a
    // re-send could only be skipped, and the row is terminal regardless.
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it("does not mark an in-flight recovered task failed when its re-emit throws", async () => {
    // The send-failure cleanup is an unguarded `UPDATE ... WHERE id`. Running
    // it on a recovered row would fail a live orchestration or corrupt a
    // finished one, so it must belong to freshly admitted tasks only.
    await seedRepo("cogmo", 2);
    const inngest = { send: vi.fn().mockResolvedValue(undefined) };
    const service = createCodingService(
      {
        runInTx: tx,
        codingStore: store,
        inngest: inngest as unknown as Inngest,
        sandboxAvailable: true,
      },
      conversationId,
    );

    const key = "delegate_coding:inbound-7:i1:p0";
    const first = await service.delegate({
      goal: "x".repeat(20),
      repoName: "cogmo",
      idempotencyKey: key,
    });
    const taskId = expectDefined(first.taskId, "first taskId");
    // The orchestrator picked it up and is mid-plan.
    await tx((trx) => store.updateTaskStatus(trx, { id: taskId, status: "planning" }));
    inngest.send.mockRejectedValue(new Error("bus down"));

    const retry = await service.delegate({
      goal: "x".repeat(20),
      repoName: "cogmo",
      idempotencyKey: key,
    });

    // A started task is reported, never re-emitted — so the failing send is
    // never even reached, and the live run keeps its status.
    expect(retry).toEqual({ taskId, status: "recovered", priorStatus: "planning" });
    const reloaded = await tx((trx) => store.getTask(trx, taskId));
    expect(reloaded?.status).toBe("planning");
  });

  it("keeps distinct submissions distinct — different keys, different tasks", async () => {
    await seedRepo("cogmo", 5);
    const inngest = fakeInngest();
    const service = createCodingService(
      {
        runInTx: tx,
        codingStore: store,
        inngest: inngest as unknown as Inngest,
        sandboxAvailable: true,
      },
      conversationId,
    );

    const a = await service.delegate({
      goal: "x".repeat(20),
      repoName: "cogmo",
      idempotencyKey: "delegate_coding:inbound-3:i1:p0",
    });
    // Same goal, same conversation, next turn — a genuinely new request.
    const b = await service.delegate({
      goal: "x".repeat(20),
      repoName: "cogmo",
      idempotencyKey: "delegate_coding:inbound-4:i1:p0",
    });

    expect(b.taskId).not.toBe(a.taskId);
    const tasks = await tx((trx) => store.listTasksForConversation(trx, conversationId));
    expect(tasks).toHaveLength(2);
  });

  it("admits a second task when the cap allows it", async () => {
    const repoId = await seedRepo("cogmo", 2);
    await tx((trx) =>
      store.insertTask(trx, {
        repoId,
        goal: "first",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      }),
    );

    const inngest = fakeInngest();
    const service = createCodingService(
      {
        runInTx: tx,
        codingStore: store,
        inngest: inngest as unknown as Inngest,
        sandboxAvailable: true,
      },
      conversationId,
    );

    const result = await service.delegate({ goal: "x".repeat(20), repoName: "cogmo" });
    expect(result.status).toBe("queued");
    expect(inngest.send).toHaveBeenCalledTimes(1);
  });
});
