import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../../db/index.js";
import { DrizzleSandboxStore } from "../../../sandbox/store/index.js";
import type { ContainerLabels, ResourceLimits } from "../../../sandbox/types.js";
import { createTestDatabase, truncateAll } from "../../../test/pglite.js";
import { type CodingBackend, type CodingTaskStatus, DrizzleCodingStore } from "./index.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleCodingStore;
let sandboxStore: DrizzleSandboxStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleCodingStore();
  sandboxStore = new DrizzleSandboxStore();
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
  const row = await tx((trx) =>
    store.insertRepo(trx, {
      name,
      localPath: `/var/lib/cogmo/repos/${name}`,
      ...REPO_DEFAULTS,
    }),
  );
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
  const inst = await tx((trx) => sandboxStore.insertInstance(trx, { host: "h", pid: 1 }));
  const c = await tx((trx) =>
    sandboxStore.insertContainer(trx, {
      dockerId: `d-${Math.random().toString(36).slice(2)}`,
      parentId: null,
      rootTaskId: "019d0000-0000-7000-8000-00000000abcd",
      depth: 0,
      image: "cogmo/devbase:test",
      runtime: "sysbox-runc",
      labels: labels(),
      resourceLimits: RESOURCE_LIMITS,
      ttlExpiresAt: new Date(Date.now() + 60_000),
      instanceId: inst.id,
    }),
  );
  return c.id;
}

describe("DrizzleCodingStore", () => {
  describe("repos", () => {
    it("inserts and retrieves a repo with parsed JSONB defaults", async () => {
      const row = await tx((trx) =>
        store.insertRepo(trx, {
          name: "cogmo",
          localPath: "/var/lib/cogmo/repos/cogmo",
          ...REPO_DEFAULTS,
        }),
      );
      expect(row.name).toBe("cogmo");
      expect(row.allowedBackends).toEqual(["claude"]);
      expect(row.devcontainer).toBeNull();
      expect(row.maxConcurrentTasks).toBe(1);
      expect(row.identityName).toBe("default");

      const byName = await tx((trx) => store.getRepoByName(trx, "cogmo"));
      expect(byName?.id).toBe(row.id);
      const byId = await tx((trx) => store.getRepoById(trx, row.id));
      expect(byId?.name).toBe("cogmo");
    });

    it("identityName overrides the default when provided", async () => {
      const row = await tx((trx) =>
        store.insertRepo(trx, {
          name: "acme",
          localPath: "/repos/acme",
          ...REPO_DEFAULTS,
          identityName: "acme-bot",
        }),
      );
      expect(row.identityName).toBe("acme-bot");
      const reloaded = await tx((trx) => store.getRepoById(trx, row.id));
      expect(reloaded?.identityName).toBe("acme-bot");
    });

    it("rejects duplicate repo name", async () => {
      await seedRepo();
      await expect(seedRepo()).rejects.toThrow();
    });

    it("stores and round-trips devcontainer JSONB", async () => {
      const row = await tx((trx) =>
        store.insertRepo(trx, {
          name: "with-dev",
          localPath: "/repos/with-dev",
          ...REPO_DEFAULTS,
          devcontainer: {
            image: "ghcr.io/example/devcontainer:1",
            features: { "ghcr.io/devcontainers/features/node:1": { version: "24" } },
            postCreateCommand: ["pnpm", "install"],
            forwardPorts: [3000, "5432:5432"],
          },
        }),
      );
      expect(row.devcontainer?.image).toBe("ghcr.io/example/devcontainer:1");
      const reloaded = await tx((trx) => store.getRepoById(trx, row.id));
      expect(reloaded?.devcontainer?.forwardPorts).toEqual([3000, "5432:5432"]);
    });

    it("rejects malformed devcontainer via raw SQL on read", async () => {
      // DevcontainerSpecSchema is `.passthrough()`, so unknown keys are
      // accepted (forward compat); typed fields still validate. Corrupt
      // `image` with a non-string value to trigger Zod rejection on read.
      const id = await seedRepo();
      await db.execute(
        sql`UPDATE coding_repos SET devcontainer = '{"image":123}'::jsonb WHERE id = ${id}`,
      );
      await expect(tx((trx) => store.getRepoById(trx, id))).rejects.toThrow();
    });

    it("supports both backends in allowedBackends", async () => {
      const row = await tx((trx) =>
        store.insertRepo(trx, {
          name: "multi",
          localPath: "/repos/multi",
          ...REPO_DEFAULTS,
          allowedBackends: ["claude", "codex"],
        }),
      );
      expect(row.allowedBackends).toEqual(["claude", "codex"]);
    });

    it("listRepos returns rows in name order", async () => {
      await seedRepo("zebra");
      await seedRepo("alpha");
      await seedRepo("mid");
      const rows = await tx((trx) => store.listRepos(trx));
      expect(rows.map((r) => r.name)).toEqual(["alpha", "mid", "zebra"]);
    });

    it("removeRepo deletes the row", async () => {
      const id = await seedRepo();
      await tx((trx) => store.removeRepo(trx, id));
      expect(await tx((trx) => store.getRepoById(trx, id))).toBeUndefined();
    });

    it("getRepoByName returns null for unknown name", async () => {
      expect(await tx((trx) => store.getRepoByName(trx, "nope"))).toBeUndefined();
    });
  });

  describe("tasks", () => {
    it("inserts a task in queued status with nullable fields null", async () => {
      const repoId = await seedRepo();
      const row = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "refactor steering rules",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      expect(row.status).toBe("queued");
      expect(row.goal).toBe("refactor steering rules");
      expect(row.triggerSource).toBe("user");
      expect(row.triggerRef).toBeNull();
      expect(row.sessionId).toBeNull();
      expect(row.containerId).toBeNull();
      expect(row.worktreeAssignment).toBeNull();
      expect(row.plan).toBeNull();
      expect(row.planApprovedAt).toBeNull();
      expect(row.prMetadata).toBeNull();
      expect(row.failureReason).toBeNull();
      expect(row.resourceUsage).toBeNull();
      expect(row.allowPrivilegedRunc).toBe(false);
      expect(row.prMetadata).toBeNull();
    });

    it("getTasksByIds batch-loads existing rows and silently drops unknown ids", async () => {
      const repoId = await seedRepo();
      const t1 = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "a",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      const t2 = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "b",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      const rows = await tx((trx) =>
        store.getTasksByIds(trx, [t1.id, "019d0000-0000-7000-8000-000000000abc", t2.id]),
      );
      expect(rows.map((r) => r.id).sort()).toEqual([t1.id, t2.id].sort());
    });

    it("getTasksByIds with empty input returns empty array (no SQL roundtrip)", async () => {
      const rows = await tx((trx) => store.getTasksByIds(trx, []));
      expect(rows).toEqual([]);
    });

    it("setTaskWorktreeAssignment persists branch + worktreePath atomically as JSONB", async () => {
      const repoId = await seedRepo();
      const t = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      await tx((trx) =>
        store.setTaskWorktreeAssignment(trx, t.id, {
          type: "host-path",
          branch: "cogmo/abc12345",
          worktreePath: "/var/lib/cogmo/worktrees/cogmo/abc12345",
        }),
      );
      const reloaded = await tx((trx) => store.getTask(trx, t.id));
      expect(reloaded?.worktreeAssignment).toEqual({
        type: "host-path",
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
      const t = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      await tx((trx) =>
        store.setTaskWorktreeAssignment(trx, t.id, {
          type: "host-path",
          branch: "cogmo/aaaa",
          worktreePath: "/p1",
        }),
      );
      await tx((trx) =>
        store.setTaskWorktreeAssignment(trx, t.id, {
          type: "host-path",
          branch: "cogmo/aaaa",
          worktreePath: "/p1",
        }),
      );
      const reloaded = await tx((trx) => store.getTask(trx, t.id));
      expect(reloaded?.worktreeAssignment).toEqual({
        type: "host-path",
        branch: "cogmo/aaaa",
        worktreePath: "/p1",
      });
    });

    it("setTaskWorktreeAssignment rejects empty branch (Zod schema)", async () => {
      const repoId = await seedRepo();
      const t = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      await expect(
        tx((trx) =>
          store.setTaskWorktreeAssignment(trx, t.id, {
            type: "host-path",
            branch: "",
            worktreePath: "/p",
          }),
        ),
      ).rejects.toThrow();
    });

    it("rejects task with non-existent repo (FK)", async () => {
      await expect(
        tx((trx) =>
          store.insertTask(trx, {
            repoId: "019d0000-0000-7000-8000-0000000000ff",
            goal: "x",
            triggerSource: "user",
            backend: "claude",
            allowPrivilegedRunc: false,
          }),
        ),
      ).rejects.toThrow();
    });

    it("updateTaskStatus transitions through states with optional fields", async () => {
      const repoId = await seedRepo();
      const t = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );

      await tx((trx) => store.updateTaskStatus(trx, { id: t.id, status: "planning" }));
      expect((await tx((trx) => store.getTask(trx, t.id)))?.status).toBe("planning");

      const approvedAt = new Date("2026-04-26T10:00:00Z");
      await tx((trx) =>
        store.updateTaskStatus(trx, {
          id: t.id,
          status: "executing",
          planApprovedAt: approvedAt,
        }),
      );
      const after = await tx((trx) => store.getTask(trx, t.id));
      expect(after?.status).toBe("executing");
      expect(after?.planApprovedAt?.toISOString()).toBe(approvedAt.toISOString());

      await tx((trx) =>
        store.updateTaskStatus(trx, {
          id: t.id,
          status: "failed",
          failureReason: "verify failed: 3 tests",
        }),
      );
      const failed = await tx((trx) => store.getTask(trx, t.id));
      expect(failed?.status).toBe("failed");
      expect(failed?.failureReason).toBe("verify failed: 3 tests");
    });

    it("setTaskSessionId / setTaskContainerId / setTaskPlan / setTaskPrMetadata persist their fields", async () => {
      const repoId = await seedRepo();
      const t = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      const containerId = await seedContainer();

      await tx((trx) => store.setTaskSessionId(trx, t.id, "sess-uuid-1"));
      await tx((trx) => store.setTaskContainerId(trx, t.id, containerId));
      await tx((trx) => store.setTaskPlan(trx, t.id, "## Plan\n1. ..."));
      await tx((trx) =>
        store.setTaskPrMetadata(trx, t.id, {
          url: "https://github.com/user/repo/pull/42",
          number: 42,
          branchSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          openedAt: "2026-04-28T12:00:00.000Z",
        }),
      );

      const row = await tx((trx) => store.getTask(trx, t.id));
      expect(row?.sessionId).toBe("sess-uuid-1");
      expect(row?.containerId).toBe(containerId);
      expect(row?.plan).toBe("## Plan\n1. ...");
      expect(row?.prMetadata).toEqual({
        url: "https://github.com/user/repo/pull/42",
        number: 42,
        branchSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        openedAt: "2026-04-28T12:00:00.000Z",
      });
    });

    it("setTaskPrMetadata rejects malformed input via Zod", async () => {
      const repoId = await seedRepo();
      const t = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      await expect(
        tx((trx) =>
          store.setTaskPrMetadata(trx, t.id, {
            url: "not-a-url",
            number: 1,
            branchSha: "tooshort",
            openedAt: "not-a-date",
          }),
        ),
      ).rejects.toThrow();
    });

    it("setTaskResourceUsage validates and persists JSONB", async () => {
      const repoId = await seedRepo();
      const t = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      await tx((trx) =>
        store.setTaskResourceUsage(trx, t.id, {
          memory_bytes: { managed: 1024, user: 2048, project: 512 },
          tokens_input: 5000,
          tokens_output: 1200,
        }),
      );
      const row = await tx((trx) => store.getTask(trx, t.id));
      expect(row?.resourceUsage?.memory_bytes?.managed).toBe(1024);
      expect(row?.resourceUsage?.tokens_output).toBe(1200);
    });

    it("setTaskResourceUsage rejects unknown fields (strict schema)", async () => {
      const repoId = await seedRepo();
      const t = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      await expect(
        // @ts-expect-error: intentionally invalid input — verifies runtime Zod rejection
        tx((trx) => store.setTaskResourceUsage(trx, t.id, { unknown_field: 1 })),
      ).rejects.toThrow();
    });

    it("setTaskResourceUsage shallow-merges across calls (prior fields preserved)", async () => {
      // Phase 3c.5 changed the contract from replace to merge so the
      // execute orchestrator can write `sandbox` lifecycle at create
      // time + extend with `deleted_at` at teardown without clobbering
      // the CLI-reported `tokens_*`/`cost_usd`.
      const repoId = await seedRepo();
      const t = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      // First write: sandbox lifecycle at create-container time.
      await tx((trx) =>
        store.setTaskResourceUsage(trx, t.id, {
          sandbox: {
            backend: "daytona",
            created_at: "2026-05-11T10:00:00.000Z",
            provisioned: { cpu: 2, memory_bytes: 2_147_483_648 },
          },
        }),
      );
      // Second write: CLI usage from result events. Must not clobber sandbox.
      await tx((trx) =>
        store.setTaskResourceUsage(trx, t.id, {
          tokens_input: 5000,
          tokens_output: 1200,
          cost_usd: 0.42,
        }),
      );
      // Third write: deleted_at appended. Caller is expected to pass
      // the full nested object (top-level merge replaces `sandbox`).
      await tx((trx) =>
        store.setTaskResourceUsage(trx, t.id, {
          sandbox: {
            backend: "daytona",
            created_at: "2026-05-11T10:00:00.000Z",
            deleted_at: "2026-05-11T10:05:30.000Z",
            provisioned: { cpu: 2, memory_bytes: 2_147_483_648 },
          },
        }),
      );

      const row = await tx((trx) => store.getTask(trx, t.id));
      expect(row?.resourceUsage).toMatchObject({
        sandbox: {
          backend: "daytona",
          created_at: "2026-05-11T10:00:00.000Z",
          deleted_at: "2026-05-11T10:05:30.000Z",
          provisioned: { cpu: 2, memory_bytes: 2_147_483_648 },
        },
        tokens_input: 5000,
        tokens_output: 1200,
        cost_usd: 0.42,
      });
    });

    it("rejects malformed worktree_assignment via raw SQL on read", async () => {
      const repoId = await seedRepo();
      const t = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      await tx((trx) =>
        store.setTaskWorktreeAssignment(trx, t.id, {
          type: "host-path",
          branch: "cogmo/abc",
          worktreePath: "/p",
        }),
      );
      await db.execute(
        sql`UPDATE coding_tasks SET worktree_assignment = '{"junk":true}'::jsonb WHERE id = ${t.id}`,
      );
      await expect(tx((trx) => store.getTask(trx, t.id))).rejects.toThrow();
    });

    it("rejects malformed pr_metadata via raw SQL on read", async () => {
      const repoId = await seedRepo();
      const t = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      await db.execute(
        sql`UPDATE coding_tasks SET pr_metadata = '{"junk":true}'::jsonb WHERE id = ${t.id}`,
      );
      await expect(tx((trx) => store.getTask(trx, t.id))).rejects.toThrow();
    });

    it("rejects malformed resource_usage via raw SQL on read", async () => {
      const repoId = await seedRepo();
      const t = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      await db.execute(
        sql`UPDATE coding_tasks SET resource_usage = '{"junk":true}'::jsonb WHERE id = ${t.id}`,
      );
      await expect(tx((trx) => store.getTask(trx, t.id))).rejects.toThrow();
    });

    it("countActiveTasksForRepo excludes terminal statuses", async () => {
      const repoId = await seedRepo();
      const mkTask = async (status: CodingTaskStatus) => {
        const t = await tx((trx) =>
          store.insertTask(trx, {
            repoId,
            goal: "g",
            triggerSource: "user",
            backend: "claude",
            allowPrivilegedRunc: false,
          }),
        );
        if (status !== "queued")
          await tx((trx) => store.updateTaskStatus(trx, { id: t.id, status }));
      };

      await mkTask("queued");
      await mkTask("planning");
      await mkTask("executing");
      await mkTask("pending_verify");
      await mkTask("pr_open");
      await mkTask("failed");
      await mkTask("cancelled");

      expect(await tx((trx) => store.countActiveTasksForRepo(trx, repoId))).toBe(4);
    });

    it("countActiveTasksForRepo scopes by repo", async () => {
      const a = await seedRepo("a");
      const b = await seedRepo("b");
      await tx((trx) =>
        store.insertTask(trx, {
          repoId: a,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      expect(await tx((trx) => store.countActiveTasksForRepo(trx, a))).toBe(1);
      expect(await tx((trx) => store.countActiveTasksForRepo(trx, b))).toBe(0);
    });

    it("getTask returns null for unknown id", async () => {
      expect(
        await tx((trx) => store.getTask(trx, "019d0000-0000-7000-8000-000000000099")),
      ).toBeUndefined();
    });

    it("supports evolution and signal_pipeline trigger sources with triggerRef", async () => {
      const repoId = await seedRepo();
      const t = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "auto-fix",
          triggerSource: "evolution",
          triggerRef: "evo-proposal-123",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      expect(t.triggerSource).toBe("evolution");
      expect(t.triggerRef).toBe("evo-proposal-123");
    });

    it("conversationId defaults to null when omitted, persists when set", async () => {
      const repoId = await seedRepo();
      const noConv = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      expect(noConv.conversationId).toBeNull();

      const convId = "019d0000-0000-7000-8000-00000000aabb";
      const withConv = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          conversationId: convId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      expect(withConv.conversationId).toBe(convId);
    });

    it("listTasksForConversation returns rows in createdAt DESC order, scoped to the conversation", async () => {
      const repoId = await seedRepo();
      const convA = "019d0000-0000-7000-8000-000000000a01";
      const convB = "019d0000-0000-7000-8000-000000000b02";
      const t1 = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          conversationId: convA,
          goal: "first",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      // Tiny delay so UUIDv7 timestamps differ — PGlite's pg_uuidv7 uses
      // random bits, not a monotonic counter, so we can't rely on insertion
      // order to give a strict createdAt ordering inside one ms.
      await new Promise((r) => setTimeout(r, 5));
      const t2 = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          conversationId: convA,
          goal: "second",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          conversationId: convB,
          goal: "other",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );

      const rowsA = await tx((trx) => store.listTasksForConversation(trx, convA));
      expect(rowsA.map((r) => r.id)).toEqual([t2.id, t1.id]);
      const rowsB = await tx((trx) => store.listTasksForConversation(trx, convB));
      expect(rowsB).toHaveLength(1);
    });
  });

  describe("approvePlanIfPending / cancelTaskIfActive", () => {
    it("approve happy path: status awaiting_approval, plan_approved_at null → stamps", async () => {
      const repoId = await seedRepo();
      const convId = "019d0000-0000-7000-8000-00000000aabb";
      const task = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          conversationId: convId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      await tx((trx) => store.updateTaskStatus(trx, { id: task.id, status: "awaiting_approval" }));

      const result = await tx((trx) =>
        store.approvePlanIfPending(trx, task.id, new Date("2026-04-26T12:00:00Z")),
      );
      expect(result.kind).toBe("approved");
      if (result.kind !== "approved") return;
      expect(result.conversationId).toBe(convId);

      const reloaded = await tx((trx) => store.getTask(trx, task.id));
      expect(reloaded?.planApprovedAt).toBeInstanceOf(Date);
    });

    it("approve double-tap returns already_approved without overwriting the timestamp", async () => {
      const repoId = await seedRepo();
      const task = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      await tx((trx) => store.updateTaskStatus(trx, { id: task.id, status: "awaiting_approval" }));
      const first = new Date("2026-04-26T12:00:00Z");
      const second = new Date("2026-04-26T13:00:00Z");
      await tx((trx) => store.approvePlanIfPending(trx, task.id, first));
      const result = await tx((trx) => store.approvePlanIfPending(trx, task.id, second));

      expect(result.kind).toBe("already_approved");
      if (result.kind !== "already_approved") return;
      expect(result.approvedAt.toISOString()).toBe(first.toISOString());

      const reloaded = await tx((trx) => store.getTask(trx, task.id));
      expect(reloaded?.planApprovedAt?.toISOString()).toBe(first.toISOString());
    });

    it("approve returns not_pending when status is past awaiting_approval", async () => {
      const repoId = await seedRepo();
      const task = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      await tx((trx) => store.updateTaskStatus(trx, { id: task.id, status: "executing" }));
      const result = await tx((trx) => store.approvePlanIfPending(trx, task.id, new Date()));
      expect(result.kind).toBe("not_pending");
      if (result.kind !== "not_pending") return;
      expect(result.status).toBe("executing");
    });

    it("approve returns not_found for unknown id", async () => {
      const result = await tx((trx) =>
        store.approvePlanIfPending(trx, "019d0000-0000-7000-8000-000000000099", new Date()),
      );
      expect(result.kind).toBe("not_found");
    });

    it("cancel happy path: non-terminal task → status=cancelled with reason", async () => {
      const repoId = await seedRepo();
      const task = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      await tx((trx) => store.updateTaskStatus(trx, { id: task.id, status: "awaiting_approval" }));

      const result = await tx((trx) => store.cancelTaskIfActive(trx, task.id, "user cancelled"));
      expect(result.kind).toBe("cancelled");

      const reloaded = await tx((trx) => store.getTask(trx, task.id));
      expect(reloaded?.status).toBe("cancelled");
      expect(reloaded?.failureReason).toBe("user cancelled");
    });

    it("transitionTaskStatus: success path swaps status atomically", async () => {
      const repoId = await seedRepo();
      const task = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      await tx((trx) => store.updateTaskStatus(trx, { id: task.id, status: "awaiting_approval" }));

      const result = await tx((trx) =>
        store.transitionTaskStatus(trx, task.id, "awaiting_approval", "executing"),
      );
      expect(result.kind).toBe("transitioned");
      expect((await tx((trx) => store.getTask(trx, task.id)))?.status).toBe("executing");
    });

    it("transitionTaskStatus: stale return when current status doesn't match `from`", async () => {
      const repoId = await seedRepo();
      const task = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      // Task is in `queued` — try to transition awaiting_approval → executing.
      const result = await tx((trx) =>
        store.transitionTaskStatus(trx, task.id, "awaiting_approval", "executing"),
      );
      expect(result.kind).toBe("stale");
      if (result.kind !== "stale") return;
      expect(result.status).toBe("queued");
      // Status unchanged — no write happened.
      expect((await tx((trx) => store.getTask(trx, task.id)))?.status).toBe("queued");
    });

    it("transitionTaskStatus: not_found for unknown id", async () => {
      const result = await tx((trx) =>
        store.transitionTaskStatus(
          trx,
          "019d0000-0000-7000-8000-000000000099",
          "awaiting_approval",
          "executing",
        ),
      );
      expect(result.kind).toBe("not_found");
    });

    it("cancel on terminal task returns already_terminal without rewriting", async () => {
      const repoId = await seedRepo();
      const task = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      await tx((trx) =>
        store.updateTaskStatus(trx, {
          id: task.id,
          status: "failed",
          failureReason: "claude exit code 2",
        }),
      );

      const result = await tx((trx) => store.cancelTaskIfActive(trx, task.id, "ignored"));
      expect(result.kind).toBe("already_terminal");
      if (result.kind !== "already_terminal") return;
      expect(result.status).toBe("failed");

      const reloaded = await tx((trx) => store.getTask(trx, task.id));
      // Original failure preserved — cancel didn't overwrite it.
      expect(reloaded?.status).toBe("failed");
      expect(reloaded?.failureReason).toBe("claude exit code 2");
    });
  });

  describe("tool decisions", () => {
    let taskCounter = 0;
    async function seedTask(): Promise<string> {
      taskCounter += 1;
      const repoId = await seedRepo(`tool-decisions-${taskCounter}`);
      const task = await tx((trx) =>
        store.insertTask(trx, {
          repoId,
          goal: "g",
          triggerSource: "user",
          backend: "claude",
          allowPrivilegedRunc: false,
        }),
      );
      return task.id;
    }

    it("inserts a decision and reads it back", async () => {
      const taskId = await seedTask();
      const row = await tx((trx) =>
        store.insertToolDecision(trx, {
          taskId,
          tool: "Bash",
          pattern: "Bash(git push origin *)",
          decision: "allow",
          scope: "task",
        }),
      );
      expect(row.taskId).toBe(taskId);
      expect(row.tool).toBe("Bash");
      expect(row.pattern).toBe("Bash(git push origin *)");
      expect(row.decision).toBe("allow");
      expect(row.scope).toBe("task");
      expect(row.createdAt).toBeInstanceOf(Date);
    });

    it("rejects an unknown task_id (FK constraint)", async () => {
      await expect(
        tx((trx) =>
          store.insertToolDecision(trx, {
            taskId: "019d0000-0000-7000-8000-0000000000ff",
            tool: "Bash",
            pattern: "Bash(rm -rf *)",
            decision: "deny",
            scope: "task",
          }),
        ),
      ).rejects.toThrow();
    });

    it("listToolDecisionsForTask returns rows oldest-first, scoped by task", async () => {
      const taskA = await seedTask();
      const taskB = await seedTask();
      const first = await tx((trx) =>
        store.insertToolDecision(trx, {
          taskId: taskA,
          tool: "Bash",
          pattern: "Bash(git push *)",
          decision: "allow",
          scope: "task",
        }),
      );
      const second = await tx((trx) =>
        store.insertToolDecision(trx, {
          taskId: taskA,
          tool: "Bash",
          pattern: "Bash(curl -X POST *)",
          decision: "deny",
          scope: "task",
        }),
      );
      // Cross-task row to verify scoping.
      await tx((trx) =>
        store.insertToolDecision(trx, {
          taskId: taskB,
          tool: "Bash",
          pattern: "Bash(rm -rf *)",
          decision: "deny",
          scope: "once",
        }),
      );

      const rows = await tx((trx) => store.listToolDecisionsForTask(trx, taskA));
      expect(rows.map((r) => r.id)).toEqual([first.id, second.id]);
      expect(rows.map((r) => r.decision)).toEqual(["allow", "deny"]);
    });

    it("supports both scope and decision enums independently", async () => {
      const taskId = await seedTask();
      await tx((trx) =>
        store.insertToolDecision(trx, {
          taskId,
          tool: "Edit",
          pattern: "request-id-abc",
          decision: "allow",
          scope: "once",
        }),
      );
      await tx((trx) =>
        store.insertToolDecision(trx, {
          taskId,
          tool: "Bash",
          pattern: "Bash(npm publish)",
          decision: "deny",
          scope: "task",
        }),
      );
      const rows = await tx((trx) => store.listToolDecisionsForTask(trx, taskId));
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => `${r.scope}/${r.decision}`)).toEqual(["once/allow", "task/deny"]);
    });
  });
});
