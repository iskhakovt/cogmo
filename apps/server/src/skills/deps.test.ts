import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { err, ok } from "neverthrow";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type MockProxy, mock } from "vitest-mock-extended";
import type { ExecStreamingHandle, SandboxClient, SandboxSession } from "../sandbox/index.js";
import { expectDefined } from "../test/assertions.js";
import { repoRoot } from "../test/repo-root.js";
import { skillsRepoAt } from "../test/skills-repo.js";
import {
  ensureVenvPopulated,
  isLockfileContentRefusal,
  makeSandboxLockfileCompiler,
  parseLockfileEntries,
  parseLockfilePackageSpecs,
  REQUIREMENTS_LOCK_FILE,
  readLockfileAtSha,
} from "./deps.js";
import { bootstrapSkillsRepo } from "./repo.js";

/** The runtime virtualenv, as `images/skills/Dockerfile` declares it. */
function dockerfileRuntimeVenv(): string {
  const dockerfile = readFileSync(join(repoRoot(), "images/skills/Dockerfile"), "utf8");
  return expectDefined(
    /^ENV VIRTUAL_ENV="([^"]+)"$/m.exec(dockerfile)?.[1],
    "images/skills/Dockerfile's ENV VIRTUAL_ENV",
  );
}

import type { SkillsRepo } from "./skill-files.js";

const execFileP = promisify(execFile);

interface Setup {
  bare: string;
  work: string;
  /** The working clone as a skills repo, its first commit the layout commit. */
  repo: SkillsRepo;
}

describe("readLockfileAtSha", () => {
  let setup: Setup;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "skills-deps-"));
    const bare = join(root, "skills.git");
    const work = join(root, "work");
    await bootstrapSkillsRepo({ path: bare });
    await execFileP("mkdir", [work]);
    await execFileP("git", ["init", "-b", "main", work]);
    await execFileP("git", ["-C", work, "config", "user.email", "test@cogmo.dev"]);
    await execFileP("git", ["-C", work, "config", "user.name", "test"]);
    await execFileP("git", ["-C", work, "config", "commit.gpgsign", "false"]);
    await execFileP("git", ["-C", work, "remote", "add", "origin", bare]);
    await execFileP("git", ["-C", work, "commit", "-q", "--allow-empty", "-m", "layout"]);
    const { stdout } = await execFileP("git", ["-C", work, "rev-parse", "HEAD"]);
    setup = { bare, work, repo: skillsRepoAt(work, stdout.trim()) };
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function commit(files: Record<string, string>): Promise<string> {
    await mkdir(join(setup.work, "skills", "echo"), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(setup.work, "skills", "echo", name), content);
    }
    await execFileP("git", ["-C", setup.work, "add", "."]);
    await execFileP("git", ["-C", setup.work, "commit", "-m", "test", "--allow-empty"]);
    const { stdout } = await execFileP("git", ["-C", setup.work, "rev-parse", "HEAD"]);
    return stdout.trim();
  }

  it("returns the sha256 hash and contents when the lockfile is present", async () => {
    const contents = "httpx==0.27.0 --hash=sha256:abc\n";
    const sha = await commit({ [REQUIREMENTS_LOCK_FILE]: contents });
    const result = await readLockfileAtSha(setup.repo, "echo", sha);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.contents).toBe(contents);
    expect(result.value.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the same hash for the same contents (deterministic)", async () => {
    const contents = "pydantic==2.5.3 --hash=sha256:def\n";
    const sha1 = await commit({ [REQUIREMENTS_LOCK_FILE]: contents, "extra.txt": "a" });
    const sha2 = await commit({ [REQUIREMENTS_LOCK_FILE]: contents, "extra.txt": "b" });
    const r1 = await readLockfileAtSha(setup.repo, "echo", sha1);
    const r2 = await readLockfileAtSha(setup.repo, "echo", sha2);
    expect(r1.isOk()).toBe(true);
    expect(r2.isOk()).toBe(true);
    if (!r1.isOk() || !r2.isOk()) return;
    expect(r1.value.hash).toBe(r2.value.hash);
  });

  it("returns 'missing' when the lockfile is not committed at this sha", async () => {
    // Fresh repo with zero lockfile history — avoids dependency on
    // commits left by earlier tests in the shared fixture.
    const dir = await mkdtemp(join(tmpdir(), "skills-deps-missing-"));
    try {
      await execFileP("git", ["init", "-b", "main", dir]);
      await execFileP("git", ["-C", dir, "config", "user.email", "test@cogmo.dev"]);
      await execFileP("git", ["-C", dir, "config", "user.name", "test"]);
      await execFileP("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
      await writeFile(join(dir, "other.txt"), "x");
      await execFileP("git", ["-C", dir, "add", "."]);
      await execFileP("git", ["-C", dir, "commit", "-m", "no lockfile"]);
      const { stdout } = await execFileP("git", ["-C", dir, "rev-parse", "HEAD"]);
      const result = await readLockfileAtSha(
        skillsRepoAt(dir, stdout.trim()),
        "echo",
        stdout.trim(),
      );
      expect(result.isErr()).toBe(true);
      if (!result.isErr()) return;
      expect(result.error.kind).toBe("missing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns 'empty' when the lockfile is committed but blank", async () => {
    const sha = await commit({ [REQUIREMENTS_LOCK_FILE]: "  \n\n" });
    const result = await readLockfileAtSha(setup.repo, "echo", sha);
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("empty");
  });
});

/**
 * Stub a minimal `ExecStreamingHandle` that records what's written to
 * stdin and emits scripted stdout/stderr + exit code. The compiler
 * never reads from stdout/stderr async until the streams are
 * connected, so we feed them after `execStreaming` resolves and
 * before `wait()` settles.
 */
interface FakeExec {
  stdinSink: PassThrough;
  stdoutSource: PassThrough;
  stderrSource: PassThrough;
  handle: ExecStreamingHandle;
  waitResolve(exitCode: number): void;
  waitReject(err: Error): void;
}

function makeFakeExec(): FakeExec {
  const stdinSink = new PassThrough();
  const stdoutSource = new PassThrough();
  const stderrSource = new PassThrough();
  let resolveWait: (v: { exitCode: number }) => void = () => {};
  let rejectWait: (e: Error) => void = () => {};
  const waitPromise = new Promise<{ exitCode: number }>((res, rej) => {
    resolveWait = res;
    rejectWait = rej;
  });
  const handle: ExecStreamingHandle = {
    stdin: stdinSink,
    stdout: stdoutSource,
    stderr: stderrSource,
    exited: waitPromise.then(
      (exit) => ok(exit),
      (error: Error) => err({ kind: "transport_failed", error }),
    ),
    wait: () => waitPromise,
    dispose: async () => {
      stdoutSource.end();
      stderrSource.end();
    },
  };
  return {
    stdinSink,
    stdoutSource,
    stderrSource,
    handle,
    waitResolve(exitCode) {
      stdoutSource.end();
      stderrSource.end();
      resolveWait({ exitCode });
    },
    waitReject(err) {
      rejectWait(err);
    },
  };
}

interface CompilerHarness {
  sandbox: MockProxy<SandboxClient>;
  session: MockProxy<SandboxSession>;
  ensureCalls: Array<[string, unknown]>;
  createCalls: Array<unknown>;
  deleteCalls: number;
}

function buildCompilerHarness(execFactory: () => FakeExec): CompilerHarness & { exec: FakeExec } {
  const exec = execFactory();
  const session = mock<SandboxSession>();
  session.execStreaming.mockResolvedValue(exec.handle);

  const sandbox = mock<SandboxClient>();
  const ensureCalls: Array<[string, unknown]> = [];
  const createCalls: Array<unknown> = [];
  let deleteCalls = 0;
  sandbox.ensureImagePresent.mockImplementation(async (image, limits) => {
    ensureCalls.push([image, limits]);
  });
  sandbox.create.mockImplementation(async (spec) => {
    createCalls.push(spec);
    return session;
  });
  sandbox.delete.mockImplementation(async () => {
    deleteCalls += 1;
  });

  return {
    sandbox,
    session,
    ensureCalls,
    createCalls,
    get deleteCalls() {
      return deleteCalls;
    },
    exec,
  };
}

describe("makeSandboxLockfileCompiler", () => {
  it("streams deps to stdin and returns stdout on a successful compile", async () => {
    const h = buildCompilerHarness(makeFakeExec);
    const compiler = makeSandboxLockfileCompiler({
      sandbox: h.sandbox,
      image: "cogmo-skills:test",
    });

    const promise = compiler.compile(["httpx==0.27.0", "pydantic==2.5.3"]);

    // Let the compiler wire up listeners before we feed the streams.
    await new Promise((r) => setImmediate(r));
    h.exec.stdoutSource.write(
      "httpx==0.27.0 --hash=sha256:abc\npydantic==2.5.3 --hash=sha256:def\n",
    );
    h.exec.waitResolve(0);

    const result = await promise;
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value).toBe(
      "httpx==0.27.0 --hash=sha256:abc\npydantic==2.5.3 --hash=sha256:def\n",
    );

    // The exec command shape is part of the contract.
    expect(h.session.execStreaming).toHaveBeenCalledWith(
      ["uv", "pip", "compile", "--generate-hashes", "--no-header", "--quiet", "-"],
      expect.objectContaining({ attachStdin: true }),
    );

    // Deps were written to stdin in name==version-per-line form.
    expect(h.exec.stdinSink.read()?.toString("utf-8")).toBe("httpx==0.27.0\npydantic==2.5.3\n");

    // Session lifecycle — created with the requested image, deleted in finally.
    expect(h.ensureCalls[0]?.[0]).toBe("cogmo-skills:test");
    expect(h.createCalls[0]).toMatchObject({
      image: "cogmo-skills:test",
      network: "bridge",
      // Local-Docker names the session's cgroup slice after its task id, which must be a UUID.
      taskId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
    });
    expect(h.deleteCalls).toBe(1);
  });

  it("returns resolver_failed when uv exits non-zero, carrying stderr", async () => {
    const h = buildCompilerHarness(makeFakeExec);
    const compiler = makeSandboxLockfileCompiler({
      sandbox: h.sandbox,
      image: "cogmo-skills:test",
    });

    const promise = compiler.compile(["nonexistent-pkg==999.0"]);
    await new Promise((r) => setImmediate(r));
    h.exec.stderrSource.write("error: Distribution not found at: nonexistent-pkg==999.0\n");
    h.exec.waitResolve(2);

    const result = await promise;
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("resolver_failed");
    expect(result.error.message).toMatch(/Distribution not found/);
    expect(h.deleteCalls).toBe(1);
  });

  it("returns transport_failed when wait() rejects (exec broken)", async () => {
    const h = buildCompilerHarness(makeFakeExec);
    const compiler = makeSandboxLockfileCompiler({
      sandbox: h.sandbox,
      image: "cogmo-skills:test",
    });

    const promise = compiler.compile(["httpx==0.27.0"]);
    await new Promise((r) => setImmediate(r));
    h.exec.waitReject(new Error("docker socket closed"));

    const result = await promise;
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("transport_failed");
    expect(result.error.message).toMatch(/docker socket/);
    expect(h.deleteCalls).toBe(1);
  });

  it("returns transport_failed when execStreaming returns without stdin", async () => {
    const h = buildCompilerHarness(makeFakeExec);
    // Override execStreaming to return a handle with no stdin (e.g. backend
    // misconfiguration that silently dropped attachStdin).
    h.session.execStreaming.mockResolvedValueOnce({
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exited: Promise.resolve(ok({ exitCode: 0 })),
      wait: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    const compiler = makeSandboxLockfileCompiler({
      sandbox: h.sandbox,
      image: "cogmo-skills:test",
    });

    const result = await compiler.compile(["httpx==0.27.0"]);
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("transport_failed");
    expect(result.error.message).toMatch(/without stdin/);
    expect(h.deleteCalls).toBe(1);
  });

  it("returns transport_failed when ensureImagePresent throws (sandbox startup)", async () => {
    const sandbox = mock<SandboxClient>();
    sandbox.ensureImagePresent.mockRejectedValue(new Error("docker daemon offline"));
    const compiler = makeSandboxLockfileCompiler({
      sandbox,
      image: "cogmo-skills:test",
    });
    const result = await compiler.compile(["httpx==0.27.0"]);
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("transport_failed");
    expect(result.error.message).toMatch(/docker daemon offline/);
    // No session was created → no delete to make.
    expect(sandbox.create).not.toHaveBeenCalled();
    expect(sandbox.delete).not.toHaveBeenCalled();
  });

  it("returns transport_failed when sandbox.create throws (post-image)", async () => {
    const sandbox = mock<SandboxClient>();
    sandbox.ensureImagePresent.mockResolvedValue(undefined);
    sandbox.create.mockRejectedValue(new Error("quota exceeded"));
    const compiler = makeSandboxLockfileCompiler({
      sandbox,
      image: "cogmo-skills:test",
    });
    const result = await compiler.compile(["httpx==0.27.0"]);
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("transport_failed");
    expect(result.error.message).toMatch(/quota exceeded/);
    // create() rejected before returning a session → nothing to delete.
    expect(sandbox.delete).not.toHaveBeenCalled();
  });

  it("hands its signal to the exec", async () => {
    const h = buildCompilerHarness(makeFakeExec);
    const compiler = makeSandboxLockfileCompiler({
      sandbox: h.sandbox,
      image: "cogmo-skills:test",
    });
    const { signal } = new AbortController();

    const promise = compiler.compile(["httpx==0.27.0"], { signal });
    await new Promise((r) => setImmediate(r));
    h.exec.waitResolve(0);
    await promise;

    expect(h.session.execStreaming).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ signal }),
    );
  });

  it("runs from / with uv's config discovery off, as the populate script does", async () => {
    // Why: see `DEPENDENCY_EXEC_OPTIONS`.
    const h = buildCompilerHarness(makeFakeExec);
    const compiler = makeSandboxLockfileCompiler({
      sandbox: h.sandbox,
      image: "cogmo-skills:test",
    });

    const promise = compiler.compile(["httpx==0.27.0"]);
    await new Promise((r) => setImmediate(r));
    h.exec.waitResolve(0);
    await promise;

    const [, options] = expectDefined(h.session.execStreaming.mock.calls[0], "compile exec");
    expect(options).toMatchObject({ workingDir: "/", env: { UV_NO_CONFIG: "1" } });
  });

  it("starts nothing once its signal has aborted", async () => {
    const h = buildCompilerHarness(makeFakeExec);
    // An exec that would finish at once, so a compile that starts anyway returns.
    h.exec.waitResolve(0);
    const compiler = makeSandboxLockfileCompiler({
      sandbox: h.sandbox,
      image: "cogmo-skills:test",
    });

    const result = await compiler.compile(["httpx==0.27.0"], {
      signal: AbortSignal.abort(new Error("register deadline")),
    });

    expect(result).toEqual(err({ kind: "transport_failed", message: "register deadline" }));
    expect(h.sandbox.ensureImagePresent).not.toHaveBeenCalled();
    expect(h.sandbox.create).not.toHaveBeenCalled();
  });

  it("starts no session once its signal aborts during the image check", async () => {
    const h = buildCompilerHarness(makeFakeExec);
    h.exec.waitResolve(0);
    const controller = new AbortController();
    h.sandbox.ensureImagePresent.mockImplementation(async () => controller.abort());
    const compiler = makeSandboxLockfileCompiler({
      sandbox: h.sandbox,
      image: "cogmo-skills:test",
    });

    const result = await compiler.compile(["httpx==0.27.0"], { signal: controller.signal });

    expect(h.sandbox.create).not.toHaveBeenCalled();
    expect(result.isErr()).toBe(true);
  });

  it("stops waiting for the image once its signal aborts", async () => {
    const h = buildCompilerHarness(makeFakeExec);
    // A pull or snapshot build that never finishes.
    h.sandbox.ensureImagePresent.mockReturnValue(new Promise(() => {}));
    const compiler = makeSandboxLockfileCompiler({
      sandbox: h.sandbox,
      image: "cogmo-skills:test",
    });
    const controller = new AbortController();

    const promise = compiler.compile(["httpx==0.27.0"], { signal: controller.signal });
    await new Promise((r) => setImmediate(r));
    controller.abort(new Error("register deadline"));

    expect(await promise).toEqual(err({ kind: "transport_failed", message: "register deadline" }));
    expect(h.sandbox.create).not.toHaveBeenCalled();
  });

  it("waits for the exec's teardown before deleting its session", async () => {
    const h = buildCompilerHarness(makeFakeExec);
    const teardown = Promise.withResolvers<void>();
    const order: string[] = [];
    h.exec.handle.dispose = vi.fn(async () => {
      await teardown.promise;
      order.push("exec torn down");
    });
    h.sandbox.delete.mockImplementation(async () => {
      order.push("session deleted");
    });
    const compiler = makeSandboxLockfileCompiler({
      sandbox: h.sandbox,
      image: "cogmo-skills:test",
    });

    const promise = compiler.compile(["httpx==0.27.0"]);
    await new Promise((r) => setImmediate(r));
    h.exec.waitReject(new Error("exec was disposed"));
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual([]);
    teardown.resolve();
    await promise;

    expect(order).toEqual(["exec torn down", "session deleted"]);
  });

  it("captures a stream 'error' event as transport_failed (no unhandled exception)", async () => {
    const h = buildCompilerHarness(makeFakeExec);
    const compiler = makeSandboxLockfileCompiler({
      sandbox: h.sandbox,
      image: "cogmo-skills:test",
    });
    const promise = compiler.compile(["httpx==0.27.0"]);
    await new Promise((r) => setImmediate(r));
    // Emit `error` on stdout — without an `'error'` listener Node would
    // crash the process. The compiler attaches one and folds the error
    // into the Result.
    h.exec.stdoutSource.emit("error", new Error("backend socket reset"));
    h.exec.waitResolve(0);
    const result = await promise;
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("transport_failed");
    expect(result.error.message).toMatch(/backend socket reset/);
  });

  it("returns transport_failed and aborts the exec on stdout > 1 MiB", async () => {
    const h = buildCompilerHarness(makeFakeExec);
    const disposeSpy = vi.fn().mockResolvedValue(undefined);
    h.exec.handle.dispose = disposeSpy;
    const compiler = makeSandboxLockfileCompiler({
      sandbox: h.sandbox,
      image: "cogmo-skills:test",
    });
    const promise = compiler.compile(["httpx==0.27.0"]);
    await new Promise((r) => setImmediate(r));
    // Single 2 MiB chunk trips the cap on the first write — the
    // compiler must call dispose() so uv stops blocking on its pipe.
    h.exec.stdoutSource.write(Buffer.alloc(2 * 1024 * 1024, "x"));
    h.exec.waitResolve(0);
    const result = await promise;
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("transport_failed");
    expect(result.error.message).toMatch(/exceeded/);
    expect(disposeSpy).toHaveBeenCalled();
  });
});

describe("isLockfileContentRefusal", () => {
  // Each as uv 0.13.6 writes it from `uv pip sync --require-hashes --only-binary=:all:`;
  // deps.sysbox.integration.test.ts reproduces them with the image's uv.
  it.each([
    "error: No solution found when resolving dependencies\n  cause: Because docopt==0.6.2 has no usable wheels and you require docopt==0.6.2, we can conclude that your requirements are unsatisfiable.",
    "error: No solution found when resolving dependencies\n  cause: Because pywin32==306 has no wheels with a matching Python ABI tag (e.g., `cp314`) and you require pywin32==306, we can conclude that your requirements are unsatisfiable.",
    "error: Failed to download `idna==3.10`\n  cause: Hash mismatch for `idna==3.10`\n\n         Expected:\n           sha256:00",
    "error: In `--require-hashes` mode, all requirements must have a hash, but none were provided for: idna==3.10",
  ])("reads uv refusing the lockfile's content: %s", (message) => {
    expect(isLockfileContentRefusal(message)).toBe(true);
  });

  it.each([
    "error: Failed to fetch: https://pypi.org/simple/idna/\n  cause: error sending request for url (https://pypi.org/simple/idna/)\n  cause: dns error",
    "error: Request failed after 3 retries in 26.6s",
    "populate_failed: rename /skill-venvs/x.tmp.1 → /skill-venvs/x failed and /skill-venvs/x is not ready: No space left on device",
    "error: No solution found when resolving dependencies\n  cause: Because there is no version of idna==99.99 and you require idna==99.99, we can conclude that your requirements are unsatisfiable.",
    "uv pip sync exited 1",
  ])("leaves any other failure to a retry: %s", (message) => {
    expect(isLockfileContentRefusal(message)).toBe(false);
  });
});

describe("parseLockfilePackageSpecs", () => {
  it("extracts name==version from a real uv pip compile output", () => {
    const lockfile = `# This file was autogenerated by uv via the following command:
#    uv pip compile --generate-hashes -
anyio==4.7.0 \\
    --hash=sha256:0000000000000000000000000000000000000000000000000000000000000000 \\
    --hash=sha256:1111111111111111111111111111111111111111111111111111111111111111
httpx==0.27.0 \\
    --hash=sha256:2222222222222222222222222222222222222222222222222222222222222222
pydantic==2.5.3 \\
    --hash=sha256:3333333333333333333333333333333333333333333333333333333333333333
    # via httpx (annotation, ignored)
`;
    expect(parseLockfilePackageSpecs(lockfile)).toEqual([
      "anyio==4.7.0",
      "httpx==0.27.0",
      "pydantic==2.5.3",
    ]);
  });

  it("returns an empty list for a comments-only file", () => {
    expect(parseLockfilePackageSpecs("# header\n# another\n")).toEqual([]);
  });

  it("handles a single-line spec with no trailing backslash", () => {
    expect(parseLockfilePackageSpecs("requests==2.31.0\n")).toEqual(["requests==2.31.0"]);
  });

  it("preserves declared order across multiple deps", () => {
    expect(parseLockfilePackageSpecs("alpha==1.0\nbeta==2.0\ngamma==3.0\n")).toEqual([
      "alpha==1.0",
      "beta==2.0",
      "gamma==3.0",
    ]);
  });

  it("accepts PEP 440 epoch, pre-release, and local version segments", () => {
    expect(
      parseLockfilePackageSpecs("reset-scheme==1!2.0.0\nalpha==1.0.0rc1\ngamma==3.0+local\n"),
    ).toEqual(["reset-scheme==1!2.0.0", "alpha==1.0.0rc1", "gamma==3.0+local"]);
  });

  it("ignores trailing inline comments and via-annotations on the spec line", () => {
    expect(parseLockfilePackageSpecs("httpx==0.27.0 # via something\nrequests==2.31.0\n")).toEqual([
      "httpx==0.27.0",
      "requests==2.31.0",
    ]);
  });
});

describe("parseLockfileEntries", () => {
  const A = "a".repeat(64);
  const B = "B".repeat(64);
  const C = "c".repeat(64);

  it("collects every continuation-line hash under its spec", () => {
    const lockfile = `anyio==4.7.0 \\
    --hash=sha256:${A} \\
    --hash=sha256:${B}
    # via httpx
httpx==0.27.0 \\
    --hash=sha256:${C}
`;
    expect(parseLockfileEntries(lockfile)).toEqual([
      { name: "anyio", version: "4.7.0", sha256: [A, B.toLowerCase()] },
      { name: "httpx", version: "0.27.0", sha256: [C] },
    ]);
  });

  it("reads hashes written on the spec line itself", () => {
    expect(parseLockfileEntries(`httpx==0.27.0 --hash=sha256:${A}\n`)).toEqual([
      { name: "httpx", version: "0.27.0", sha256: [A] },
    ]);
  });

  it("gives an unhashed spec an empty hash list", () => {
    expect(parseLockfileEntries("requests==2.31.0\n")).toEqual([
      { name: "requests", version: "2.31.0", sha256: [] },
    ]);
  });

  it("skips non-sha256 hashes, comments and option lines", () => {
    const lockfile = `# header
--index-url https://pypi.org/simple
idna==3.10 \\
    --hash=md5:${A} \\
    --hash=sha256:${C}
`;
    expect(parseLockfileEntries(lockfile)).toEqual([
      { name: "idna", version: "3.10", sha256: [C] },
    ]);
  });

  it("does not read a hash out of a comment", () => {
    expect(parseLockfileEntries(`idna==3.10 # --hash=sha256:${A}\n`)).toEqual([
      { name: "idna", version: "3.10", sha256: [] },
    ]);
  });
});

describe("ensureVenvPopulated", () => {
  it("hands its signal to the exec", async () => {
    const exec = makeFakeExec();
    const session = mock<SandboxSession>();
    session.execStreaming.mockResolvedValue(exec.handle);
    const { signal } = new AbortController();

    const promise = ensureVenvPopulated({
      session,
      lockfileHash: "abc123",
      lockfileContents: "httpx==0.27.0 --hash=sha256:0\n",
      workerId: "worker-1",
      signal,
    });
    await new Promise((r) => setImmediate(r));
    exec.waitResolve(0);
    await promise;

    expect(session.execStreaming).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ signal }),
    );
  });

  it("succeeds when uv pip sync exits 0 (path computed by supervisor; host returns void)", async () => {
    const exec = makeFakeExec();
    const session = mock<SandboxSession>();
    session.execStreaming.mockResolvedValue(exec.handle);

    const promise = ensureVenvPopulated({
      session,
      lockfileHash: "abc123",
      lockfileContents: "httpx==0.27.0 --hash=sha256:0\n",
      workerId: "worker-1",
    });

    await new Promise((r) => setImmediate(r));
    exec.waitResolve(0);
    const result = await promise;

    expect(result.isOk()).toBe(true);

    // Lockfile body was written to stdin.
    expect(exec.stdinSink.read()?.toString("utf-8")).toBe("httpx==0.27.0 --hash=sha256:0\n");

    // Argv shape: `sh -c <SCRIPT> populate <hash> <workerId>`. The
    // script's POPULATE_SCRIPT body is the third argv; we don't pin
    // its full contents here (lives in the module), but the
    // positional args matter for the populate behaviour.
    const call = session.execStreaming.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    const argv = call[0];
    expect(argv[0]).toBe("sh");
    expect(argv[1]).toBe("-c");
    expect(argv[3]).toBe("populate");
    expect(argv[4]).toBe("abc123");
    expect(argv[5]).toBe("worker-1");
    expect(call[1]?.attachStdin).toBe(true);
  });

  it("reads the ABI tag with the runtime interpreter and the exec's cwd off sys.path", async () => {
    // Why the path and `-I`: see `RUNTIME_PYTHON` and `PYTHON_ABI_TAG_COMMAND`.
    const exec = makeFakeExec();
    const session = mock<SandboxSession>();
    session.execStreaming.mockResolvedValue(exec.handle);

    const promise = ensureVenvPopulated({
      session,
      lockfileHash: "abc123",
      lockfileContents: "httpx==0.27.0\n",
      workerId: "worker-1",
    });
    await new Promise((r) => setImmediate(r));
    exec.waitResolve(0);
    await promise;

    const [argv] = expectDefined(session.execStreaming.mock.calls[0], "populate exec");
    const script = expectDefined(argv[2], "populate script");
    expect(/^PY_ABI=\$\((.*)\)$/m.exec(script)?.[1]).toBe(
      `${dockerfileRuntimeVenv()}/bin/python3 -I -m cogmo_skills_runtime.abi`,
    );
  });

  it("runs from / with uv's config discovery off, so uv ignores config a task planted in $HOME", async () => {
    // Why: see `DEPENDENCY_EXEC_OPTIONS`. The sysbox tier plants a
    // `.python-version` and a user `uv.toml` and populates
    // (`runner.sysbox.integration.test.ts`).
    const exec = makeFakeExec();
    const session = mock<SandboxSession>();
    session.execStreaming.mockResolvedValue(exec.handle);

    const promise = ensureVenvPopulated({
      session,
      lockfileHash: "abc123",
      lockfileContents: "httpx==0.27.0\n",
      workerId: "worker-1",
    });
    await new Promise((r) => setImmediate(r));
    exec.waitResolve(0);
    await promise;

    const [, options] = expectDefined(session.execStreaming.mock.calls[0], "populate exec");
    expect(options).toMatchObject({ workingDir: "/", env: { UV_NO_CONFIG: "1" } });
  });

  it("returns populate_failed with stderr on non-zero exit", async () => {
    const exec = makeFakeExec();
    const session = mock<SandboxSession>();
    session.execStreaming.mockResolvedValue(exec.handle);

    const promise = ensureVenvPopulated({
      session,
      lockfileHash: "abc123",
      lockfileContents: "httpx==0.27.0\n",
      workerId: "worker-1",
    });

    await new Promise((r) => setImmediate(r));
    exec.stderrSource.write("error: hash mismatch on httpx-0.27.0-py3-none-any.whl\n");
    exec.waitResolve(1);
    const result = await promise;

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("populate_failed");
    expect(result.error.message).toMatch(/hash mismatch/);
  });

  it("returns transport_failed when wait() rejects", async () => {
    const exec = makeFakeExec();
    const session = mock<SandboxSession>();
    session.execStreaming.mockResolvedValue(exec.handle);

    const promise = ensureVenvPopulated({
      session,
      lockfileHash: "abc123",
      lockfileContents: "httpx==0.27.0\n",
      workerId: "worker-1",
    });

    await new Promise((r) => setImmediate(r));
    exec.waitReject(new Error("connection reset"));
    const result = await promise;

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("transport_failed");
    expect(result.error.message).toMatch(/connection reset/);
  });

  it("returns transport_failed when the exec's socket fails, leaving no stream error unhandled", async () => {
    const uncaught = vi.fn();
    process.on("uncaughtException", uncaught);
    try {
      const exec = makeFakeExec();
      const session = mock<SandboxSession>();
      session.execStreaming.mockResolvedValue(exec.handle);

      const promise = ensureVenvPopulated({
        session,
        lockfileHash: "abc123",
        lockfileContents: "httpx==0.27.0\n",
        workerId: "worker-1",
      });

      await new Promise((r) => setImmediate(r));
      // The sandbox forwards a socket error to both demuxed streams and to wait().
      const reset = new Error("read ECONNRESET");
      exec.stdoutSource.destroy(reset);
      exec.stderrSource.destroy(reset);
      exec.waitReject(reset);
      const result = await promise;

      expect(result.isErr()).toBe(true);
      if (!result.isErr()) return;
      expect(result.error.kind).toBe("transport_failed");
      expect(result.error.message).toMatch(/read ECONNRESET/);
      await new Promise((r) => setImmediate(r));
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off("uncaughtException", uncaught);
    }
  });

  it("returns transport_failed when a stream fails though the script exits 0", async () => {
    const exec = makeFakeExec();
    const session = mock<SandboxSession>();
    session.execStreaming.mockResolvedValue(exec.handle);

    const promise = ensureVenvPopulated({
      session,
      lockfileHash: "abc123",
      lockfileContents: "httpx==0.27.0\n",
      workerId: "worker-1",
    });

    await new Promise((r) => setImmediate(r));
    exec.stderrSource.emit("error", new Error("backend socket reset"));
    exec.waitResolve(0);
    const result = await promise;

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("transport_failed");
    expect(result.error.message).toMatch(/backend socket reset/);
  });

  it("returns transport_failed when execStreaming itself throws", async () => {
    const session = mock<SandboxSession>();
    session.execStreaming.mockRejectedValue(new Error("docker daemon unreachable"));

    const result = await ensureVenvPopulated({
      session,
      lockfileHash: "abc123",
      lockfileContents: "httpx==0.27.0\n",
      workerId: "worker-1",
    });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("transport_failed");
    expect(result.error.message).toMatch(/docker daemon unreachable/);
  });

  it("returns transport_failed when execStreaming returns without stdin", async () => {
    const session = mock<SandboxSession>();
    session.execStreaming.mockResolvedValueOnce({
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exited: Promise.resolve(ok({ exitCode: 0 })),
      wait: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    const result = await ensureVenvPopulated({
      session,
      lockfileHash: "abc123",
      lockfileContents: "httpx==0.27.0\n",
      workerId: "worker-1",
    });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("transport_failed");
    expect(result.error.message).toMatch(/without stdin/);
  });

  it("is idempotent — repeat calls with same hash re-invoke the script (which short-circuits on .ready)", async () => {
    // Host never caches; it dispatches the populate every time and
    // trusts the script's `.ready` check to no-op. This pins that
    // contract — execStreaming fires on the second call too.
    const session = mock<SandboxSession>();
    session.execStreaming.mockImplementation(async () => {
      const exec = makeFakeExec();
      setImmediate(() => exec.waitResolve(0));
      return exec.handle;
    });

    const opts = {
      session,
      lockfileHash: "abc123",
      lockfileContents: "httpx==0.27.0\n",
      workerId: "worker-1",
    };
    const r1 = await ensureVenvPopulated(opts);
    const r2 = await ensureVenvPopulated(opts);

    expect(r1.isOk()).toBe(true);
    expect(r2.isOk()).toBe(true);
    expect(session.execStreaming).toHaveBeenCalledTimes(2);
  });
});
