import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { InngestTestEngine } from "@inngest/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transactor } from "../db/index.js";
import { inngest } from "../inngest/client.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import {
  createSkillsMirrorReconcile,
  ensureSkillsMirror,
  reconcileMirror,
  reconcileMirrorAtBoot,
} from "./mirror-reconcile.js";
import { DrizzleSkillStore } from "./store/index.js";

const execFileP = promisify(execFile);

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleSkillStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

afterAll(async () => {
  await close();
});

let root: string;
let local: string;
let remote: string;
let work: string;

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await execFileP("git", ["-C", repo, ...args])).stdout.trim();
}

async function commitLocal(file: string): Promise<string> {
  await writeFile(join(work, file), file);
  await git(work, "add", "-A");
  await git(work, "commit", "-q", "-m", file);
  const sha = await git(work, "rev-parse", "HEAD");
  await git(work, "push", "-q", local, `HEAD:refs/heads/staging-${sha.slice(0, 7)}`);
  await git(local, "update-ref", "refs/heads/main", sha);
  return sha;
}

const reconcileDeps = () => ({
  runInTx: tx,
  secretsStore: mock<SecretsStore>(),
  store,
  repoPath: local,
});
const reconcile = () => reconcileMirror(reconcileDeps());

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "skills-reconcile-"));
  local = join(root, "skills.git");
  remote = join(root, "remote.git");
  work = join(root, "work");
  await execFileP("git", ["init", "-q", "--bare", "--initial-branch=main", local]);
  await execFileP("git", ["init", "-q", "--bare", "--initial-branch=main", remote]);
  await execFileP("git", ["init", "-q", "-b", "main", work]);
  await git(work, "config", "user.email", "t@t");
  await git(work, "config", "user.name", "t");
  await git(local, "remote", "add", "origin", remote);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await truncateAll(db);
  await rm(root, { recursive: true, force: true });
});

describe("ensureSkillsMirror", () => {
  it("brings a row a crash left behind main up to it, so the reconcile's push can sync it", async () => {
    const older = await commitLocal("a");
    await tx(async (trx) => {
      await store.ensureMirror(trx);
      await store.markMainAdvanced(trx, older);
    });
    const main = await commitLocal("b");

    await ensureSkillsMirror({ runInTx: tx, store }, local);

    expect(await tx((trx) => store.getMirror(trx))).toMatchObject({
      status: "behind",
      localSha: main,
    });
    expect(await reconcile()).toEqual({ kind: "pushed", push: "landed" });
    expect(await tx((trx) => store.getMirror(trx))).toMatchObject({ status: "synced" });
  });
});

describe("ensureSkillsMirror under a concurrent deploy", () => {
  it("reads main once the row is locked, so a deploy committed while it waited is kept", async () => {
    await commitLocal("a");
    await tx((trx) => store.ensureMirror(trx));
    let advanced: string | undefined;
    // The row lock is granted once a running serve's deploy has advanced main
    // and marked the row, both committed.
    const racing: Parameters<typeof ensureSkillsMirror>[0]["store"] = {
      ensureMirror: (trx) => store.ensureMirror(trx),
      lockMirror: async (trx) => {
        const locked = await store.lockMirror(trx);
        advanced = await commitLocal("b");
        await store.markMainAdvanced(trx, advanced);
        return locked;
      },
      markMainAdvanced: (trx, sha) => store.markMainAdvanced(trx, sha),
      getMirror: (trx) => store.getMirror(trx),
    };

    await ensureSkillsMirror({ runInTx: tx, store: racing }, local);

    expect(advanced).toBeDefined();
    expect(await tx((trx) => store.getMirror(trx))).toMatchObject({ localSha: advanced });
  });
});

describe("reconcileMirror", () => {
  it("does nothing before the boot inserts the mirror row", async () => {
    expect(await reconcile()).toEqual({ kind: "no_mirror" });
  });

  it("does nothing without an origin", async () => {
    await commitLocal("a");
    await ensureSkillsMirror({ runInTx: tx, store }, local);
    await git(local, "remote", "remove", "origin");

    expect(await reconcile()).toEqual({ kind: "no_origin" });
    expect(await tx((trx) => store.getMirror(trx))).toMatchObject({ status: "behind" });
  });

  it("pushes nothing while main is unborn", async () => {
    await ensureSkillsMirror({ runInTx: tx, store }, local);

    expect(await reconcile()).toEqual({ kind: "unborn" });
  });

  it("brings a synced row up to a main that moved without marking it, and pushes it", async () => {
    await commitLocal("a");
    await ensureSkillsMirror({ runInTx: tx, store }, local);
    expect(await reconcile()).toEqual({ kind: "pushed", push: "landed" });
    // An update-ref whose transaction then failed to commit.
    const moved = await commitLocal("b");

    expect(await reconcile()).toEqual({ kind: "pushed", push: "landed" });

    expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(moved);
    expect(await tx((trx) => store.getMirror(trx))).toMatchObject({
      status: "synced",
      localSha: moved,
      pushedSha: moved,
    });
  });

  it("pushes local main while behind and records synced", async () => {
    const sha = await commitLocal("a");
    await ensureSkillsMirror({ runInTx: tx, store }, local);

    expect(await reconcile()).toEqual({ kind: "pushed", push: "landed" });

    expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(sha);
    expect(await tx((trx) => store.getMirror(trx))).toMatchObject({
      status: "synced",
      pushedSha: sha,
    });
    expect(await reconcile()).toEqual({ kind: "synced" });
  });

  it("keeps a diverged mirror until the remote's main is local main, then records synced", async () => {
    const theirs = await commitLocal("theirs");
    await git(local, "push", "-q", remote, `${theirs}:refs/heads/main`);
    await git(work, "checkout", "-q", "--orphan", "fresh");
    const sha = await commitLocal("a");
    await ensureSkillsMirror({ runInTx: tx, store }, local);
    await tx((trx) => store.recordMirrorDiverged(trx));

    expect(await reconcile()).toEqual({ kind: "still_diverged" });

    // The owner pushes local main by hand.
    await git(local, "push", "-q", "-f", remote, `${sha}:refs/heads/main`);

    expect(await reconcile()).toEqual({ kind: "resynced" });
    expect(await tx((trx) => store.getMirror(trx))).toMatchObject({
      status: "synced",
      pushedSha: sha,
      lastFailure: null,
    });
  });

  it("keeps a diverged mirror when a deploy moves main between the remote's read and the write", async () => {
    const sha = await commitLocal("a");
    await ensureSkillsMirror({ runInTx: tx, store }, local);
    await tx((trx) => store.recordMirrorDiverged(trx));
    await git(local, "push", "-q", "-f", remote, `${sha}:refs/heads/main`);
    const recordMirrorLanded = DrizzleSkillStore.prototype.recordMirrorLanded.bind(store);
    vi.spyOn(store, "recordMirrorLanded").mockImplementationOnce(async (trx, landed) => {
      await store.markMainAdvanced(trx, await commitLocal("b"));
      return recordMirrorLanded(trx, landed);
    });

    expect(await reconcile()).toEqual({ kind: "still_diverged" });
    expect(await tx((trx) => store.getMirror(trx))).toMatchObject({ status: "diverged" });
  });

  it("records behind and pushes once a diverged remote's main is an ancestor of local main", async () => {
    // The owner pushed A by hand; a deploy then moved main to B, and its own
    // push failed.
    const a = await commitLocal("a");
    await ensureSkillsMirror({ runInTx: tx, store }, local);
    await tx((trx) => store.recordMirrorDiverged(trx));
    await git(local, "push", "-q", "-f", remote, `${a}:refs/heads/main`);
    const b = await commitLocal("b");
    await tx((trx) => store.markMainAdvanced(trx, b));

    expect(await reconcile()).toEqual({ kind: "pushed", push: "landed" });

    expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(b);
    expect(await tx((trx) => store.getMirror(trx))).toMatchObject({
      status: "synced",
      localSha: b,
      pushedSha: b,
      lastFailure: null,
    });
  });

  it("records behind and pushes once a diverged remote has no main", async () => {
    const a = await commitLocal("a");
    await git(local, "push", "-q", remote, `${a}:refs/heads/main`);
    await ensureSkillsMirror({ runInTx: tx, store }, local);
    await tx((trx) => store.recordMirrorDiverged(trx));
    await git(remote, "update-ref", "-d", "refs/heads/main");

    expect(await reconcile()).toEqual({ kind: "pushed", push: "landed" });
    expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(a);
    expect(await tx((trx) => store.getMirror(trx))).toMatchObject({ status: "synced" });
  });

  it("pushes nothing when a deploy moves main before a diverged mirror returns to behind", async () => {
    const a = await commitLocal("a");
    await ensureSkillsMirror({ runInTx: tx, store }, local);
    await tx((trx) => store.recordMirrorDiverged(trx));
    const older = await commitLocal("older");
    await tx((trx) => store.markMainAdvanced(trx, older));
    await git(local, "push", "-q", "-f", remote, `${a}:refs/heads/main`);
    const recordMirrorBehind = DrizzleSkillStore.prototype.recordMirrorBehind.bind(store);
    vi.spyOn(store, "recordMirrorBehind").mockImplementationOnce(async (trx, sha) => {
      await store.markMainAdvanced(trx, await commitLocal("b"));
      return recordMirrorBehind(trx, sha);
    });

    expect(await reconcile()).toEqual({ kind: "still_diverged" });
    expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(a);
    expect(await tx((trx) => store.getMirror(trx))).toMatchObject({ status: "diverged" });
  });

  it("keeps a diverged mirror while the remote's main is not an ancestor of local main", async () => {
    const theirs = await commitLocal("theirs");
    await git(local, "push", "-q", remote, `${theirs}:refs/heads/main`);
    await git(work, "checkout", "-q", "--orphan", "fresh");
    await commitLocal("ours");
    await ensureSkillsMirror({ runInTx: tx, store }, local);
    await tx((trx) => store.recordMirrorDiverged(trx));

    expect(await reconcile()).toEqual({ kind: "still_diverged" });
    expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(theirs);
  });

  it("keeps a diverged mirror while the remote cannot be read", async () => {
    await commitLocal("a");
    await ensureSkillsMirror({ runInTx: tx, store }, local);
    await tx((trx) => store.recordMirrorDiverged(trx));
    await git(local, "remote", "set-url", "origin", join(root, "missing.git"));

    expect(await reconcile()).toEqual({ kind: "still_diverged" });
  });
});

describe("reconcileMirrorAtBoot", () => {
  it("pushes local main the boot left behind", async () => {
    const sha = await commitLocal("a");
    await ensureSkillsMirror({ runInTx: tx, store }, local);

    await reconcileMirrorAtBoot(reconcileDeps());

    expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(sha);
    expect(await tx((trx) => store.getMirror(trx))).toMatchObject({ status: "synced" });
  });

  it("resolves when the reconcile throws", async () => {
    await expect(
      reconcileMirrorAtBoot({ ...reconcileDeps(), repoPath: join(root, "not-a-repo") }),
    ).resolves.toBeUndefined();
  });
});

describe("createSkillsMirrorReconcile", () => {
  it("runs one reconcile in its single step", async () => {
    const sha = await commitLocal("a");
    await ensureSkillsMirror({ runInTx: tx, store }, local);
    const fn = createSkillsMirrorReconcile(
      { runInTx: tx, secretsStore: mock<SecretsStore>(), store, repoPath: local },
      inngest,
    );

    const { result } = await new InngestTestEngine({
      function: fn,
      events: [{ name: "inngest/function.invoked", data: {} }],
    }).execute();

    expect(result).toEqual({ kind: "pushed", push: "landed" });
    expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(sha);
  });
});
