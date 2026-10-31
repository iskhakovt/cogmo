import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InngestTestEngine } from "@inngest/test";
import { RequestError } from "@octokit/request-error";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transactor } from "../../db/index.js";
import { inngest } from "../../inngest/client.js";
import { codingTaskFailed, codingTaskPrOpened } from "../../inngest/events.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { assertKind, expectOk } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { createRunBranchCleanupSubscriber, deleteRunBranch } from "./cleanup-run-branch.js";
import { DrizzleCodingStore } from "./store/index.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleCodingStore;
let baseDir: string;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleCodingStore();
  baseDir = mkdtempSync(join(tmpdir(), "cogmo-cleanup-test-"));
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

async function seedRepoAndTask(): Promise<{ taskId: string }> {
  const repo = await tx((trx) =>
    store
      .insertRepo(trx, {
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
      })
      .then(expectOk),
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
  return { taskId: task.id };
}

function fakeSecretsStore(secret: string | undefined): SecretsStore {
  const m = mock<SecretsStore>();
  m.getSecret.mockResolvedValue(secret);
  return m;
}

function fakeOctokit(deleteRefImpl: () => Promise<unknown>) {
  return {
    git: { deleteRef: vi.fn(deleteRefImpl) },
    // Only `git.deleteRef` is exercised; the rest is structural padding so
    // `Octokit` typechecks at the call site.
  } as never;
}

describe("deleteRunBranch", () => {
  it("calls octokit.git.deleteRef with cogmo/run/<task-id> and resolves to deleted", async () => {
    const { taskId } = await seedRepoAndTask();
    const secretsStore = fakeSecretsStore(validIdentity);
    const captured: { ref?: string; owner?: string; repo?: string } = {};
    const octokit = fakeOctokit(async (...args: unknown[]) => {
      const params = args[0] as { ref: string; owner: string; repo: string };
      captured.ref = params.ref;
      captured.owner = params.owner;
      captured.repo = params.repo;
      return { status: 204 };
    });

    const result = await deleteRunBranch(
      { runInTx: tx, store, secretsStore, octokitFactory: () => octokit },
      { taskId },
    );

    expect(result).toEqual({ kind: "deleted" });
    expect(captured.owner).toBe("owner");
    expect(captured.repo).toBe("example");
    expect(captured.ref).toBe(`heads/cogmo/run/${taskId}`);
  });

  it("reads 404 (already deleted) as not_found", async () => {
    const { taskId } = await seedRepoAndTask();
    const secretsStore = fakeSecretsStore(validIdentity);
    const octokit = fakeOctokit(async () => {
      throw new RequestError("Not Found", 404, {
        request: {
          method: "DELETE",
          url: "https://api.github.com/repos/owner/example/git/refs/heads/cogmo/run/x",
          headers: {},
        },
      });
    });

    const result = await deleteRunBranch(
      { runInTx: tx, store, secretsStore, octokitFactory: () => octokit },
      { taskId },
    );
    expect(result).toEqual({ kind: "not_found", missing: "ref" });
  });

  it("reads 422 (Reference does not exist) as not_found", async () => {
    const { taskId } = await seedRepoAndTask();
    const secretsStore = fakeSecretsStore(validIdentity);
    const octokit = fakeOctokit(async () => {
      throw new RequestError("Reference does not exist", 422, {
        request: {
          method: "DELETE",
          url: "https://api.github.com/repos/owner/example/git/refs/heads/cogmo/run/x",
          headers: {},
        },
      });
    });

    const result = await deleteRunBranch(
      { runInTx: tx, store, secretsStore, octokitFactory: () => octokit },
      { taskId },
    );
    expect(result).toEqual({ kind: "not_found", missing: "ref" });
  });

  it("propagates 5xx so Inngest retries with backoff", async () => {
    const { taskId } = await seedRepoAndTask();
    const secretsStore = fakeSecretsStore(validIdentity);
    const octokit = fakeOctokit(async () => {
      throw new RequestError("Bad Gateway", 502, {
        request: {
          method: "DELETE",
          url: "https://api.github.com/repos/owner/example/git/refs/heads/cogmo/run/x",
          headers: {},
        },
      });
    });

    await expect(
      deleteRunBranch(
        { runInTx: tx, store, secretsStore, octokitFactory: () => octokit },
        { taskId },
      ),
    ).rejects.toThrow(/Bad Gateway/);
  });

  it("resolves to not_found when the task row is missing (no octokit call)", async () => {
    const secretsStore = fakeSecretsStore(validIdentity);
    const octokit = fakeOctokit(async () => {
      throw new Error("should not be called");
    });

    const result = await deleteRunBranch(
      { runInTx: tx, store, secretsStore, octokitFactory: () => octokit },
      { taskId: "019d0000-0000-7000-8000-0000000000ff" },
    );
    expect(result).toEqual({ kind: "not_found", missing: "task" });
  });

  it("resolves to unavailable when the identity secret is missing (no octokit call)", async () => {
    const { taskId } = await seedRepoAndTask();
    const secretsStore = fakeSecretsStore(undefined);
    const octokit = fakeOctokit(async () => {
      throw new Error("should not be called");
    });

    const result = await deleteRunBranch(
      { runInTx: tx, store, secretsStore, octokitFactory: () => octokit },
      { taskId },
    );
    assertKind(result, "unavailable");
    expect(result.detail).toContain("not configured");
  });

  it("resolves to unavailable when the repo's remote URL does not parse (no octokit call)", async () => {
    const { taskId } = await seedRepoAndTask();
    await db.execute(sql`UPDATE coding_repos SET remote_url = 'not-a-url-at-all'`);
    const octokit = fakeOctokit(async () => {
      throw new Error("should not be called");
    });

    const result = await deleteRunBranch(
      {
        runInTx: tx,
        store,
        secretsStore: fakeSecretsStore(validIdentity),
        octokitFactory: () => octokit,
      },
      { taskId },
    );
    expect(result).toEqual({
      kind: "unavailable",
      detail: "cannot parse remote: not-a-url-at-all",
    });
  });
});

describe("createRunBranchCleanupSubscriber", () => {
  function engineFor(
    octokit: unknown,
    event: { name: "coding/task/failed" | "coding/task/pr-opened"; data: object },
    memo: { "delete-run-branch": unknown } | null,
  ) {
    const fn = createRunBranchCleanupSubscriber(
      {
        runInTx: tx,
        store,
        secretsStore: fakeSecretsStore(validIdentity),
        octokitFactory: () => octokit as never,
      },
      inngest,
    );
    return new InngestTestEngine({
      function: fn,
      events: [event],
      ...(memo !== null && {
        steps: [{ id: "delete-run-branch", handler: () => memo["delete-run-branch"] }],
      }),
    });
  }

  it("pins the triggers and an idempotency key that carries the event name", () => {
    const fn = createRunBranchCleanupSubscriber(
      { runInTx: tx, store, secretsStore: fakeSecretsStore(validIdentity) },
      inngest,
    );
    expect(fn.opts.id).toBe("coding-cleanup-run-branch");
    expect(fn.opts.triggers).toEqual([codingTaskPrOpened, codingTaskFailed]);
    expect(fn.opts.idempotency).toBe('event.name + "-" + event.data.taskId');
  });

  it("keeps the run branch on coding/task/failed, the only copy of a git-remote task's work", async () => {
    const { taskId } = await seedRepoAndTask();
    const octokit = { git: { deleteRef: vi.fn(async () => ({ status: 204 })) } };

    const { result, error } = await engineFor(
      octokit,
      {
        name: "coding/task/failed",
        data: { taskId, reason: "verify_failed", detail: "exit 1" },
      },
      null,
    ).execute();

    expect(error).toBeUndefined();
    expect(result).toEqual({ kind: "kept" });
    expect(octokit.git.deleteRef).not.toHaveBeenCalled();
  });

  it("keeps on a failed event replayed with an earlier build's delete-run-branch memo", async () => {
    const { taskId } = await seedRepoAndTask();
    const octokit = { git: { deleteRef: vi.fn(async () => ({ status: 204 })) } };

    const { result, error } = await engineFor(
      octokit,
      {
        name: "coding/task/failed",
        data: { taskId, reason: "verify_failed", detail: "exit 1" },
      },
      { "delete-run-branch": { deleted: true } },
    ).execute();

    expect(error).toBeUndefined();
    expect(result).toEqual({ kind: "kept" });
    expect(octokit.git.deleteRef).not.toHaveBeenCalled();
  });

  it("returns an earlier build's delete-run-branch memo on pr-opened without deleting again", async () => {
    const { taskId } = await seedRepoAndTask();
    const octokit = { git: { deleteRef: vi.fn(async () => ({ status: 204 })) } };

    const { result, error } = await engineFor(
      octokit,
      {
        name: "coding/task/pr-opened",
        data: { taskId, prUrl: "https://github.com/owner/example/pull/1", prNumber: 1 },
      },
      { "delete-run-branch": { deleted: false, reason: "already gone (404)" } },
    ).execute();

    expect(error).toBeUndefined();
    expect(result).toEqual({ deleted: false, reason: "already gone (404)" });
    expect(octokit.git.deleteRef).not.toHaveBeenCalled();
  });

  it("deletes the run branch on coding/task/pr-opened", async () => {
    const { taskId } = await seedRepoAndTask();
    const octokit = { git: { deleteRef: vi.fn(async () => ({ status: 204 })) } };

    const { result, error } = await engineFor(
      octokit,
      {
        name: "coding/task/pr-opened",
        data: { taskId, prUrl: "https://github.com/owner/example/pull/1", prNumber: 1 },
      },
      null,
    ).execute();

    expect(error).toBeUndefined();
    expect(result).toEqual({ kind: "deleted" });
    expect(octokit.git.deleteRef).toHaveBeenCalledExactlyOnceWith({
      owner: "owner",
      repo: "example",
      ref: `heads/cogmo/run/${taskId}`,
    });
  });
});
