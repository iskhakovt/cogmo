import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { WorkerMessage } from "../protocol.js";
import { createNdjsonTransport, MAX_BUFFER_BYTES } from "./transport.js";

function pair(): { stdin: PassThrough; stdout: PassThrough } {
  return { stdin: new PassThrough(), stdout: new PassThrough() };
}

const RESULT = { type: "task_result", id: "x", ok: true, output: 1 } as const;
const CALL = { type: "ctx_call", taskId: "x", id: "y", method: "now", args: {} } as const;

function line(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/** Collect what the stream yields until it ends; `error` is what it threw, if anything. */
async function drain(
  messages: AsyncIterable<WorkerMessage>,
): Promise<{ received: WorkerMessage[]; error: unknown }> {
  const received: WorkerMessage[] = [];
  try {
    for await (const message of messages) received.push(message);
    return { received, error: undefined };
  } catch (error) {
    return { received, error };
  }
}

describe("createNdjsonTransport", () => {
  it("send frames as one JSON object per line", () => {
    const { stdin, stdout } = pair();
    const t = createNdjsonTransport(stdin, stdout);
    const captured: string[] = [];
    stdin.on("data", (chunk) => captured.push(chunk.toString("utf-8")));

    t.send({ type: "task_invoke", id: "x", skill: "s", inputs: {} });
    t.send({ type: "ctx_result", taskId: "x", id: "y", ok: true, value: 42 });

    expect(captured.join("")).toBe(
      `{"type":"task_invoke","id":"x","skill":"s","inputs":{}}\n{"type":"ctx_result","taskId":"x","id":"y","ok":true,"value":42}\n`,
    );
  });

  it("messages yields one parsed message per stdout line", async () => {
    const { stdin, stdout } = pair();
    const t = createNdjsonTransport(stdin, stdout);

    stdout.write(line(RESULT));
    stdout.end(line(CALL));

    expect((await drain(t.messages())).received).toEqual([RESULT, CALL]);
  });

  it("buffers across chunks split mid-line", async () => {
    const { stdin, stdout } = pair();
    const t = createNdjsonTransport(stdin, stdout);

    const [a, b] = [line(RESULT).slice(0, 20), line(RESULT).slice(20)];
    stdout.write(a);
    stdout.write(b);
    stdout.end(line(CALL));

    expect((await drain(t.messages())).received).toEqual([RESULT, CALL]);
  });

  it("drops non-JSON lines without failing", async () => {
    const { stdin, stdout } = pair();
    const t = createNdjsonTransport(stdin, stdout);

    stdout.write("not json at all\n");
    stdout.end(line(RESULT));

    expect((await drain(t.messages())).received).toEqual([RESULT]);
  });

  it("drops JSON that is not a worker frame, including frames only the host sends", async () => {
    const { stdin, stdout } = pair();
    const t = createNdjsonTransport(stdin, stdout);

    stdout.write(line({ type: "garbage" }));
    stdout.write(line(null));
    stdout.write(line({ type: "ctx_result", taskId: "x", id: "y", ok: true, value: null }));
    stdout.write(line({ type: "task_invoke", id: "x", skill: "s", inputs: {} }));
    stdout.end(line(RESULT));

    expect((await drain(t.messages())).received).toEqual([RESULT]);
  });

  it("close ends stdin and silences subsequent sends", () => {
    const { stdin, stdout } = pair();
    const t = createNdjsonTransport(stdin, stdout);
    const captured: string[] = [];
    stdin.on("data", (chunk) => captured.push(chunk.toString("utf-8")));

    t.close();
    t.send({ type: "task_invoke", id: "x", skill: "s", inputs: {} });

    expect(captured).toEqual([]);
    expect(stdin.writableEnded).toBe(true);
  });

  it("yields nothing that arrives after close()", async () => {
    const { stdin, stdout } = pair();
    const t = createNdjsonTransport(stdin, stdout);
    const messages = t.messages()[Symbol.asyncIterator]();

    stdout.write(line(RESULT));
    expect(await messages.next()).toEqual({ done: false, value: RESULT });

    t.close();

    // Late stdout (e.g. a stray ctx_call from a worker still flushing on
    // shutdown) must not reach the host — its pending task is torn down,
    // and its ctx services may have been cleaned up.
    stdout.write(line(CALL));
    expect(await messages.next()).toEqual({ done: true, value: undefined });
  });

  it("ignores empty lines", async () => {
    const { stdin, stdout } = pair();
    const t = createNdjsonTransport(stdin, stdout);

    stdout.end(`\n\n${line(RESULT)}\n`);

    expect((await drain(t.messages())).received).toEqual([RESULT]);
  });

  it("fails the stream and closes when the worker closes its output", async () => {
    const { stdin, stdout } = pair();
    const t = createNdjsonTransport(stdin, stdout);

    stdout.end(line(RESULT));

    expect(await drain(t.messages())).toEqual({
      received: [RESULT],
      error: new Error("transport: worker closed its output"),
    });
    expect(stdin.writableEnded).toBe(true);
  });

  it("ends the stream without an error when the output closes after close()", async () => {
    const { stdin, stdout } = pair();
    const t = createNdjsonTransport(stdin, stdout);

    t.close();
    stdout.end();

    expect(await drain(t.messages())).toEqual({ received: [], error: undefined });
  });

  it("fails the stream and closes when the buffer exceeds the limit without a newline", async () => {
    const { stdin, stdout } = pair();
    const t = createNdjsonTransport(stdin, stdout);

    // Past the limit with no newline — a worker flooding stdout. Sized
    // from the exported constant so raising the limit for `ctx.http`
    // bodies cannot silently stop exercising this path.
    stdout.write("x".repeat(MAX_BUFFER_BYTES + 1024));

    const { received, error } = await drain(t.messages());
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/transport:/);
    // Nothing is yielded: the stream fails, and the dispatcher fails the
    // pending task at once rather than on the wall clock.
    expect(received).toEqual([]);
    expect(stdin.writableEnded).toBe(true);
  });
});
