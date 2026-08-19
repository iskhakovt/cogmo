import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createNdjsonTransport, MAX_BUFFER_BYTES } from "./transport.js";

function pair(): { stdin: PassThrough; stdout: PassThrough } {
  return { stdin: new PassThrough(), stdout: new PassThrough() };
}

describe("createNdjsonTransport", () => {
  it("postMessage frames as one JSON object per line", () => {
    const { stdin, stdout } = pair();
    const t = createNdjsonTransport(stdin, stdout);
    const captured: string[] = [];
    stdin.on("data", (chunk) => captured.push(chunk.toString("utf-8")));

    t.postMessage({ type: "task_invoke", id: "x" });
    t.postMessage({ type: "ctx_result", id: "y", ok: true, value: 42 });

    expect(captured.join("")).toBe(
      `{"type":"task_invoke","id":"x"}\n{"type":"ctx_result","id":"y","ok":true,"value":42}\n`,
    );
  });

  it("onMessage parses one JSON object per stdout line", () => {
    const { stdin, stdout } = pair();
    const t = createNdjsonTransport(stdin, stdout);
    const handler = vi.fn();
    t.onMessage(handler);

    stdout.write(`{"type":"task_result","id":"x","ok":true}\n`);
    stdout.write(`{"type":"ctx_call","id":"y","method":"now","args":{}}\n`);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, { type: "task_result", id: "x", ok: true });
    expect(handler).toHaveBeenNthCalledWith(2, {
      type: "ctx_call",
      id: "y",
      method: "now",
      args: {},
    });
  });

  it("buffers across chunks split mid-line", () => {
    const { stdin, stdout } = pair();
    const t = createNdjsonTransport(stdin, stdout);
    const handler = vi.fn();
    t.onMessage(handler);

    stdout.write(`{"type":"task_result","i`);
    stdout.write(`d":"x","ok":tr`);
    stdout.write(`ue}\n{"type":"ctx_call","id":"y","method":"now","args":{}}\n`);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("drops malformed lines without crashing", () => {
    const { stdin, stdout } = pair();
    const t = createNdjsonTransport(stdin, stdout);
    const handler = vi.fn();
    t.onMessage(handler);

    stdout.write(`not json at all\n`);
    stdout.write(`{"type":"task_result","id":"x","ok":true}\n`);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ type: "task_result", id: "x", ok: true });
  });

  it("close ends stdin and silences subsequent postMessage", () => {
    const { stdin, stdout } = pair();
    const t = createNdjsonTransport(stdin, stdout);
    const captured: string[] = [];
    stdin.on("data", (chunk) => captured.push(chunk.toString("utf-8")));

    t.close();
    t.postMessage({ type: "task_invoke", id: "x" });

    expect(captured).toEqual([]);
    expect(stdin.writableEnded).toBe(true);
  });

  it("drops inbound stdout messages that arrive after close()", () => {
    const { stdin, stdout } = pair();
    const t = createNdjsonTransport(stdin, stdout);
    const handler = vi.fn();
    t.onMessage(handler);

    // Pre-close message routes normally.
    stdout.write(`{"type":"task_result","id":"x","ok":true}\n`);
    expect(handler).toHaveBeenCalledTimes(1);

    t.close();

    // Late stdout (e.g. a stray ctx_call from a worker still flushing on
    // shutdown) must not reach the handler — the dispatcher has already
    // torn down its pending task, and the host's ctx services may have
    // been cleaned up.
    stdout.write(`{"type":"ctx_call","id":"y","method":"now","args":{}}\n`);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ignores empty lines", () => {
    const { stdin, stdout } = pair();
    const t = createNdjsonTransport(stdin, stdout);
    const handler = vi.fn();
    t.onMessage(handler);

    stdout.write(`\n\n{"type":"task_result","id":"x","ok":true}\n\n`);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("fires onError and closes when the buffer exceeds the limit without a newline", async () => {
    const { stdin, stdout } = pair();
    const t = createNdjsonTransport(stdin, stdout);
    const messageHandler = vi.fn();
    t.onMessage(messageHandler);
    const errorSeen = new Promise<Error>((resolve) => {
      t.onError?.((err) => resolve(err));
    });

    // Past the limit with no newline — a worker flooding stdout. Sized
    // from the exported constant so raising the limit for `ctx.http`
    // bodies cannot silently stop exercising this path.
    stdout.write("x".repeat(MAX_BUFFER_BYTES + 1024));

    // split2's `error` lands on the next tick, so await the typed callback.
    const err = await errorSeen;
    expect(err.message).toMatch(/transport:/);
    // Crucially: NO message was forwarded. The previous rev surfaced a
    // synthetic `{ type: "fatal" }` frame on `onMessage`, but that's not a
    // valid worker protocol type — the dispatcher's WorkerMessageSchema
    // dropped it silently and the pending task hung until wall-clock fired.
    // `onError` is the right channel; the dispatcher rejects directly.
    expect(messageHandler).not.toHaveBeenCalled();
    // Transport closed itself; subsequent stdout is dropped.
    expect(stdin.writableEnded).toBe(true);
  });
});
