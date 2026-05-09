import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transactor } from "../../db/index.js";
import type { StepRun } from "../../inngest/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { sweepRepo } from "./cleanup-orphan-run-branches.js";
import { type CodingRepoRow, type CodingTaskRow, DrizzleCodingStore } from "./store/index.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleCodingStore;
let baseDir: string;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleCodingStore();
  baseDir = mkdtempSync(join(tmpdir(), "cogmo-sweep-test-"));
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  rmSync(baseDir, { recursive: true, force: true });
  await close();
});

const validIdentity = JSON.stringify({
  pat: "ghp_test",
  sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
  sshPublicKey: "ssh-ed25519 AAAA",
  login: "cogmo-bot",
  id: "12345",
});

// Inline `step.run` shim — replays the body inline, mirroring the
// orchestrator test pattern. Cast at the seam per the project convention.
const stepRun = ((_: string, fn: () => Promise<unknown>) => fn()) as unknown as StepRun;

async function seedRepo(): Promise<CodingRepoRow> {
  return tx((trx) =>
    store.insertRepo(trx, {
      name: "example",
      localPath: `${baseDir}/repo`,
      defaultBranch: "main",
      remoteUrl: "https://github.com/owner/example.git",
      devcontainer: null,
      allowedBackends: ["claude"],
      verifyCommand: "true",
      taskTokenBudget: 100_000,
      taskWallTimeSeconds: 60,
      maxConcurrentTasks: 1,
    }),
  );
}

async function insertTaskWithStatus(
  repoId: string,
  status: CodingTaskRow["status"],
): Promise<CodingTaskRow> {
  const t = await tx((trx) =>
    store.insertTask(trx, {
      repoId,
      goal: "x",
      triggerSource: "user",
      backend: "claude",
      allowPrivilegedRunc: false,
    }),
  );
  await tx((trx) => store.updateTaskStatus(trx, { id: t.id, status }));
  return t;
}

function fakeSecretsStore(): SecretsStore {
  const m = mock<SecretsStore>();
  m.getSecret.mockResolvedValue(validIdentity);
  return m;
}

interface OctokitFake {
  listMatchingRefs: ReturnType<typeof vi.fn>;
  deleteRef: ReturnType<typeof vi.fn>;
  paginate: ReturnType<typeof vi.fn>;
}

function fakeOctokit(refs: string[]): { factory: () => unknown; calls: OctokitFake } {
  const refData = refs.map((ref) => ({ ref }));
  const calls: OctokitFake = {
    listMatchingRefs: vi.fn(async () => ({ data: refData })),
    deleteRef: vi.fn(async () => ({ status: 204 })),
    // `octokit.paginate(method, params)` walks all pages and returns the
    // flat array. The fake's `listMatchingRefs` returns a single page so
    // paginate just unwraps `data`.
    paginate: vi.fn(async () => refData),
  };
  return {
    factory: () =>
      ({
        git: { listMatchingRefs: calls.listMatchingRefs, deleteRef: calls.deleteRef },
        paginate: calls.paginate,
      }) as never,
    calls,
  };
}

describe("sweepRepo", () => {
  it("deletes refs whose task is terminal AND >7d old", async () => {
    const repo = await seedRepo();
    const oldTask = await insertTaskWithStatus(repo.id, "pr_open");
    // Backdate to 8 days ago.
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    await db.execute(
      sql`UPDATE coding_tasks SET created_at = ${eightDaysAgo} WHERE id = ${oldTask.id}`,
    );

    const oct = fakeOctokit([`refs/heads/cogmo/run/${oldTask.id}`]);
    const result = await sweepRepo(
      {
        runInTx: tx,
        store,
        secretsStore: fakeSecretsStore(),
        octokitFactory: oct.factory as never,
      },
      repo.id,
      stepRun,
    );

    expect(result.deleted).toBe(1);
    expect(result.skipped).toBe(0);
    expect(oct.calls.deleteRef).toHaveBeenCalledTimes(1);
    expect(oct.calls.deleteRef.mock.calls[0]?.[0]).toEqual({
      owner: "owner",
      repo: "example",
      ref: `heads/cogmo/run/${oldTask.id}`,
    });
  });

  it("skips refs whose task is terminal but younger than 7d (not yet stale)", async () => {
    const repo = await seedRepo();
    const recentTask = await insertTaskWithStatus(repo.id, "failed");
    // Default `created_at = now()` — within retention window.

    const oct = fakeOctokit([`refs/heads/cogmo/run/${recentTask.id}`]);
    const result = await sweepRepo(
      {
        runInTx: tx,
        store,
        secretsStore: fakeSecretsStore(),
        octokitFactory: oct.factory as never,
      },
      repo.id,
      stepRun,
    );

    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(oct.calls.deleteRef).not.toHaveBeenCalled();
  });

  it("never sweeps non-terminal tasks regardless of age (user owns stuck approvals)", async () => {
    const repo = await seedRepo();
    const oldNonTerminal = await insertTaskWithStatus(repo.id, "awaiting_approval");
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    await db.execute(
      sql`UPDATE coding_tasks SET created_at = ${tenDaysAgo} WHERE id = ${oldNonTerminal.id}`,
    );

    const oct = fakeOctokit([`refs/heads/cogmo/run/${oldNonTerminal.id}`]);
    const result = await sweepRepo(
      {
        runInTx: tx,
        store,
        secretsStore: fakeSecretsStore(),
        octokitFactory: oct.factory as never,
      },
      repo.id,
      stepRun,
    );

    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(oct.calls.deleteRef).not.toHaveBeenCalled();
  });

  it("deletes refs with no matching task row (foreign or DB-deleted)", async () => {
    const repo = await seedRepo();
    const orphanRef = "019d0000-0000-7000-8000-000000000abc";

    const oct = fakeOctokit([`refs/heads/cogmo/run/${orphanRef}`]);
    const result = await sweepRepo(
      {
        runInTx: tx,
        store,
        secretsStore: fakeSecretsStore(),
        octokitFactory: oct.factory as never,
      },
      repo.id,
      stepRun,
    );

    expect(result.deleted).toBe(1);
  });

  it("returns zeros when the repo lists no run-branch refs", async () => {
    const repo = await seedRepo();
    const oct = fakeOctokit([]);
    const result = await sweepRepo(
      {
        runInTx: tx,
        store,
        secretsStore: fakeSecretsStore(),
        octokitFactory: oct.factory as never,
      },
      repo.id,
      stepRun,
    );

    expect(result).toEqual({ repoId: repo.id, deleted: 0, skipped: 0, errors: 0 });
    expect(oct.calls.deleteRef).not.toHaveBeenCalled();
  });
});
