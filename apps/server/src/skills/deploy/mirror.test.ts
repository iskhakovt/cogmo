import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { ok } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** An executable shell script under the test root. */
async function script(name: string, body: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

/**
 * A fake `ssh` at `<dir>/ssh` that writes its arguments, then `$SKILLS_SSH_TAG`,
 * to `<root>/ssh-call` and fails the connection.
 */
async function recordingSsh(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "ssh");
  await writeFile(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$*" "tag=\${SKILLS_SSH_TAG-unset}" > '${join(root, "ssh-call")}'\nexit 1\n`,
    { mode: 0o755 },
  );
  return path;
}

/** The arguments and tag the last `recordingSsh` connection wrote. */
async function sshCall(): Promise<{ args: string; tag: string }> {
  const [args = "", tag = ""] = (await readFile(join(root, "ssh-call"), "utf8")).split("\n");
  return { args, tag };
}

/** Point origin at an SSH URL whose connections run `ssh` instead, through the repo's config. */
async function sshOrigin(ssh: string): Promise<void> {
  vi.stubEnv("GIT_SSH_COMMAND", undefined);
  await git(local, "remote", "set-url", "origin", "git@skills.invalid:o/skills.git");
  await git(local, "config", "core.sshCommand", ssh);
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
  vi.unstubAllEnvs();
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

  it("records nothing when a newer push moves the remote's main while its own is updating it", async () => {
    const base = await commitLocal("a");
    await git(local, "push", "-q", remote, `${base}:refs/heads/main`);
    const older = await commitLocal("b");
    const newer = await commitLocal("c");
    await git(local, "push", "-q", remote, `${newer}:refs/heads/side`);
    // The newer push lands between the older one's read of the remote's main
    // and its update of it, which then fails on the old value.
    await writeFile(
      join(remote, "hooks", "pre-receive"),
      `#!/bin/sh\nenv -u GIT_QUARANTINE_PATH -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES git update-ref refs/heads/main ${newer}\n`,
      { mode: 0o755 },
    );
    const d = deps();

    const outcome = await mirrorMain(d, local, older);

    expect(outcome).toMatchObject({ kind: "failed", failure: "rejected" });
    expect(d.store.recordMirrorFailed).not.toHaveBeenCalled();
    expect(d.store.recordMirrorDiverged).not.toHaveBeenCalled();
    expect(await git(remote, "rev-parse", "refs/heads/main")).toBe(newer);
  });

  it("records nothing when an older git's remote reports the lost race as a ref it could not lock", async () => {
    const base = await commitLocal("a");
    const older = await commitLocal("b");
    const newer = await commitLocal("c");
    await git(local, "push", "-q", remote, `${newer}:refs/heads/main`);
    // Pushes reach a remote that answers as git 2.44's receive-pack does when
    // another push moved main first; reads reach the real remote.
    vi.stubEnv("GIT_SSH_COMMAND", undefined);
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    await git(local, "config", "url.git@skills.invalid:o/skills.git.pushInsteadOf", remote);
    await git(
      local,
      "config",
      "core.sshCommand",
      await script(
        "ssh",
        [
          `echo "remote: error: cannot lock ref 'refs/heads/main': is at ${newer} but expected ${base}" >&2`,
          "echo 'To git@skills.invalid:o/skills.git' >&2",
          `echo ' ! [remote rejected] ${older} -> main (failed to update ref)' >&2`,
          "exit 1",
        ].join("\n"),
      ),
    );
    const d = deps();

    const outcome = await mirrorMain(d, local, older);

    expect(outcome).toMatchObject({ kind: "failed", failure: "rejected" });
    expect(d.store.recordMirrorFailed).not.toHaveBeenCalled();
    expect(d.store.recordMirrorDiverged).not.toHaveBeenCalled();
  });

  it("stops reading the remote after a rejected push once its signal aborts", async () => {
    const theirs = await commitLocal("theirs");
    await git(local, "push", "-q", remote, `${theirs}:refs/heads/main`);
    await git(work, "checkout", "-q", "--orphan", "fresh");
    const ours = await commitLocal("ours");
    // Pushes reach the remote; the read after the rejection hangs.
    const started = join(root, "read-started");
    await sshOrigin(await script("ssh", `echo $$ > ${started}\nexec sleep 30`));
    await git(local, "config", `url.${remote}.pushInsteadOf`, "git@skills.invalid:o/skills.git");
    const controller = new AbortController();
    const d = deps();

    const outcome = mirrorMain(d, local, ours, { signal: controller.signal });
    const reader = await vi.waitFor(
      async () => {
        const pid = Number.parseInt(await readFile(started, "utf8"), 10);
        if (!(pid > 0)) throw new Error("the read has not started");
        return pid;
      },
      { timeout: 10_000 },
    );
    controller.abort();
    const settled = await Promise.race([
      outcome,
      setTimeout(3_000, "still reading", { ref: false }),
    ]);
    if (settled === "still reading") process.kill(reader);

    expect(settled).toMatchObject({ kind: "failed", failure: "rejected" });
    expect(d.store.recordMirrorDiverged).not.toHaveBeenCalled();
    expect(d.store.recordMirrorFailed).not.toHaveBeenCalled();
  }, 20_000);

  it.skipIf(process.getuid?.() === 0)(
    "records a remote that cannot write its main as a failure, not a lost race",
    async () => {
      const base = await commitLocal("a");
      await git(local, "push", "-q", remote, `${base}:refs/heads/main`);
      const sha = await commitLocal("b");
      const heads = join(remote, "refs", "heads");
      await chmod(heads, 0o555);
      const d = deps();
      try {
        expect(await mirrorMain(d, local, sha)).toMatchObject({
          kind: "failed",
          failure: "auth",
          detail: expect.stringMatching(/cannot lock ref.*Permission denied/),
        });
      } finally {
        await chmod(heads, 0o755);
      }
      expect(d.store.recordMirrorFailed).toHaveBeenCalledWith(FAKE_TX, "auth");
    },
  );

  it("records a remote's refusal by its hook as an auth failure", async () => {
    const sha = await commitLocal("a");
    await writeFile(join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const d = deps();

    expect(await mirrorMain(d, local, sha)).toMatchObject({ kind: "failed", failure: "auth" });
    expect(d.store.recordMirrorFailed).toHaveBeenCalledWith(FAKE_TX, "auth");
  });

  it.each([
    ["a key without access to the repo", "ERROR: Permission to o/skills.git denied to cogmo."],
    [
      "a read-only deploy key",
      "ERROR: The key you are authenticating with has been marked as read only.",
    ],
  ])("records GitHub's SSH refusal of %s as an auth failure", async (_, message) => {
    const sha = await commitLocal("a");
    await sshOrigin(await script("ssh", `echo '${message}' >&2\nexit 1`));
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

describe("the push and the remote read", () => {
  it.each([
    ["the repo's core.sshCommand", "config"],
    ["GIT_SSH_COMMAND", "env"],
  ])("run ssh from %s without prompting", async (_, where) => {
    const sha = await commitLocal("a");
    const call = join(root, "ssh-call");
    const ssh = await script(
      "ssh",
      `printf '%s\\n' "$*" "prompt=\${GIT_TERMINAL_PROMPT-unset}" > ${call}\nexit 1`,
    );
    await sshOrigin(ssh);
    vi.stubEnv("GIT_TERMINAL_PROMPT", undefined);
    if (where === "env") {
      await git(local, "config", "--unset", "core.sshCommand");
      vi.stubEnv("GIT_SSH_COMMAND", ssh);
    }

    await mirrorMain(deps(), local, sha);
    const pushed = await readFile(call, "utf8");
    await rm(call);
    await readRemoteMain(deps(), local);
    const read = await readFile(call, "utf8");

    for (const ran of [pushed, read]) {
      expect(ran).toContain("-o BatchMode=yes");
      expect(ran).toContain("prompt=0");
    }
  });

  describe("over ssh", () => {
    beforeEach(async () => {
      vi.stubEnv("GIT_SSH_COMMAND", undefined);
      vi.stubEnv("GIT_SSH", undefined);
      // The machine's own config may name an ssh command; only the repo's counts here.
      vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
      vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
      await git(local, "remote", "set-url", "origin", "git@skills.invalid:o/skills.git");
    });

    it("put BatchMode=yes ahead of the command's own BatchMode, since ssh keeps the first", async () => {
      const sha = await commitLocal("a");
      vi.stubEnv("GIT_SSH_COMMAND", `${await recordingSsh(root)} -o BatchMode=no`);

      await mirrorMain(deps(), local, sha);

      expect((await sshCall()).args).toMatch(/^-o BatchMode=yes -o BatchMode=no /);
    });

    it.each([
      ["single", "'"],
      ["double", '"'],
    ])("keep a %s-quoted executable path whole", async (_, quote) => {
      const sha = await commitLocal("a");
      const ssh = await recordingSsh(join(root, "my ssh"));
      await git(local, "config", "core.sshCommand", `${quote}${ssh}${quote} -o BatchMode=no`);

      await mirrorMain(deps(), local, sha);

      expect((await sshCall()).args).toMatch(/^-o BatchMode=yes -o BatchMode=no /);
    });

    it("put BatchMode after the variable assignments ahead of the executable", async () => {
      const sha = await commitLocal("a");
      const ssh = await recordingSsh(root);
      await git(local, "config", "core.sshCommand", `SKILLS_SSH_TAG=kept ${ssh} -o BatchMode=no`);

      await mirrorMain(deps(), local, sha);

      expect(await sshCall()).toEqual({
        args: expect.stringMatching(/^-o BatchMode=yes -o BatchMode=no /),
        tag: "tag=kept",
      });
    });

    it("read a command substitution in an assignment as one word", async () => {
      const sha = await commitLocal("a");
      const ssh = await recordingSsh(root);
      await git(
        local,
        "config",
        "core.sshCommand",
        `SKILLS_SSH_TAG=$(printf kept) ${ssh} -o BatchMode=no`,
      );

      await mirrorMain(deps(), local, sha);

      expect(await sshCall()).toEqual({
        args: expect.stringMatching(/^-o BatchMode=yes -o BatchMode=no /),
        tag: "tag=kept",
      });
    });

    it.each([
      ["an executable named by a substitution", "$(command -v ssh) -i key"],
      ["a wrapper", "env SKILLS_SSH_TAG=kept ssh -i key"],
      ["a list", "cd / && ssh -i key"],
      ["a nested substitution", "$(printf %s $(command -v ssh)) -i key"],
      [
        "a nested substitution ahead of ssh",
        "SKILLS_SSH_TAG=$(printf %s $(printf kept)) ssh -i key",
      ],
    ])("append BatchMode=yes to %s, which still runs", async (_, command) => {
      const sha = await commitLocal("a");
      const bin = join(root, "bin");
      await recordingSsh(bin);
      vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
      await git(local, "config", "core.sshCommand", command);

      await mirrorMain(deps(), local, sha);

      expect((await sshCall()).args).toMatch(/^-i key -o BatchMode=yes git@skills\.invalid /);
    });

    it("leave a GIT_SSH program to run with git's own options", async () => {
      const sha = await commitLocal("a");
      vi.stubEnv("GIT_SSH", await recordingSsh(root));

      await mirrorMain(deps(), local, sha);

      expect((await sshCall()).args).not.toContain("BatchMode");
    });

    it("run plain ssh in batch mode when nothing names an ssh command", async () => {
      const sha = await commitLocal("a");
      const bin = join(root, "bin");
      await recordingSsh(bin);
      vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);

      await mirrorMain(deps(), local, sha);

      expect((await sshCall()).args).toMatch(/^-o BatchMode=yes git@skills\.invalid /);
    });
  });

  it("push to an HTTPS remote without a GitHub identity with terminal prompts disabled", async () => {
    const sha = await commitLocal("a");
    const server = createServer((_, res) => {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="skills"' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      await git(local, "remote", "set-url", "origin", "https://skills.invalid/o/skills.git");
      // Only the push is rewritten, so origin still reads as HTTPS.
      await git(
        local,
        "config",
        `url.http://127.0.0.1:${address.port}/.pushInsteadOf`,
        "https://skills.invalid/",
      );
      await git(local, "config", "credential.helper", "");
      vi.stubEnv("GIT_TERMINAL_PROMPT", undefined);
      vi.stubEnv("GIT_ASKPASS", undefined);
      vi.stubEnv("SSH_ASKPASS", undefined);
      const d = deps();

      expect(await mirrorMain(d, local, sha)).toMatchObject({
        kind: "failed",
        failure: "auth",
        detail: expect.stringContaining("terminal prompts disabled"),
      });
      expect(d.secretsStore.getSecret).toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});
