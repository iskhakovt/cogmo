import { PassThrough, type Readable, type Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { ExecStreamingHandle, SandboxClient, SandboxSession } from "../sandbox/index.js";
import { reapSkillVenvs } from "./deps-reaper.js";

interface FakeExec {
  stdinSink: PassThrough;
  stdoutSource: PassThrough;
  stderrSource: PassThrough;
  handle: ExecStreamingHandle;
  /** Called after the script exits; ends streams and resolves wait(). */
  finish(stdout: string, exitCode: number, stderr?: string): void;
}

function makeFakeExec(): FakeExec {
  const stdinSink = new PassThrough();
  const stdoutSource = new PassThrough();
  const stderrSource = new PassThrough();
  let resolveWait: (v: { exitCode: number }) => void = () => {};
  const waitPromise = new Promise<{ exitCode: number }>((res) => {
    resolveWait = res;
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
    finish(stdout, exitCode, stderr) {
      stdoutSource.end(stdout);
      stderrSource.end(stderr ?? "");
      resolveWait({ exitCode });
    },
  };
}

interface ReaperHarness {
  sandbox: SandboxClient;
  session: SandboxSession;
  exec: FakeExec;
  stdinCapture: string;
}

function buildHarness(): ReaperHarness {
  const exec = makeFakeExec();
  const session = mock<SandboxSession>();
  session.execStreaming.mockResolvedValue(exec.handle);
  const sandbox = mock<SandboxClient>();
  sandbox.ensureImagePresent.mockResolvedValue();
  sandbox.create.mockResolvedValue(session);
  sandbox.delete.mockResolvedValue();
  const harness: ReaperHarness = { sandbox, session, exec, stdinCapture: "" };
  exec.stdinSink.on("data", (chunk: Buffer) => {
    harness.stdinCapture += chunk.toString("utf-8");
  });
  return harness;
}

describe("reapSkillVenvs", () => {
  it("threads `depsCacheVolume` onto the sandbox create spec and pipes reachable hashes via stdin", async () => {
    const h = buildHarness();
    const promise = reapSkillVenvs({
      sandbox: h.sandbox,
      image: "cogmo-skills:test",
      depsCacheVolumeName: "deps-vol-x",
      reachableHashes: new Set(["aaa", "bbb"]),
    });
    await new Promise((resolve) => setImmediate(resolve));
    h.exec.finish("", 0);
    const result = await promise;
    expect(result.isOk()).toBe(true);
    expect(h.sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "cogmo-skills:test",
        depsCacheVolume: { volumeName: "deps-vol-x" },
      }),
    );
    // Hashes streamed on stdin so the script can `grep -qxF` against
    // them; argv would cap out beyond a few hundred entries.
    expect(h.stdinCapture).toContain("aaa");
    expect(h.stdinCapture).toContain("bbb");
  });

  it("parses `reaped:<hash>` lines from script stdout into `reapedHashes`", async () => {
    const h = buildHarness();
    const promise = reapSkillVenvs({
      sandbox: h.sandbox,
      image: "cogmo-skills:test",
      depsCacheVolumeName: "deps-vol-x",
      reachableHashes: new Set(["aaa"]),
    });
    // Let the reaper attach its stream listeners before data flows.
    await new Promise((resolve) => setImmediate(resolve));
    h.exec.finish("reaped:ddd\nreaped:eee\n", 0);
    const result = await promise;
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect([...result.value.reapedHashes]).toEqual(["ddd", "eee"]);
  });

  it("returns `reap_failed` with stderr when the script exits non-zero", async () => {
    const h = buildHarness();
    const promise = reapSkillVenvs({
      sandbox: h.sandbox,
      image: "cogmo-skills:test",
      depsCacheVolumeName: "deps-vol-x",
      reachableHashes: new Set(),
    });
    await new Promise((resolve) => setImmediate(resolve));
    h.exec.finish("", 1, "rm: cannot remove dir: read-only volume\n");
    const result = await promise;
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("reap_failed");
    expect(result.error.message).toContain("read-only volume");
  });

  it("returns `transport_failed` when sandbox.create rejects", async () => {
    const sandbox = mock<SandboxClient>();
    sandbox.ensureImagePresent.mockResolvedValue();
    sandbox.create.mockRejectedValue(new Error("Daytona quota exceeded"));
    const result = await reapSkillVenvs({
      sandbox,
      image: "cogmo-skills:test",
      depsCacheVolumeName: "deps-vol-x",
      reachableHashes: new Set(),
    });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("transport_failed");
    expect(result.error.message).toContain("Daytona quota exceeded");
  });

  it("returns `transport_failed` when execStreaming itself rejects", async () => {
    // Distinct from the create-rejects path above: covers the
    // execStreaming throw (image build hiccup, transport error mid-attach).
    // Without the inner try/catch this would escape the function as an
    // unhandled rejection.
    const exec = makeFakeExec();
    const session = mock<SandboxSession>();
    session.execStreaming.mockRejectedValue(new Error("exec attach failed"));
    const sandbox = mock<SandboxClient>();
    sandbox.ensureImagePresent.mockResolvedValue();
    sandbox.create.mockResolvedValue(session);
    sandbox.delete.mockResolvedValue();
    const result = await reapSkillVenvs({
      sandbox,
      image: "cogmo-skills:test",
      depsCacheVolumeName: "deps-vol-x",
      reachableHashes: new Set(),
    });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("transport_failed");
    expect(result.error.message).toContain("exec attach failed");
    // Session teardown still fires even though we never wrote to its
    // exec handle.
    expect(sandbox.delete).toHaveBeenCalledTimes(1);
    // Suppress unused-variable warning from the local exec fixture --
    // we don't drive it here because execStreaming itself rejected.
    expect(exec.stdinSink).toBeDefined();
  });

  it("returns `transport_failed` when handle.wait() rejects (timeout / transport drop)", async () => {
    const exec = makeFakeExec();
    const session = mock<SandboxSession>();
    // Replace wait with a rejecting version. The fake's default returns
    // a Promise tied to `resolveWait`/`rejectWait`; here we short-circuit.
    exec.handle.wait = async () => {
      throw new Error("exec_timeout after 60000ms");
    };
    session.execStreaming.mockResolvedValue(exec.handle);
    const sandbox = mock<SandboxClient>();
    sandbox.ensureImagePresent.mockResolvedValue();
    sandbox.create.mockResolvedValue(session);
    sandbox.delete.mockResolvedValue();
    const result = await reapSkillVenvs({
      sandbox,
      image: "cogmo-skills:test",
      depsCacheVolumeName: "deps-vol-x",
      reachableHashes: new Set(["x"]),
    });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("transport_failed");
    expect(result.error.message).toContain("exec_timeout");
    expect(sandbox.delete).toHaveBeenCalledTimes(1);
  });

  it("captures a stream `error` event and surfaces it as `transport_failed`", async () => {
    // Stream-level errors (stdout/stderr/stdin emit 'error', e.g. a
    // broken pipe under the wire) would crash the host without the
    // listeners. Mirrors `makeSandboxLockfileCompiler`'s
    // streamError-as-transport_failed contract so the reaper has the
    // same posture.
    const h = buildHarness();
    const promise = reapSkillVenvs({
      sandbox: h.sandbox,
      image: "cogmo-skills:test",
      depsCacheVolumeName: "deps-vol-x",
      reachableHashes: new Set(),
    });
    await new Promise((resolve) => setImmediate(resolve));
    h.exec.stdoutSource.emit("error", new Error("pipe shattered"));
    h.exec.finish("", 0);
    const result = await promise;
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.kind).toBe("transport_failed");
    expect(result.error.message).toContain("pipe shattered");
  });

  it("always tears down the session, even on a script failure", async () => {
    const h = buildHarness();
    const promise = reapSkillVenvs({
      sandbox: h.sandbox,
      image: "cogmo-skills:test",
      depsCacheVolumeName: "deps-vol-x",
      reachableHashes: new Set(),
    });
    await new Promise((resolve) => setImmediate(resolve));
    h.exec.finish("", 1, "boom");
    await promise;
    expect(h.sandbox.delete).toHaveBeenCalledTimes(1);
  });

  it("forwards the grace-days arg to the script", async () => {
    const h = buildHarness();
    const promise = reapSkillVenvs({
      sandbox: h.sandbox,
      image: "cogmo-skills:test",
      depsCacheVolumeName: "deps-vol-x",
      reachableHashes: new Set(),
      graceDays: 14,
    });
    await new Promise((resolve) => setImmediate(resolve));
    h.exec.finish("", 0);
    await promise;
    const execArgs = vi.mocked(h.session.execStreaming).mock.calls[0]?.[0];
    expect(execArgs).toEqual(expect.arrayContaining(["14"]));
  });
});
