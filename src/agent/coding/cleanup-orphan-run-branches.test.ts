import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestError } from "@octokit/request-error";
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

  it("continues to next ref after a delete failure (one bad ref doesn't block the sweep)", async () => {
    const repo = await seedRepo();
    const taskA = await insertTaskWithStatus(repo.id, "pr_open");
    const taskB = await insertTaskWithStatus(repo.id, "pr_open");
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    await db.execute(
      sql`UPDATE coding_tasks SET created_at = ${eightDaysAgo} WHERE id IN (${taskA.id}, ${taskB.id})`,
    );

    // First delete throws a non-404/422 error (e.g. transient 502).
    // Second delete succeeds. After the first throws, the loop catches
    // and continues — so deleted=1 and errors=1, not deleted=0 with
    // the function aborting on the first failure.
    const oct = fakeOctokit([
      `refs/heads/cogmo/run/${taskA.id}`,
      `refs/heads/cogmo/run/${taskB.id}`,
    ]);
    let call = 0;
    oct.calls.deleteRef.mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error("simulated 502");
      return { status: 204 };
    });

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

    expect(result).toEqual({
      repoId: repo.id,
      deleted: 1,
      skipped: 0,
      errors: 1,
    });
    expect(oct.calls.deleteRef).toHaveBeenCalledTimes(2);
  });

  it("returns zeros when the repo row was deleted between fan-out and sweep", async () => {
    // Fan-out emits a list of repos; one of them could be deleted between
    // the list query and the per-repo sweep firing. The sweeper must
    // log-info and return zeros, NOT throw and re-poison the function.
    const oct = fakeOctokit([]);
    const result = await sweepRepo(
      {
        runInTx: tx,
        store,
        secretsStore: fakeSecretsStore(),
        octokitFactory: oct.factory as never,
      },
      "019d0000-0000-7000-8000-000000000099", // unknown repoId
      stepRun,
    );

    expect(result).toEqual({
      repoId: "019d0000-0000-7000-8000-000000000099",
      deleted: 0,
      skipped: 0,
      errors: 0,
    });
    // Never reached the GitHub side.
    expect(oct.calls.paginate).not.toHaveBeenCalled();
  });

  it("returns zeros when the repo's remote URL is unparseable", async () => {
    // A malformed remoteUrl (e.g. someone hand-edited `coding_repos` to a
    // local path) means parseRemoteUrl returns null. The sweep must not
    // try to call GitHub.
    const repo = await tx((trx) =>
      store.insertRepo(trx, {
        name: "broken",
        localPath: `${baseDir}/broken-repo`,
        defaultBranch: "main",
        // Not a recognisable GitHub remote shape.
        remoteUrl: "not-a-url-at-all",
        devcontainer: null,
        allowedBackends: ["claude"],
        verifyCommand: "true",
        taskTokenBudget: 100_000,
        taskWallTimeSeconds: 60,
        maxConcurrentTasks: 1,
      }),
    );

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
    expect(oct.calls.paginate).not.toHaveBeenCalled();
  });

  it("treats GitHub 404 + 422 on deleteRef as 'ref already gone' (logs info, increments deleted)", async () => {
    // GitHub returns 422 when you try to delete a ref that doesn't exist;
    // some setups return 404. Either way the operational result is "the
    // ref is gone, which is what we wanted" — must not increment errors.
    const repo = await seedRepo();
    const taskA = await insertTaskWithStatus(repo.id, "pr_open");
    const taskB = await insertTaskWithStatus(repo.id, "pr_open");
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    await db.execute(
      sql`UPDATE coding_tasks SET created_at = ${eightDaysAgo} WHERE id IN (${taskA.id}, ${taskB.id})`,
    );

    const oct = fakeOctokit([
      `refs/heads/cogmo/run/${taskA.id}`,
      `refs/heads/cogmo/run/${taskB.id}`,
    ]);
    let call = 0;
    oct.calls.deleteRef.mockImplementation(async () => {
      call++;
      // First call: simulate GitHub 422; second: 404. Both swallowed.
      const err = new RequestError("Reference does not exist", call === 1 ? 422 : 404, {
        request: { method: "DELETE", url: "https://api.github.com/...", headers: {} },
      });
      throw err;
    });

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

    expect(result.deleted).toBe(2); // counted as deleted (ref ended up gone)
    expect(result.errors).toBe(0); // 404/422 are NOT errors
  });
});
