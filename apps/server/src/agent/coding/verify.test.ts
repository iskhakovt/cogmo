import { PassThrough } from "node:stream";
import { err, ok, type Result } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ExecExit,
  type ExecFailure,
  type ExecOptions,
  type ExecStreamingHandle,
  ExecTimeoutError,
} from "../../sandbox/index.js";
import { fakeExecHandle } from "../../test/coding-fixtures.js";
import { OUTPUT_CAP_BYTES, runVerifyStreaming, TIMEOUT_EXIT_CODE } from "./verify.js";

interface FakeExecOpts {
  stdoutChunks?: ReadonlyArray<string>;
  stderrChunks?: ReadonlyArray<string>;
  exitCode?: number;
  /** Delay (ms) before each chunk emits. Drives timeout tests. */
  chunkDelayMs?: number;
  /** Delay (ms) between streams ending and exit being reported. */
  exitDelayMs?: number;
  /** The command never exits: the exec settles only on its `timeoutMs`, as a backend would. */
  hang?: boolean;
  /** The transport fails: both streams fail with this error, and so does the exec. */
  transportError?: Error;
}

function fakeExec(opts: FakeExecOpts, execOpts: ExecOptions = {}): ExecStreamingHandle {
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const pump = async (stream: PassThrough, chunks: ReadonlyArray<string>): Promise<void> => {
    const delay = opts.chunkDelayMs ?? 0;
    for (const c of chunks) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      stream.write(c);
    }
    if (opts.transportError) stream.destroy(opts.transportError);
    else if (!opts.hang) stream.end();
  };
  void pump(stdout, opts.stdoutChunks ?? []);
  void pump(stderr, opts.stderrChunks ?? []);

  const exited = new Promise<Result<ExecExit, ExecFailure>>((resolve) => {
    const transportError = opts.transportError;
    if (transportError) {
      setImmediate(() => resolve(err({ kind: "transport_failed", error: transportError })));
      return;
    }
    if (opts.hang) {
      const timeoutMs = execOpts.timeoutMs;
      if (timeoutMs === undefined) return;
      setTimeout(() => {
        stdout.end();
        stderr.end();
        resolve(err({ kind: "timed_out", deadline: "total", timeoutMs }));
      }, timeoutMs);
      return;
    }
    setTimeout(() => resolve(ok({ exitCode: opts.exitCode ?? 0 })), opts.exitDelayMs ?? 0);
  });

  return fakeExecHandle({ stdout, stderr, exited, dispose: vi.fn(async () => {}) });
}

function fakeContainer(opts: FakeExecOpts = {}) {
  const handles: ExecStreamingHandle[] = [];
  return {
    handles,
    execStreaming: vi.fn(async (_cmd: readonly string[], execOpts?: ExecOptions) => {
      const handle = fakeExec(opts, execOpts);
      handles.push(handle);
      return handle;
    }),
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runVerifyStreaming", () => {
  it("returns ok=true on exit code 0 and captures merged stdout+stderr", async () => {
    const container = fakeContainer({
      stdoutChunks: ["hello ", "world\n"],
      stderrChunks: ["warn\n"],
      exitCode: 0,
    });
    const result = await runVerifyStreaming({
      container,
      verifyCommand: "true",
      timeoutSeconds: 60,
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    // stdout and stderr are pumped concurrently — assert each chunk
    // independently rather than as one substring, since the runner could
    // legitimately interleave them before "hello " and "world\n" land
    // contiguously in the capture buffer.
    expect(result.output).toContain("hello ");
    expect(result.output).toContain("world");
    expect(result.output).toContain("warn");
  });

  it("returns ok=false on non-zero exit", async () => {
    const container = fakeContainer({
      stdoutChunks: ["fail\n"],
      exitCode: 1,
    });
    const result = await runVerifyStreaming({
      container,
      verifyCommand: "false",
      timeoutSeconds: 60,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("invokes container.exec with `bash -lc <verifyCommand>`", async () => {
    const container = fakeContainer({ exitCode: 0 });
    await runVerifyStreaming({
      container,
      verifyCommand: "pnpm test && pnpm lint",
      timeoutSeconds: 60,
    });
    expect(container.execStreaming).toHaveBeenCalledWith(
      ["bash", "-lc", "pnpm test && pnpm lint"],
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
  });

  it("truncates captured output at OUTPUT_CAP_BYTES with a marker", async () => {
    const big = "x".repeat(OUTPUT_CAP_BYTES + 1024);
    const container = fakeContainer({
      stdoutChunks: [big],
      exitCode: 0,
    });
    const result = await runVerifyStreaming({
      container,
      verifyCommand: "echo big",
      timeoutSeconds: 60,
    });
    // Truncation marker present, captured size capped.
    expect(result.output).toMatch(/output truncated at \d+ bytes/);
    // Marker adds a postfix; the captured prefix matches OUTPUT_CAP_BYTES.
    const xCount = (result.output.match(/x/g) ?? []).length;
    expect(xCount).toBe(OUTPUT_CAP_BYTES);
  });

  it("returns timedOut=true with TIMEOUT_EXIT_CODE when the wait exceeds the budget", async () => {
    const container = fakeContainer({
      stdoutChunks: ["working...\n"],
      hang: true,
    });
    const start = Date.now();
    const result = await runVerifyStreaming({
      container,
      verifyCommand: "sleep infinity",
      timeoutSeconds: 0.05, // 50ms
    });
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(TIMEOUT_EXIT_CODE);
    expect(result.output).toMatch(/verify timed out after 0\.05s/);
    // Should not have waited a full second despite the streams being open.
    expect(elapsed).toBeLessThan(1500);
    // Nothing is left running inside the container.
    expect(container.handles[0]?.dispose).toHaveBeenCalled();
  });

  it("throws a transport failure only once both output pumps have settled, leaving no timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const transportError = new Error("hijacked socket reset");
      const container = fakeContainer({ stdoutChunks: ["partial\n"], transportError });
      await expect(
        runVerifyStreaming({ container, verifyCommand: "pnpm test", timeoutSeconds: 600 }),
      ).rejects.toBe(transportError);
      const timers = vi.getTimerCount();
      vi.useRealTimers();
      // Node reports an unhandled rejection once the microtask queue drains.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect({ timers, unhandled }).toEqual({ timers: 0, unhandled: [] });
      expect(container.handles[0]?.dispose).toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      vi.useRealTimers();
    }
  });

  it("throws a timeout that settles the exec before its command runs", async () => {
    // The start outlasted the cap, so there is no handle and no output to judge.
    const timeout = new ExecTimeoutError("total", 60_000);
    await expect(
      runVerifyStreaming({
        container: {
          execStreaming: async () => {
            throw timeout;
          },
        },
        verifyCommand: "pnpm test",
        timeoutSeconds: 60,
      }),
    ).rejects.toBe(timeout);
  });

  it("captures output that arrives across several chunks", async () => {
    const container = fakeContainer({
      stdoutChunks: ["one\n", "two\n", "three\n"],
      chunkDelayMs: 5,
      exitCode: 0,
    });
    const result = await runVerifyStreaming({
      container,
      verifyCommand: "echo one; echo two; echo three",
      timeoutSeconds: 60,
    });
    expect(result.output).toBe("one\ntwo\nthree\n");
  });

  it("records durationMs as a non-negative number", async () => {
    const container = fakeContainer({
      stdoutChunks: ["x"],
      exitDelayMs: 20,
      exitCode: 0,
    });
    const result = await runVerifyStreaming({
      container,
      verifyCommand: "true",
      timeoutSeconds: 60,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
