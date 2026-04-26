import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../../db/index.js";
import { DrizzleSandboxStore } from "../../../sandbox/store/index.js";
import type { ContainerLabels, ResourceLimits } from "../../../sandbox/types.js";
import { createTestDatabase, truncateAll } from "../../../test/pglite.js";
import { type CodingBackend, type CodingTaskStatus, DrizzleCodingStore } from "./index.js";

let db: Database;
let close: () => Promise<void>;
let store: DrizzleCodingStore;
let sandboxStore: DrizzleSandboxStore;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  store = new DrizzleCodingStore(db);
  sandboxStore = new DrizzleSandboxStore(db);
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

const RESOURCE_LIMITS: ResourceLimits = {
  cpus: 2,
  memory_bytes: 2 * 1024 * 1024 * 1024,
  pids: 256,
};

const REPO_DEFAULTS = {
  defaultBranch: "main",
  remoteUrl: "git@github.com:user/cogmo.git",
  devcontainer: null,
  allowedBackends: ["claude"] as ReadonlyArray<CodingBackend>,
  verifyCommand: "pnpm typecheck && pnpm lint && pnpm test",
  taskTokenBudget: 200_000,
  taskWallTimeSeconds: 1800,
  maxConcurrentTasks: 1,
};

async function seedRepo(name = "cogmo"): Promise<string> {
  const row = await store.insertRepo({
    name,
    localPath: `/var/lib/cogmo/repos/${name}`,
    ...REPO_DEFAULTS,
  });
  return row.id;
}

function labels(extra: Partial<ContainerLabels> = {}): ContainerLabels {
  return {
    "cogmo.managed": "true",
    "cogmo.instance": "i",
    "cogmo.root_task": "t",
    "cogmo.parent": "",
    "cogmo.depth": "0",
    ...extra,
  };
}

async function seedContainer(): Promise<string> {
  const inst = await sandboxStore.insertInstance({ host: "h", pid: 1 });
  const c = await sandboxStore.insertContainer({
    dockerId: `d-${Math.random().toString(36).slice(2)}`,
    parentId: null,
    rootTaskId: "019d0000-0000-7000-8000-00000000abcd",
    depth: 0,
    image: "cogmo/devbase:slice1",
    runtime: "sysbox-runc",
    labels: labels(),
    resourceLimits: RESOURCE_LIMITS,
    ttlExpiresAt: new Date(Date.now() + 60_000),
    instanceId: inst.id,
  });
  return c.id;
}

describe("DrizzleCodingStore", () => {
  describe("repos", () => {
    it("inserts and retrieves a repo with parsed JSONB defaults", async () => {
      const row = await store.insertRepo({
        name: "cogmo",
        localPath: "/var/lib/cogmo/repos/cogmo",
        ...REPO_DEFAULTS,
      });
      expect(row.name).toBe("cogmo");
      expect(row.allowedBackends).toEqual(["claude"]);
      expect(row.devcontainer).toBeNull();
      expect(row.maxConcurrentTasks).toBe(1);

      const byName = await store.getRepoByName("cogmo");
      expect(byName?.id).toBe(row.id);
      const byId = await store.getRepoById(row.id);
      expect(byId?.name).toBe("cogmo");
    });

    it("rejects duplicate repo name", async () => {
      await seedRepo();
      await expect(seedRepo()).rejects.toThrow();
    });

    it("stores and round-trips devcontainer JSONB", async () => {
      const row = await store.insertRepo({
        name: "with-dev",
        localPath: "/repos/with-dev",
        ...REPO_DEFAULTS,
        devcontainer: {
          image: "ghcr.io/example/devcontainer:1",
          features: { "ghcr.io/devcontainers/features/node:1": { version: "24" } },
          postCreateCommand: ["pnpm", "install"],
          forwardPorts: [3000, "5432:5432"],
        },
      });
      expect(row.devcontainer?.image).toBe("ghcr.io/example/devcontainer:1");
      const reloaded = await store.getRepoById(row.id);
      expect(reloaded?.devcontainer?.forwardPorts).toEqual([3000, "5432:5432"]);
    });

    it("supports both backends in allowedBackends", async () => {
      const row = await store.insertRepo({
        name: "multi",
        localPath: "/repos/multi",
        ...REPO_DEFAULTS,
        allowedBackends: ["claude", "codex"],
      });
      expect(row.allowedBackends).toEqual(["claude", "codex"]);
    });

    it("listRepos returns rows in name order", async () => {
      await seedRepo("zebra");
      await seedRepo("alpha");
      await seedRepo("mid");
      const rows = await store.listRepos();
      expect(rows.map((r) => r.name)).toEqual(["alpha", "mid", "zebra"]);
    });

    it("removeRepo deletes the row", async () => {
      const id = await seedRepo();
      await store.removeRepo(id);
      expect(await store.getRepoById(id)).toBeNull();
    });

    it("getRepoByName returns null for unknown name", async () => {
      expect(await store.getRepoByName("nope")).toBeNull();
    });
  });

  describe("tasks", () => {
    it("inserts a task in queued status with nullable fields null", async () => {
      const repoId = await seedRepo();
      const row = await store.insertTask({
        repoId,
        goal: "refactor steering rules",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      });
      expect(row.status).toBe("queued");
      expect(row.goal).toBe("refactor steering rules");
      expect(row.triggerSource).toBe("user");
      expect(row.triggerRef).toBeNull();
      expect(row.sessionId).toBeNull();
      expect(row.containerId).toBeNull();
      expect(row.worktreeAssignment).toBeNull();
      expect(row.plan).toBeNull();
      expect(row.planApprovedAt).toBeNull();
      expect(row.prUrl).toBeNull();
      expect(row.failureReason).toBeNull();
      expect(row.resourceUsage).toBeNull();
      expect(row.allowPrivilegedRunc).toBe(false);
    });

    it("setTaskWorktreeAssignment persists branch + worktreePath atomically as JSONB", async () => {
      const repoId = await seedRepo();
      const t = await store.insertTask({
        repoId,
        goal: "g",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      });
      await store.setTaskWorktreeAssignment(t.id, {
        branch: "cogmo/abc12345",
        worktreePath: "/var/lib/cogmo/worktrees/cogmo/abc12345",
      });
      const reloaded = await store.getTask(t.id);
      expect(reloaded?.worktreeAssignment).toEqual({
        branch: "cogmo/abc12345",
        worktreePath: "/var/lib/cogmo/worktrees/cogmo/abc12345",
      });
    });

    it("setTaskWorktreeAssignment is idempotent — second call replaces with the second value", async () => {
      // Models the orchestrator-retry path: if `allocate-worktree` runs
      // twice (first attempt persisted assignment then crashed before
      // returning), the second run derives the same branch/path from the
      // same task id and writes again. Last write wins; the task ends up
      // in the right state either way.
      const repoId = await seedRepo();
      const t = await store.insertTask({
        repoId,
        goal: "g",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      });
      await store.setTaskWorktreeAssignment(t.id, {
        branch: "cogmo/aaaa",
        worktreePath: "/p1",
      });
      await store.setTaskWorktreeAssignment(t.id, {
        branch: "cogmo/aaaa",
        worktreePath: "/p1",
      });
      const reloaded = await store.getTask(t.id);
      expect(reloaded?.worktreeAssignment).toEqual({
        branch: "cogmo/aaaa",
        worktreePath: "/p1",
      });
    });

    it("setTaskWorktreeAssignment rejects empty branch (Zod schema)", async () => {
      const repoId = await seedRepo();
      const t = await store.insertTask({
        repoId,
        goal: "g",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      });
      await expect(
        store.setTaskWorktreeAssignment(t.id, { branch: "", worktreePath: "/p" }),
      ).rejects.toThrow();
    });

    it("rejects task with non-existent repo (FK)", async () => {
      await expect(
        store.insertTask({
          repoId: "019d0000-0000-7000-8000-0000000000ff",
          goal: "x",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      ).rejects.toThrow();
    });

    it("updateTaskStatus transitions through states with optional fields", async () => {
      const repoId = await seedRepo();
      const t = await store.insertTask({
        repoId,
        goal: "g",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      });

      await store.updateTaskStatus({ id: t.id, status: "planning" });
      expect((await store.getTask(t.id))?.status).toBe("planning");

      const approvedAt = new Date("2026-04-26T10:00:00Z");
      await store.updateTaskStatus({
        id: t.id,
        status: "executing",
        planApprovedAt: approvedAt,
      });
      const after = await store.getTask(t.id);
      expect(after?.status).toBe("executing");
      expect(after?.planApprovedAt?.toISOString()).toBe(approvedAt.toISOString());

      await store.updateTaskStatus({
        id: t.id,
        status: "failed",
        failureReason: "verify failed: 3 tests",
      });
      const failed = await store.getTask(t.id);
      expect(failed?.status).toBe("failed");
      expect(failed?.failureReason).toBe("verify failed: 3 tests");
    });

    it("setTaskSessionId / setTaskContainerId / setTaskPlan / setTaskPrUrl persist their fields", async () => {
      const repoId = await seedRepo();
      const t = await store.insertTask({
        repoId,
        goal: "g",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      });
      const containerId = await seedContainer();

      await store.setTaskSessionId(t.id, "sess-uuid-1");
      await store.setTaskContainerId(t.id, containerId);
      await store.setTaskPlan(t.id, "## Plan\n1. ...");
      await store.setTaskPrUrl(t.id, "https://github.com/user/repo/pull/42");

      const row = await store.getTask(t.id);
      expect(row?.sessionId).toBe("sess-uuid-1");
      expect(row?.containerId).toBe(containerId);
      expect(row?.plan).toBe("## Plan\n1. ...");
      expect(row?.prUrl).toBe("https://github.com/user/repo/pull/42");
    });

    it("setTaskResourceUsage validates and persists JSONB", async () => {
      const repoId = await seedRepo();
      const t = await store.insertTask({
        repoId,
        goal: "g",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      });
      await store.setTaskResourceUsage(t.id, {
        memory_bytes: { managed: 1024, user: 2048, project: 512 },
        tokens_input: 5000,
        tokens_output: 1200,
      });
      const row = await store.getTask(t.id);
      expect(row?.resourceUsage?.memory_bytes?.managed).toBe(1024);
      expect(row?.resourceUsage?.tokens_output).toBe(1200);
    });

    it("setTaskResourceUsage rejects unknown fields (strict schema)", async () => {
      const repoId = await seedRepo();
      const t = await store.insertTask({
        repoId,
        goal: "g",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      });
      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid input
        store.setTaskResourceUsage(t.id, { unknown_field: 1 } as any),
      ).rejects.toThrow();
    });

    it("countActiveTasksForRepo excludes terminal statuses", async () => {
      const repoId = await seedRepo();
      const mkTask = async (status: CodingTaskStatus) => {
        const t = await store.insertTask({
          repoId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        });
        if (status !== "queued") await store.updateTaskStatus({ id: t.id, status });
      };

      await mkTask("queued");
      await mkTask("planning");
      await mkTask("executing");
      await mkTask("pending_verify");
      await mkTask("pr_open");
      await mkTask("failed");
      await mkTask("cancelled");

      expect(await store.countActiveTasksForRepo(repoId)).toBe(4);
    });

    it("countActiveTasksForRepo scopes by repo", async () => {
      const a = await seedRepo("a");
      const b = await seedRepo("b");
      await store.insertTask({
        repoId: a,
        goal: "g",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      });
      expect(await store.countActiveTasksForRepo(a)).toBe(1);
      expect(await store.countActiveTasksForRepo(b)).toBe(0);
    });

    it("getTask returns null for unknown id", async () => {
      expect(await store.getTask("019d0000-0000-7000-8000-000000000099")).toBeNull();
    });

    it("supports evolution and signal_pipeline trigger sources with triggerRef", async () => {
      const repoId = await seedRepo();
      const t = await store.insertTask({
        repoId,
        goal: "auto-fix",
        triggerSource: "evolution",
        triggerRef: "evo-proposal-123",
        backend: "claude",
        allowPrivilegedRunc: false,
      });
      expect(t.triggerSource).toBe("evolution");
      expect(t.triggerRef).toBe("evo-proposal-123");
    });

    it("conversationId defaults to null when omitted, persists when set", async () => {
      const repoId = await seedRepo();
      const noConv = await store.insertTask({
        repoId,
        goal: "g",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      });
      expect(noConv.conversationId).toBeNull();

      const convId = "019d0000-0000-7000-8000-00000000aabb";
      const withConv = await store.insertTask({
        repoId,
        conversationId: convId,
        goal: "g",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      });
      expect(withConv.conversationId).toBe(convId);
    });

    it("listTasksForConversation returns rows in createdAt DESC order, scoped to the conversation", async () => {
      const repoId = await seedRepo();
      const convA = "019d0000-0000-7000-8000-000000000a01";
      const convB = "019d0000-0000-7000-8000-000000000b02";
      const t1 = await store.insertTask({
        repoId,
        conversationId: convA,
        goal: "first",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      });
      // Tiny delay so UUIDv7 timestamps differ — PGlite's pg_uuidv7 uses
      // random bits, not a monotonic counter, so we can't rely on insertion
      // order to give a strict createdAt ordering inside one ms.
      await new Promise((r) => setTimeout(r, 5));
      const t2 = await store.insertTask({
        repoId,
        conversationId: convA,
        goal: "second",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      });
      await store.insertTask({
        repoId,
        conversationId: convB,
        goal: "other",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      });

      const rowsA = await store.listTasksForConversation(convA);
      expect(rowsA.map((r) => r.id)).toEqual([t2.id, t1.id]);
      const rowsB = await store.listTasksForConversation(convB);
      expect(rowsB).toHaveLength(1);
    });
  });

  describe("approvePlanIfPending / cancelTaskIfActive", () => {
    it("approve happy path: status awaiting_approval, plan_approved_at null → stamps", async () => {
      const repoId = await seedRepo();
      const convId = "019d0000-0000-7000-8000-00000000aabb";
      const task = await store.insertTask({
        repoId,
        conversationId: convId,
        goal: "g",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      });
      await store.updateTaskStatus({ id: task.id, status: "awaiting_approval" });

      const result = await store.approvePlanIfPending(task.id, new Date("2026-04-26T12:00:00Z"));
      expect(result.kind).toBe("approved");
      if (result.kind !== "approved") return;
      expect(result.conversationId).toBe(convId);

      const reloaded = await store.getTask(task.id);
      expect(reloaded?.planApprovedAt).toBeInstanceOf(Date);
    });

    it("approve double-tap returns already_approved without overwriting the timestamp", async () => {
      const repoId = await seedRepo();
      const task = await store.insertTask({
        repoId,
        goal: "g",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      });
      await store.updateTaskStatus({ id: task.id, status: "awaiting_approval" });
      const first = new Date("2026-04-26T12:00:00Z");
      const second = new Date("2026-04-26T13:00:00Z");
      await store.approvePlanIfPending(task.id, first);
      const result = await store.approvePlanIfPending(task.id, second);

      expect(result.kind).toBe("already_approved");
      if (result.kind !== "already_approved") return;
      expect(result.approvedAt.toISOString()).toBe(first.toISOString());

      const reloaded = await store.getTask(task.id);
      expect(reloaded?.planApprovedAt?.toISOString()).toBe(first.toISOString());
    });

    it("approve returns not_pending when status is past awaiting_approval", async () => {
      const repoId = await seedRepo();
      const task = await store.insertTask({
        repoId,
        goal: "g",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      });
      await store.updateTaskStatus({ id: task.id, status: "executing" });
      const result = await store.approvePlanIfPending(task.id, new Date());
      expect(result.kind).toBe("not_pending");
      if (result.kind !== "not_pending") return;
      expect(result.status).toBe("executing");
    });

    it("approve returns not_found for unknown id", async () => {
      const result = await store.approvePlanIfPending(
        "019d0000-0000-7000-8000-000000000099",
        new Date(),
      );
      expect(result.kind).toBe("not_found");
    });

    it("cancel happy path: non-terminal task → status=cancelled with reason", async () => {
      const repoId = await seedRepo();
      const task = await store.insertTask({
        repoId,
        goal: "g",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      });
      await store.updateTaskStatus({ id: task.id, status: "awaiting_approval" });

      const result = await store.cancelTaskIfActive(task.id, "user cancelled");
      expect(result.kind).toBe("cancelled");

      const reloaded = await store.getTask(task.id);
      expect(reloaded?.status).toBe("cancelled");
      expect(reloaded?.failureReason).toBe("user cancelled");
    });

    it("cancel on terminal task returns already_terminal without rewriting", async () => {
      const repoId = await seedRepo();
      const task = await store.insertTask({
        repoId,
        goal: "g",
        triggerSource: "user",
        backend: "claude",
        allowPrivilegedRunc: false,
      });
      await store.updateTaskStatus({
        id: task.id,
        status: "failed",
        failureReason: "claude exit code 2",
      });

      const result = await store.cancelTaskIfActive(task.id, "ignored");
      expect(result.kind).toBe("already_terminal");
      if (result.kind !== "already_terminal") return;
      expect(result.status).toBe("failed");

      const reloaded = await store.getTask(task.id);
      // Original failure preserved — cancel didn't overwrite it.
      expect(reloaded?.status).toBe("failed");
      expect(reloaded?.failureReason).toBe("claude exit code 2");
    });
  });
});
