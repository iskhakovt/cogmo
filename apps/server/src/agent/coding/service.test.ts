import type { Inngest } from "inngest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
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
