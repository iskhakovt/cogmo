/**
 * `Transport.repos.cloneAndAdd` exercises real `git clone` against a
 * file:// URL backed by a fresh `git init --bare`. Mocked `CodingStore`
 * and `SecretsStore` keep the test fast and DB-free; the goal is to
 * verify the orchestration: identity resolved → askpass helper threaded
 * → git clone → store insert.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CodingRepoRow, CodingStore, CodingTaskRow } from "../agent/coding/store/index.js";
import type { inboundArrived } from "../inngest/events.js";
import { runGit, withGitAskpass } from "../secrets/git-askpass.js";
import {
  type GitHubIdentity,
  gitHubIdentitySecretName,
  serializeGitHubIdentity,
} from "../secrets/github.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { mockAgentStore, mockTransportStore } from "../test/factories.js";
import { createTransport } from "./transport.js";

const VALID_IDENTITY: GitHubIdentity = {
  pat: "ghp_dummy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
  sshPublicKey: "ssh-ed25519 AAAA cogmo-bot",
  login: "cogmo-bot",
  id: "1",
};

class FakeSecretsStore implements Pick<SecretsStore, "getSecret"> {
  #values = new Map<string, string>();
  async getSecret(_tx: unknown, name: string): Promise<string | undefined> {
    return this.#values.get(name);
  }
  set(name: string, value: string): void {
    this.#values.set(name, value);
  }
}

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx = (cb: (tx: never) => unknown) => cb(FAKE_TX);

function fakeCodingStore(overrides: Partial<CodingStore> = {}): CodingStore {
  const repos = new Map<string, CodingRepoRow>();
  return {
    insertRepo: vi.fn(async (_tx: unknown, params) => {
      const row: CodingRepoRow = {
        id: `r-${repos.size + 1}`,
        name: params.name,
        localPath: params.localPath,
        defaultBranch: params.defaultBranch,
        remoteUrl: params.remoteUrl,
        devcontainer: params.devcontainer,
        allowedBackends: params.allowedBackends,
        verifyCommand: params.verifyCommand,
        taskTokenBudget: params.taskTokenBudget,
        taskWallTimeSeconds: params.taskWallTimeSeconds,
        maxConcurrentTasks: params.maxConcurrentTasks,
        identityName: params.identityName ?? "default",
        verifyTimeoutSeconds: params.verifyTimeoutSeconds ?? 600,
        createdAt: new Date(),
      };
      repos.set(params.name, row);
      return row;
    }),
    getRepoByName: vi.fn(async (_tx: unknown, name: string) => repos.get(name) ?? null),
    getRepoById: vi.fn(),
    listRepos: vi.fn(async () => [...repos.values()]),
    removeRepo: vi.fn(),
    removeRepoIfIdle: vi.fn(),
    insertTask: vi.fn(),
    listTasksForConversation: vi.fn(async () => []),
    getTask: vi.fn(),
    setTaskWorktreeAssignment: vi.fn(),
    updateTaskStatus: vi.fn(),
    setTaskSessionId: vi.fn(),
    setTaskContainerId: vi.fn(),
    setTaskPlan: vi.fn(),
    setTaskPrUrl: vi.fn(),
    setTaskResourceUsage: vi.fn(),
    countActiveTasksForRepo: vi.fn(async () => 0),
    transitionTaskStatus: vi.fn(),
    approvePlanIfPending: vi.fn(),
    cancelTaskIfActive: vi.fn(),
    insertToolDecision: vi.fn(),
    listToolDecisionsForTask: vi.fn(async () => []),
    ...overrides,
  } as CodingStore;
}

let bareRepoUrl: string;
let bareRoot: string;
let tempRoot: string;

beforeAll(async () => {
  // Create a bare upstream the test will clone from. file:// URLs let `git
  // clone` work without network.
  bareRoot = mkdtempSync(join(tmpdir(), "cogmo-cloneAndAdd-bare-"));
  const work = mkdtempSync(join(tmpdir(), "cogmo-cloneAndAdd-work-"));
  await withGitAskpass("dummy", async (env) => {
    await runGit(["init", "--bare", "--quiet", bareRoot], env);
    await runGit(["init", "--quiet", "--initial-branch=main", work], env);
    await runGit(["-C", work, "config", "user.email", "test@example.com"], env);
    await runGit(["-C", work, "config", "user.name", "Test"], env);
    writeFileSync(join(work, "README.md"), "hi\n");
    await runGit(["-C", work, "add", "."], env);
    await runGit(["-C", work, "commit", "--quiet", "-m", "init"], env);
    await runGit(["-C", work, "remote", "add", "origin", bareRoot], env);
    await runGit(["-C", work, "push", "--quiet", "origin", "main"], env);
  });
  bareRepoUrl = `file://${bareRoot}`;
});

afterAll(() => {
  rmSync(bareRoot, { recursive: true, force: true });
});

let secretsStore: FakeSecretsStore;
let codingStore: CodingStore;

beforeAll(() => {
  secretsStore = new FakeSecretsStore();
  secretsStore.set(gitHubIdentitySecretName("default"), serializeGitHubIdentity(VALID_IDENTITY));
});

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

function makeTransport(
  opts: { reposDir?: string; withSecretsStore?: boolean; withCodingStore?: boolean } = {},
) {
  const transportStore = mockTransportStore();
  const agentStore = mockAgentStore();
  codingStore = fakeCodingStore();
  const inngest = { send: vi.fn().mockResolvedValue(undefined) } as never;
  const mockEvent = {
    create: vi.fn((data: never) => ({ name: "inbound/arrived", data })),
  } as unknown as typeof inboundArrived;

  return createTransport({
    channelId: "ch-1",
    defaultUserId: "user-1",
    defaultProfileId: "profile-1",
    runInTx: fakeRunInTx as never,
    transportStore,
    agentStore,
    ...(opts.withCodingStore !== false && { codingStore }),
    ...(opts.withSecretsStore !== false && {
      secretsStore: secretsStore as unknown as SecretsStore,
    }),
    ...(opts.reposDir !== undefined && { reposDir: opts.reposDir }),
    inngest,
    inboundArrived: mockEvent,
    attachments: { upload: vi.fn(), download: vi.fn() } as never,
    idleTimeoutMs: 0,
  });
}

describe("Transport.repos.cloneAndAdd", () => {
  it("returns sandbox_disabled when no codingStore is wired", async () => {
    const transport = makeTransport({ withCodingStore: false });
    const result = await transport.repos.cloneAndAdd({
      name: "x",
      remoteUrl: bareRepoUrl,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("sandbox_disabled");
  });

  it("returns github_identity_unavailable when no secretsStore is wired", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "cogmo-cloneAndAdd-r-"));
    const transport = makeTransport({ reposDir: tempRoot, withSecretsStore: false });
    const result = await transport.repos.cloneAndAdd({
      name: "x",
      remoteUrl: bareRepoUrl,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("github_identity_unavailable");
  });

  it("returns github_identity_unavailable when no reposDir is wired", async () => {
    const transport = makeTransport({});
    const result = await transport.repos.cloneAndAdd({
      name: "x",
      remoteUrl: bareRepoUrl,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("github_identity_unavailable");
  });

  it("returns github_identity_unavailable when the named identity is missing", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "cogmo-cloneAndAdd-r-"));
    const empty = new FakeSecretsStore();
    const transportStore = mockTransportStore();
    const agentStore = mockAgentStore();
    codingStore = fakeCodingStore();
    const inngest = { send: vi.fn().mockResolvedValue(undefined) } as never;
    const mockEvent = {
      create: vi.fn((data: never) => ({ name: "inbound/arrived", data })),
    } as unknown as typeof inboundArrived;
    const transport = createTransport({
      channelId: "ch-1",
      defaultUserId: "user-1",
      defaultProfileId: "profile-1",
      runInTx: fakeRunInTx as never,
      transportStore,
      agentStore,
      codingStore,
      secretsStore: empty as unknown as SecretsStore,
      reposDir: tempRoot,
      inngest,
      inboundArrived: mockEvent,
      attachments: { upload: vi.fn(), download: vi.fn() } as never,
      idleTimeoutMs: 0,
    });
    const result = await transport.repos.cloneAndAdd({
      name: "x",
      remoteUrl: bareRepoUrl,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("github_identity_unavailable");
      if (result.error.code === "github_identity_unavailable") {
        expect(result.error.reason).toMatch(/not configured/i);
      }
    }
  });

  it("clones a real git remote and registers it on success", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "cogmo-cloneAndAdd-r-"));
    const transport = makeTransport({ reposDir: tempRoot });

    const result = await transport.repos.cloneAndAdd({
      name: "fixture",
      remoteUrl: bareRepoUrl,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.name).toBe("fixture");
      expect(result.value.localPath).toBe(join(tempRoot, "fixture"));
      expect(result.value.remoteUrl).toBe(bareRepoUrl);
    }
    expect(codingStore.insertRepo).toHaveBeenCalledTimes(1);
  });

  it("returns repo_name_taken when a repo with the same name is already registered", async () => {
    // Pre-check on `getRepoByName` short-circuits before the clone, so a
    // re-add with the same name surfaces the registry collision rather
    // than running the clone and tripping `repo_local_path_exists`.
    tempRoot = mkdtempSync(join(tmpdir(), "cogmo-cloneAndAdd-r-"));
    const transport = makeTransport({ reposDir: tempRoot });
    await transport.repos.cloneAndAdd({ name: "twice", remoteUrl: bareRepoUrl });

    const result = await transport.repos.cloneAndAdd({
      name: "twice",
      remoteUrl: bareRepoUrl,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("repo_name_taken");
  });

  it("returns repo_local_path_exists when the dir is on disk but no DB row exists", async () => {
    // Stale-checkout case: a directory was left behind by a prior failed
    // run (or manual operator action), but no `coding_repos` row points at
    // it. The DB pre-check passes, the filesystem check fires next.
    tempRoot = mkdtempSync(join(tmpdir(), "cogmo-cloneAndAdd-r-"));
    const transport = makeTransport({ reposDir: tempRoot });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempRoot, "stale"));

    const result = await transport.repos.cloneAndAdd({
      name: "stale",
      remoteUrl: bareRepoUrl,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("repo_local_path_exists");
  });

  it("rejects an invalid name before touching the filesystem", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "cogmo-cloneAndAdd-r-"));
    const transport = makeTransport({ reposDir: tempRoot });
    const result = await transport.repos.cloneAndAdd({
      name: "../escape",
      remoteUrl: bareRepoUrl,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("repo_invalid_input");
      if (result.error.code === "repo_invalid_input") expect(result.error.field).toBe("name");
    }
  });

  it("returns repo_clone_failed when the remote URL is unreachable", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "cogmo-cloneAndAdd-r-"));
    const transport = makeTransport({ reposDir: tempRoot });
    const result = await transport.repos.cloneAndAdd({
      name: "broken",
      remoteUrl: "file:///path/that/does/not/exist",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("repo_clone_failed");
  });

  // Suppress unused-binding warnings when CodingTaskRow isn't referenced
  // in the test body. Imported only so the fakeCodingStore's `as CodingStore`
  // cast is grounded in the same shape the production type expects.
  void ({} as CodingTaskRow);
});
