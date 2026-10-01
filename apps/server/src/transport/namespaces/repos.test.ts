import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { CodingStore } from "../../agent/coding/store/index.js";
import type { Transactor } from "../../db/index.js";
import { createRepos } from "./repos.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

describe("repos", () => {
  function setupWithCoding(overrides: Partial<CodingStore>) {
    const codingStore: CodingStore = { ...mock<CodingStore>(), ...overrides };
    return createRepos({
      runInTx: fakeRunInTx,
      codingStore,
      secretsStore: undefined,
      reposDir: undefined,
    });
  }

  it("returns sandbox_disabled when no codingStore is supplied", async () => {
    const repos = createRepos({
      runInTx: fakeRunInTx,
      codingStore: undefined,
      secretsStore: undefined,
      reposDir: undefined,
    });
    const list = await repos.list();
    expect(list._unsafeUnwrapErr()).toEqual({ code: "sandbox_disabled" });
    const add = await repos.add({
      name: "x",
      localPath: "/p",
      remoteUrl: "git@x:y/z.git",
    });
    expect(add._unsafeUnwrapErr()).toEqual({ code: "sandbox_disabled" });
    const remove = await repos.remove("x");
    expect(remove._unsafeUnwrapErr()).toEqual({ code: "sandbox_disabled" });
  });

  it("list maps store rows to RepoSummary shape", async () => {
    const codingStore = {
      listRepos: vi.fn().mockResolvedValue([
        {
          id: "r1",
          name: "cogmo",
          localPath: "/p",
          defaultBranch: "main",
          remoteUrl: "git@x:y/z.git",
          verifyCommand: "true",
          devcontainer: null,
          allowedBackends: ["claude"],
          taskTokenBudget: 1,
          taskWallTimeSeconds: 1,
          maxConcurrentTasks: 1,
          createdAt: new Date(),
        },
      ]),
      insertRepo: vi.fn(),
      getRepoByName: vi.fn(),
      countActiveTasksForRepo: vi.fn(),
      removeRepo: vi.fn(),
    };
    const repos = setupWithCoding(codingStore);
    const res = await repos.list();
    expect(res._unsafeUnwrap()[0]).toEqual({
      id: "r1",
      name: "cogmo",
      localPath: "/p",
      defaultBranch: "main",
      remoteUrl: "git@x:y/z.git",
      verifyCommand: "true",
    });
  });

  it("add applies slice-1 defaults (verify=true, branch=main, single backend, single concurrent)", async () => {
    const insertRepo = vi.fn().mockResolvedValue(
      ok({
        id: "r1",
        name: "cogmo",
        localPath: "/p",
        defaultBranch: "main",
        remoteUrl: "git@x:y/z.git",
        verifyCommand: "true",
        devcontainer: null,
        allowedBackends: ["claude"],
        taskTokenBudget: 200_000,
        taskWallTimeSeconds: 1800,
        maxConcurrentTasks: 1,
        createdAt: new Date(),
      }),
    );
    const repos = setupWithCoding({
      listRepos: vi.fn(),
      insertRepo,
      getRepoByName: vi.fn(),
      countActiveTasksForRepo: vi.fn(),
      removeRepo: vi.fn(),
    });
    await repos.add({
      name: "cogmo",
      localPath: "/p",
      remoteUrl: "git@x:y/z.git",
    });
    const insertCall = insertRepo.mock.calls[0];
    if (!insertCall) throw new Error("expected insertRepo to have been called");
    const args = insertCall[1] as Parameters<CodingStore["insertRepo"]>[1];
    expect(args.defaultBranch).toBe("main");
    expect(args.verifyCommand).toBe("true");
    expect(args.allowedBackends).toEqual(["claude"]);
    expect(args.taskTokenBudget).toBe(200_000);
    expect(args.maxConcurrentTasks).toBe(1);
  });

  describe("add input validation", () => {
    function freshTransport() {
      return setupWithCoding({
        listRepos: vi.fn(),
        insertRepo: vi.fn(),
        getRepoByName: vi.fn(),
        countActiveTasksForRepo: vi.fn(),
        removeRepo: vi.fn(),
      });
    }

    it("rejects names with path separators", async () => {
      const t = freshTransport();
      const res = await t.add({
        name: "evil/../escape",
        localPath: "/p",
        remoteUrl: "git@x:y.git",
      });
      const e = res._unsafeUnwrapErr();
      expect(e.code).toBe("repo_invalid_input");
      if (e.code === "repo_invalid_input") expect(e.field).toBe("name");
    });

    it("rejects names with spaces or shell metacharacters", async () => {
      const t = freshTransport();
      const res = await t.add({
        name: "my repo",
        localPath: "/p",
        remoteUrl: "git@x:y.git",
      });
      expect(res._unsafeUnwrapErr().code).toBe("repo_invalid_input");
    });

    it("accepts valid names with letters, digits, dot, dash, underscore", async () => {
      const insertRepo = vi.fn().mockResolvedValue(
        ok({
          id: "r1",
          name: "cogmo.notes_v2-rc1",
          localPath: "/p",
          defaultBranch: "main",
          remoteUrl: "x",
          devcontainer: null,
          allowedBackends: ["claude"],
          verifyCommand: "true",
          taskTokenBudget: 1,
          taskWallTimeSeconds: 1,
          maxConcurrentTasks: 1,
          createdAt: new Date(),
        }),
      );
      const t = setupWithCoding({
        listRepos: vi.fn(),
        insertRepo,
        getRepoByName: vi.fn(),
        countActiveTasksForRepo: vi.fn(),
        removeRepo: vi.fn(),
      });
      const res = await t.add({
        name: "cogmo.notes_v2-rc1",
        localPath: "/p",
        remoteUrl: "git@x:y.git",
      });
      expect(res.isOk()).toBe(true);
    });

    it("rejects relative localPath", async () => {
      const t = freshTransport();
      const res = await t.add({
        name: "cogmo",
        localPath: "relative/path",
        remoteUrl: "git@x:y.git",
      });
      const e = res._unsafeUnwrapErr();
      expect(e.code).toBe("repo_invalid_input");
      if (e.code === "repo_invalid_input") expect(e.field).toBe("localPath");
    });

    it("rejects empty remoteUrl", async () => {
      const t = freshTransport();
      const res = await t.add({
        name: "cogmo",
        localPath: "/p",
        remoteUrl: "   ",
      });
      const e = res._unsafeUnwrapErr();
      expect(e.code).toBe("repo_invalid_input");
      if (e.code === "repo_invalid_input") expect(e.field).toBe("remoteUrl");
    });
  });

  it("add maps the store's repo_name_taken", async () => {
    const repos = setupWithCoding({
      listRepos: vi.fn(),
      insertRepo: vi.fn().mockResolvedValue(err({ kind: "repo_name_taken", name: "cogmo" })),
      getRepoByName: vi.fn(),
      countActiveTasksForRepo: vi.fn(),
      removeRepo: vi.fn(),
    });
    const res = await repos.add({
      name: "cogmo",
      localPath: "/p",
      remoteUrl: "git@x:y/z.git",
    });
    expect(res._unsafeUnwrapErr()).toEqual({ code: "repo_name_taken", name: "cogmo" });
  });

  it("remove returns repo_not_found for unknown name", async () => {
    const repos = setupWithCoding({
      listRepos: vi.fn(),
      insertRepo: vi.fn(),
      getRepoByName: vi.fn().mockResolvedValue(null),
      countActiveTasksForRepo: vi.fn(),
      removeRepo: vi.fn(),
    });
    const res = await repos.remove("nope");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "repo_not_found", name: "nope" });
  });

  it("remove blocks when active tasks exist", async () => {
    const removeRepoIfIdle = vi.fn().mockResolvedValue({ kind: "in_use", activeTasks: 2 });
    const repos = setupWithCoding({
      listRepos: vi.fn(),
      insertRepo: vi.fn(),
      getRepoByName: vi.fn().mockResolvedValue({ id: "r1", name: "cogmo" }),
      countActiveTasksForRepo: vi.fn(),
      removeRepo: vi.fn(),
      removeRepoIfIdle,
    });
    const res = await repos.remove("cogmo");
    expect(res._unsafeUnwrapErr()).toEqual({
      code: "repo_in_use",
      name: "cogmo",
      activeTasks: 2,
    });
    expect(removeRepoIfIdle).toHaveBeenCalledWith(expect.anything(), "r1");
  });

  it("remove deletes when no active tasks", async () => {
    const removeRepoIfIdle = vi.fn().mockResolvedValue({ kind: "deleted" });
    const repos = setupWithCoding({
      listRepos: vi.fn(),
      insertRepo: vi.fn(),
      getRepoByName: vi.fn().mockResolvedValue({ id: "r1", name: "cogmo" }),
      countActiveTasksForRepo: vi.fn(),
      removeRepo: vi.fn(),
      removeRepoIfIdle,
    });
    const res = await repos.remove("cogmo");
    expect(res.isOk()).toBe(true);
    expect(removeRepoIfIdle).toHaveBeenCalledWith(expect.anything(), "r1");
  });
});
