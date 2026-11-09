import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ok } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { type MirrorDeps, mirrorMain, readRemoteMain } from "./mirror.js";

const execFileP = promisify(execFile);
const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

let root: string;
let local: string;
let remote: string;
let work: string;

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await execFileP("git", ["-C", repo, ...args])).stdout.trim();
}

/** Commit `file` in the working clone and move the local bare repo's main to it. */
async function commitLocal(file: string): Promise<string> {
  await writeFile(join(work, file), file);
  await git(work, "add", "-A");
  await git(work, "commit", "-q", "-m", file);
  const sha = await git(work, "rev-parse", "HEAD");
  await git(work, "push", "-q", local, `HEAD:refs/heads/staging-${sha.slice(0, 7)}`);
  await git(local, "update-ref", "refs/heads/main", sha);
  return sha;
}

function deps() {
  const store = mock<MirrorDeps["store"]>();
  store.recordMirrorLanded.mockResolvedValue(true);
  store.recordMirrorFailed.mockResolvedValue(undefined);
  store.recordMirrorDiverged.mockResolvedValue(true);
  return { runInTx: fakeRunInTx, secretsStore: mock<SecretsStore>(), store };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "skills-mirror-"));
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
  await rm(root, { recursive: true, force: true });
});

describe("mirrorMain", () => {
  it("records a landed push of local main", async () => {
    const sha = await commitLocal("a");
    const d = deps();

    expect(await mirrorMain(d, local, sha)).toEqual({ kind: "landed", sha });

    expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(sha);
    expect(d.store.recordMirrorLanded).toHaveBeenCalledWith(FAKE_TX, sha);
  });

  it("records diverged when a remote main local main does not descend from rejects the push", async () => {
    const theirs = await commitLocal("theirs");
    await git(local, "push", "-q", remote, `${theirs}:refs/heads/main`);
    // Local main moves to a history that does not contain the remote's.
    await git(work, "checkout", "-q", "--orphan", "fresh");
    const ours = await commitLocal("ours");
    const d = deps();

    const outcome = await mirrorMain(d, local, ours);

    expect(outcome).toMatchObject({ kind: "failed", failure: "rejected" });
    expect(d.store.recordMirrorDiverged).toHaveBeenCalledTimes(1);
    expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(theirs);
  });

  it("records nothing when a newer push already landed what local main holds", async () => {
    const older = await commitLocal("a");
    const newer = await commitLocal("b");
    await git(local, "push", "-q", remote, `${newer}:refs/heads/main`);
    const d = deps();

    const outcome = await mirrorMain(d, local, older);

    expect(outcome).toMatchObject({ kind: "failed", failure: "rejected" });
    expect(d.store.recordMirrorDiverged).not.toHaveBeenCalled();
    expect(d.store.recordMirrorFailed).not.toHaveBeenCalled();
  });

  it("records nothing when the remote rejects the push and then cannot be read", async () => {
    const theirs = await commitLocal("theirs");
    await git(local, "push", "-q", remote, `${theirs}:refs/heads/main`);
    await git(work, "checkout", "-q", "--orphan", "fresh");
    const ours = await commitLocal("ours");
    // Pushes reach the remote; the read after the rejection does not.
    const missing = join(root, "missing.git");
    await git(local, "remote", "set-url", "origin", missing);
    await git(local, "config", `url.${remote}.pushInsteadOf`, missing);
    const d = deps();

    const outcome = await mirrorMain(d, local, ours);

    expect(outcome).toMatchObject({ kind: "failed", failure: "rejected" });
    expect(d.store.recordMirrorDiverged).not.toHaveBeenCalled();
    expect(d.store.recordMirrorFailed).not.toHaveBeenCalled();
  });

  it("records a remote's refusal by its hook as an auth failure", async () => {
    const sha = await commitLocal("a");
    await writeFile(join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const d = deps();

    expect(await mirrorMain(d, local, sha)).toMatchObject({ kind: "failed", failure: "auth" });
    expect(d.store.recordMirrorFailed).toHaveBeenCalledWith(FAKE_TX, "auth");
  });

  it("records an unreachable remote", async () => {
    const sha = await commitLocal("a");
    await git(local, "remote", "set-url", "origin", join(root, "missing.git"));
    const d = deps();

    expect(await mirrorMain(d, local, sha)).toMatchObject({
      kind: "failed",
      failure: "unreachable",
    });
    expect(d.store.recordMirrorFailed).toHaveBeenCalledWith(FAKE_TX, "unreachable");
  });

  it("records a push its signal cut short as a timeout", async () => {
    const sha = await commitLocal("a");
    const d = deps();

    const outcome = await mirrorMain(d, local, sha, { signal: AbortSignal.abort() });

    expect(outcome).toMatchObject({ kind: "failed", failure: "timeout" });
    expect(d.store.recordMirrorFailed).toHaveBeenCalledWith(FAKE_TX, "timeout");
  });

  it("records nothing without an origin", async () => {
    const sha = await commitLocal("a");
    await git(local, "remote", "remove", "origin");
    const d = deps();

    expect(await mirrorMain(d, local, sha)).toEqual({ kind: "no_origin" });
    expect(d.store.recordMirrorLanded).not.toHaveBeenCalled();
    expect(d.store.recordMirrorFailed).not.toHaveBeenCalled();
  });

  it("records a push that fails before it starts, reading origin, as unreachable", async () => {
    const sha = await commitLocal("a");
    const d = deps();

    const outcome = await mirrorMain(d, join(root, "not-a-repo"), sha);

    expect(outcome).toMatchObject({ kind: "failed", failure: "unreachable" });
    expect(d.store.recordMirrorFailed).toHaveBeenCalledWith(FAKE_TX, "unreachable");
  });

  it("returns the outcome even when recording it fails", async () => {
    const sha = await commitLocal("a");
    const d = deps();
    d.store.recordMirrorLanded.mockRejectedValue(new Error("db down"));

    expect(await mirrorMain(d, local, sha)).toEqual({ kind: "landed", sha });
  });
});

describe("readRemoteMain", () => {
  it("reads the remote's main, and null for an empty remote or no origin", async () => {
    const d = deps();
    expect(await readRemoteMain(d, local)).toEqual(ok(null));
    const sha = await commitLocal("a");
    await git(local, "push", "-q", remote, `${sha}:refs/heads/main`);
    expect(await readRemoteMain(d, local)).toEqual(ok(sha));
    await git(local, "remote", "remove", "origin");
    expect(await readRemoteMain(d, local)).toEqual(ok(null));
  });

  it("returns unreadable for a remote it cannot reach", async () => {
    await git(local, "remote", "set-url", "origin", join(root, "missing.git"));

    const remoteMain = await readRemoteMain(deps(), local);

    expect(remoteMain._unsafeUnwrapErr()).toMatchObject({ kind: "unreadable" });
  });
});
