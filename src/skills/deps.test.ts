import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type MockProxy, mock } from "vitest-mock-extended";
import type { ExecStreamingHandle, SandboxClient, SandboxSession } from "../sandbox/index.js";
import {
  ensureVenvPopulated,
  makeSandboxLockfileCompiler,
  REQUIREMENTS_LOCK_FILE,
  readLockfileAtSha,
  SKILL_VENVS_DIR,
} from "./deps.js";
import { bootstrapSkillsRepo } from "./repo.js";

const execFileP = promisify(execFile);

interface Setup {
  bare: string;
  work: string;
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
    setup = { bare, work };
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function commit(files: Record<string, string>): Promise<string> {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(setup.work, name), content);
    }
    await execFileP("git", ["-C", setup.work, "add", "."]);
    await execFileP("git", ["-C", setup.work, "commit", "-m", "test", "--allow-empty"]);
    const { stdout } = await execFileP("git", ["-C", setup.work, "rev-parse", "HEAD"]);
    return stdout.trim();
  }

  it("returns the sha256 hash and contents when the lockfile is present", async () => {
    const contents = "httpx==0.27.0 --hash=sha256:abc\n";
    const sha = await commit({ [REQUIREMENTS_LOCK_FILE]: contents });
    const result = await readLockfileAtSha(setup.work, sha);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.contents).toBe(contents);
    expect(result.value.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the same hash for the same contents (deterministic)", async () => {
    const contents = "pydantic==2.5.3 --hash=sha256:def\n";
    const sha1 = await commit({ [REQUIREMENTS_LOCK_FILE]: contents, "extra.txt": "a" });
    const sha2 = await commit({ [REQUIREMENTS_LOCK_FILE]: contents, "extra.txt": "b" });
    const r1 = await readLockfileAtSha(setup.work, sha1);
    const r2 = await readLockfileAtSha(setup.work, sha2);
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
      const result = await readLockfileAtSha(dir, stdout.trim());
      expect(result.isErr()).toBe(true);
      if (!result.isErr()) return;
      expect(result.error.kind).toBe("missing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns 'empty' when the lockfile is committed but blank", async () => {
    const sha = await commit({ [REQUIREMENTS_LOCK_FILE]: "  \n\n" });
    const result = await readLockfileAtSha(setup.work, sha);
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
    stdin: stdinSink as unknown as Writable,
    stdout: stdoutSource as unknown as Readable,
    stderr: stderrSource as unknown as Readable,
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
    expect(h.createCalls[0]).toMatchObject({ image: "cogmo-skills:test" });
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
      stdout: new PassThrough() as unknown as Readable,
      stderr: new PassThrough() as unknown as Readable,
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

describe("ensureVenvPopulated", () => {
  it("returns the venv path when uv pip sync exits 0", async () => {
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
    if (!result.isOk()) return;
    expect(result.value).toBe(`${SKILL_VENVS_DIR}/abc123`);

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
      stdout: new PassThrough() as unknown as Readable,
      stderr: new PassThrough() as unknown as Readable,
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
});
