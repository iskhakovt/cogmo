import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestError } from "@octokit/request-error";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transactor } from "../../db/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { deleteRunBranch } from "./cleanup-run-branch.js";
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
  it("calls octokit.git.deleteRef with cogmo/run/<task-id> and returns deleted=true", async () => {
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

    expect(result.deleted).toBe(true);
    expect(captured.owner).toBe("owner");
    expect(captured.repo).toBe("example");
    expect(captured.ref).toBe(`heads/cogmo/run/${taskId}`);
  });

  it("swallows 404 (already deleted) as deleted=false with reason", async () => {
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
    expect(result.deleted).toBe(false);
    expect(result.reason).toContain("404");
  });

  it("swallows 422 (Reference does not exist) as deleted=false with reason", async () => {
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
    expect(result.deleted).toBe(false);
    expect(result.reason).toContain("422");
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

  it("returns deleted=false when task row is missing (no octokit call)", async () => {
    const secretsStore = fakeSecretsStore(validIdentity);
    const octokit = fakeOctokit(async () => {
      throw new Error("should not be called");
    });

    const result = await deleteRunBranch(
      { runInTx: tx, store, secretsStore, octokitFactory: () => octokit },
      { taskId: "019d0000-0000-7000-8000-0000000000ff" },
    );
    expect(result.deleted).toBe(false);
    expect(result.reason).toContain("task row not found");
  });

  it("returns deleted=false when identity secret is missing (no octokit call)", async () => {
    const { taskId } = await seedRepoAndTask();
    const secretsStore = fakeSecretsStore(undefined);
    const octokit = fakeOctokit(async () => {
      throw new Error("should not be called");
    });

    const result = await deleteRunBranch(
      { runInTx: tx, store, secretsStore, octokitFactory: () => octokit },
      { taskId },
    );
    expect(result.deleted).toBe(false);
    expect(result.reason).toContain("not configured");
  });
});
