import { PassThrough, type Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecStreamingHandle } from "../../sandbox/index.js";
import type { ExecuteStreamHandle } from "./orchestrator.js";
import { OUTPUT_CAP_BYTES, runVerifyStreaming, TIMEOUT_EXIT_CODE } from "./verify.js";

interface FakeExecOpts {
  stdoutChunks?: ReadonlyArray<string>;
  stderrChunks?: ReadonlyArray<string>;
  exitCode?: number;
  /** Delay (ms) before each chunk emits. Drives timeout tests. */
  chunkDelayMs?: number;
  /** Delay (ms) between streams ending and exit being reported. */
  exitDelayMs?: number;
  /** Never resolve `wait()` — used for hard-timeout tests. */
  hang?: boolean;
}

function fakeExec(opts: FakeExecOpts = {}): ExecStreamingHandle {
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const stdoutChunks = opts.stdoutChunks ?? [];
  const stderrChunks = opts.stderrChunks ?? [];

  void (async () => {
    const delay = opts.chunkDelayMs ?? 0;
    for (const c of stdoutChunks) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      stdout.write(c);
    }
    stdout.end();
  })();

  void (async () => {
    const delay = opts.chunkDelayMs ?? 0;
    for (const c of stderrChunks) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      stderr.write(c);
    }
    stderr.end();
  })();

  const wait = vi.fn(async () => {
    if (opts.hang) {
      return new Promise<{ exitCode: number }>(() => {
        // never resolves
      });
    }
    if (opts.exitDelayMs) await new Promise((r) => setTimeout(r, opts.exitDelayMs));
    return { exitCode: opts.exitCode ?? 0 };
  });

  return {
    stdout: stdout as Readable,
    stderr: stderr as Readable,
    wait,
    dispose: vi.fn(async () => {}),
  };
}

function fakeContainer(opts: FakeExecOpts = {}) {
  return {
    execStreaming: vi.fn(async () => fakeExec(opts)),
  };
}

function fakeExecuteStream(): ExecuteStreamHandle & { capture: string } {
  const captured: string[] = [];
  const stream: ExecuteStreamHandle & { capture: string } = {
    appendText: vi.fn(async (delta: string) => {
      captured.push(delta);
    }),
    toolCall: vi.fn(async () => {}),
    toolResult: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    get capture() {
      return captured.join("");
    },
  };
  return stream;
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
    const stream = fakeExecuteStream();
    const result = await runVerifyStreaming({
      container,
      verifyCommand: "true",
      timeoutSeconds: 60,
      executeStream: stream,
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
    expect(stream.capture).toContain("hello ");
    expect(stream.capture).toContain("world");
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
    expect(container.execStreaming).toHaveBeenCalledWith(["bash", "-lc", "pnpm test && pnpm lint"]);
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
  });

  it("survives a missing executeStream (NULL stream path)", async () => {
    const container = fakeContainer({ stdoutChunks: ["ok\n"], exitCode: 0 });
    const result = await runVerifyStreaming({
      container,
      verifyCommand: "true",
      timeoutSeconds: 60,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("ok");
  });

  it("forwards stream chunks to the executeStream's appendText incrementally", async () => {
    const container = fakeContainer({
      stdoutChunks: ["one\n", "two\n", "three\n"],
      chunkDelayMs: 5,
      exitCode: 0,
    });
    const stream = fakeExecuteStream();
    await runVerifyStreaming({
      container,
      verifyCommand: "echo one; echo two; echo three",
      timeoutSeconds: 60,
      executeStream: stream,
    });
    // Each chunk produced one appendText call (plus possibly empty trailing).
    const calls = (stream.appendText as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(stream.capture).toContain("one\n");
    expect(stream.capture).toContain("two\n");
    expect(stream.capture).toContain("three\n");
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
