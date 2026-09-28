import { EventEmitter, getEventListeners, on } from "node:events";
import { err, ok, type Result } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import {
  CtxError,
  type CtxHandler,
  Dispatcher,
  type DispatcherOptions,
  type WorkerTransport,
} from "./dispatcher.js";
import type { HostMessage, TaskInvoke, TaskResult } from "./protocol.js";
import type { ExitOutcome, Handshake, StartFailure, WorkerFrame } from "./worker-state.js";

/**
 * The worker's end of an in-memory channel. `emit` delivers a frame to the
 * host and `fail` fails the host's stream; `sent` records what the host
 * sent, and `onSend` scripts the worker's replies.
 */
function channel() {
  const bus = new EventEmitter();
  const sent: HostMessage[] = [];
  const close = vi.fn(() => {
    bus.emit("closed");
  });
  const transport: WorkerTransport = {
    send: (message) => {
      sent.push(message);
      bus.emit("sent", message);
    },
    async *messages() {
      for await (const [message] of on(bus, "message", { close: ["closed"] })) yield message;
    },
    close,
  };
  return {
    transport,
    sent,
    close,
    emit: (frame: WorkerFrame) => bus.emit("message", frame),
    fail: (error: Error) => bus.emit("error", error),
    onSend: (reply: (message: HostMessage) => void) => bus.on("sent", reply),
  };
}

type Channel = ReturnType<typeof channel>;

const NEVER = new AbortController().signal;

const acceptReady: Handshake = (first) =>
  first.type === "ready" ? ok(undefined) : err(`sent ${first.type} before ready`);

function open(
  ch: Channel,
  opts: Partial<DispatcherOptions> = {},
): Promise<Result<Dispatcher, StartFailure>> {
  return Dispatcher.open({
    transport: ch.transport,
    handshake: acceptReady,
    handshakeDeadline: NEVER,
    ...opts,
  });
}

function unwrap(opened: Result<Dispatcher, StartFailure>): Dispatcher {
  if (opened.isErr()) throw new Error(`dispatcher failed to open: ${JSON.stringify(opened.error)}`);
  return opened.value;
}

/** A dispatcher past its handshake and leased for a task. */
async function leased(ch: Channel, opts: Partial<DispatcherOptions> = {}): Promise<Dispatcher> {
  const opened = open(ch, opts);
  ch.emit({ type: "ready" });
  const d = unwrap(await opened);
  expect(d.tryAcquire()).toBe(true);
  return d;
}

function noopHandler(): CtxHandler {
  return { handle: vi.fn().mockResolvedValue(null) };
}

function ctxResultsOf(ch: Channel): HostMessage[] {
  return ch.sent.filter((m) => m.type === "ctx_result");
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function completed(result: TaskResult, exit: ExitOutcome = { kind: "confirmed" }) {
  return ok({ result, exit });
}

const INVOKE: TaskInvoke = {
  type: "task_invoke",
  id: "task-1",
  skill: "echo",
  inputs: { x: 1 },
};

function result(output: unknown, id = "task-1"): TaskResult {
  return { type: "task_result", id, ok: true, output };
}

describe("Dispatcher", () => {
  describe("handshake", () => {
    it("opens once the worker's first frame passes the handshake", async () => {
      const ch = channel();
      const opened = open(ch);
      ch.emit({ type: "ready" });
      expect(unwrap(await opened).state).toBe("idle");
    });

    it("refuses a worker whose first frame fails the handshake, and closes its channel", async () => {
      const ch = channel();
      const opened = open(ch);
      ch.emit(result(null));
      expect(await opened).toEqual(
        err({ kind: "refused", reason: "sent task_result before ready" }),
      );
      expect(ch.close).toHaveBeenCalled();
    });

    it("refuses a worker still silent at its handshake deadline", async () => {
      const ch = channel();
      const deadline = new AbortController();
      const opened = open(ch, { handshakeDeadline: deadline.signal });
      deadline.abort();
      expect(await opened).toEqual(err({ kind: "timed_out" }));
      expect(ch.close).toHaveBeenCalled();
    });

    it("refuses a first frame that fails validation at once", async () => {
      const ch = channel();
      const opened = open(ch);
      ch.emit({ type: "malformed", issues: ["Invalid input"] });
      expect(await opened).toEqual(err({ kind: "refused", reason: "sent malformed before ready" }));
    });

    it("reports a worker whose channel ends before its handshake", async () => {
      const ch = channel();
      const opened = open(ch);
      ch.fail(new Error("transport: maximum buffer reached"));
      expect(await opened).toEqual(
        err({ kind: "ended", reason: "transport: maximum buffer reached" }),
      );
    });

    it("closes the channel at once when opened with an aborted signal", async () => {
      const ch = channel();
      const opened = open(ch, { signal: AbortSignal.abort(new Error("pool disposed")) });
      expect(await opened).toEqual(err({ kind: "closed", reason: "pool disposed" }));
      expect(ch.close).toHaveBeenCalledTimes(1);
    });

    it("ignores the handshake deadline once the handshake is done", async () => {
      const ch = channel();
      const deadline = new AbortController();
      const d = await leased(ch, { handshakeDeadline: deadline.signal });
      deadline.abort();
      expect(d.state).toBe("leased");
    });
  });

  it("settles a task with its result once the worker confirms its exit", async () => {
    const ch = channel();
    const d = await leased(ch);
    let settled = false;
    const outcome = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: NEVER }).then((o) => {
      settled = true;
      return o;
    });

    ch.emit({ type: "task_result", id: "task-1", ok: true, output: { echo: 1 } });
    await flush();
    expect(settled).toBe(false);
    ch.emit({ type: "task_exited", id: "task-1" });

    expect(await outcome).toEqual(completed(result({ echo: 1 })));
    expect(ch.sent[0]).toEqual(INVOKE);
    expect(d.state).toBe("leased");
  });

  it("services a ctx_call mid-task and routes to the handler", async () => {
    const ch = channel();
    const handler: CtxHandler = {
      handle: vi.fn(async ({ method, args }) => {
        if (method === "secrets.get" && (args as { name: string }).name === "foo") return "bar";
        throw new Error("unexpected call");
      }),
    };
    const d = await leased(ch);

    const outcome = d.invoke(INVOKE, { ctxHandler: handler, deadline: NEVER });
    ch.emit({
      type: "ctx_call",
      taskId: "task-1",
      id: "ctx-1",
      method: "secrets.get",
      args: { name: "foo" },
    });
    await flush();

    expect(handler.handle).toHaveBeenCalledWith({ method: "secrets.get", args: { name: "foo" } });
    expect(ctxResultsOf(ch)).toEqual([
      { type: "ctx_result", taskId: "task-1", id: "ctx-1", ok: true, value: "bar" },
    ]);

    ch.emit(result(null));
    ch.emit({ type: "task_exited", id: "task-1" });
    await outcome;
  });

  it("surfaces CtxError as a typed ctx_result with errorKind", async () => {
    const ch = channel();
    const handler: CtxHandler = {
      handle: vi.fn(async () => {
        throw new CtxError("not_in_allowlist", "secret 'x' not declared");
      }),
    };
    const d = await leased(ch);

    d.invoke(INVOKE, { ctxHandler: handler, deadline: NEVER });
    ch.emit({
      type: "ctx_call",
      taskId: "task-1",
      id: "ctx-2",
      method: "secrets.get",
      args: { name: "x" },
    });
    await flush();

    expect(ctxResultsOf(ch)).toEqual([
      {
        type: "ctx_result",
        taskId: "task-1",
        id: "ctx-2",
        ok: false,
        errorKind: "not_in_allowlist",
        message: "secret 'x' not declared",
      },
    ]);
    d.close("done");
  });

  it("wraps non-CtxError exceptions as errorKind: internal", async () => {
    const ch = channel();
    const handler: CtxHandler = {
      handle: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const d = await leased(ch);

    d.invoke(INVOKE, { ctxHandler: handler, deadline: NEVER });
    ch.emit({ type: "ctx_call", taskId: "task-1", id: "ctx-3", method: "secrets.get", args: {} });
    await flush();

    expect(ctxResultsOf(ch)).toEqual([
      {
        type: "ctx_result",
        taskId: "task-1",
        id: "ctx-3",
        ok: false,
        errorKind: "internal",
        message: "boom",
      },
    ]);
    d.close("done");
  });

  it("handles concurrent in-flight ctx calls correlated by id", async () => {
    const ch = channel();
    const resolvers = new Map<string, (v: unknown) => void>();
    const handler: CtxHandler = {
      handle: vi.fn(({ args }) => {
        const id = (args as { id: string }).id;
        return new Promise((resolve) => resolvers.set(id, resolve));
      }),
    };
    const d = await leased(ch);

    d.invoke(INVOKE, { ctxHandler: handler, deadline: NEVER });
    ch.emit({ type: "ctx_call", taskId: "task-1", id: "a", method: "now", args: { id: "a" } });
    ch.emit({ type: "ctx_call", taskId: "task-1", id: "b", method: "now", args: { id: "b" } });
    await flush();

    // Resolve b first, then a — out of order.
    resolvers.get("b")?.("BBB");
    await flush();
    resolvers.get("a")?.("AAA");
    await flush();

    expect(ctxResultsOf(ch)).toEqual([
      { type: "ctx_result", taskId: "task-1", id: "b", ok: true, value: "BBB" },
      { type: "ctx_result", taskId: "task-1", id: "a", ok: true, value: "AAA" },
    ]);
    d.close("done");
  });

  it("handles 100 concurrent ctx calls without dropping any", async () => {
    const ch = channel();
    const handler: CtxHandler = {
      handle: vi.fn(async ({ args }) => (args as { i: number }).i * 2),
    };
    const d = await leased(ch);

    d.invoke(INVOKE, { ctxHandler: handler, deadline: NEVER });
    const N = 100;
    for (let i = 0; i < N; i++) {
      ch.emit({ type: "ctx_call", taskId: "task-1", id: `c-${i}`, method: "now", args: { i } });
    }
    await vi.waitFor(() => expect(ctxResultsOf(ch)).toHaveLength(N));
    for (let i = 0; i < N; i++) {
      expect(ctxResultsOf(ch).find((c) => c.id === `c-${i}`)).toMatchObject({ value: i * 2 });
    }
    d.close("done");
  });

  it("fails the task and dies on a task_result id mismatch", async () => {
    const ch = channel();
    const d = await leased(ch);

    const outcome = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: NEVER });
    // The worker is in an inconsistent state (sent the wrong task id).
    // Failing now surfaces it; waiting would hang until the deadline.
    ch.emit(result(null, "wrong"));

    expect(await outcome).toEqual(
      err({ kind: "failed", reason: expect.stringMatching(/task_result id mismatch/) }),
    );
    expect(d.state).toBe("dead");
  });

  it("close() fails an in-flight task", async () => {
    const ch = channel();
    const d = await leased(ch);
    const outcome = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: NEVER });
    d.close("torn-down");
    expect(await outcome).toEqual(err({ kind: "failed", reason: "torn-down" }));
    expect(ch.close).toHaveBeenCalled();
  });

  it("throws synchronously on a second invoke before the first completes", async () => {
    const ch = channel();
    const d = await leased(ch);
    const first = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: NEVER });
    expect(() =>
      d.invoke({ ...INVOKE, id: "task-2" }, { ctxHandler: noopHandler(), deadline: NEVER }),
    ).toThrow(/in-flight/);
    d.close("done");
    expect((await first).isErr()).toBe(true);
  });

  it("throws synchronously on an invoke without a lease", async () => {
    const ch = channel();
    const opened = open(ch);
    ch.emit({ type: "ready" });
    const d = unwrap(await opened);
    expect(() => d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: NEVER })).toThrow(
      /acquire it first/,
    );
    expect(ch.sent).toEqual([]);
  });

  it("fails a task invoked after close() without sending it", async () => {
    const ch = channel();
    const d = await leased(ch);
    d.close("closed");
    expect(await d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: NEVER })).toEqual(
      err({ kind: "failed", reason: "worker is dead: closed" }),
    );
    expect(ch.sent).toEqual([]);
  });

  it("close() is idempotent", async () => {
    const ch = channel();
    const d = await leased(ch);
    d.close("first");
    d.close("second");
    expect(await d.dead).toBe("first");
    expect(ch.close).toHaveBeenCalledTimes(1);
  });

  it("ignores a malformed frame after the handshake", async () => {
    const ch = channel();
    const d = await leased(ch);
    const outcome = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: NEVER });
    ch.emit({ type: "malformed", issues: ["Invalid input"] });
    ch.emit(result(1));
    ch.emit({ type: "task_exited", id: "task-1" });
    expect(await outcome).toEqual(completed(result(1)));
  });

  it("ignores a task_result that arrives with no task in flight", async () => {
    const ch = channel();
    const d = await leased(ch);
    // No invoke() yet — fire a stale result.
    ch.emit(result(1, "stale"));
    await flush();
    // Then invoke; the previous result was dropped.
    const outcome = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: NEVER });
    ch.emit(result(7));
    ch.emit({ type: "task_exited", id: "task-1" });
    expect(await outcome).toEqual(completed(result(7)));
  });

  it("fails the task when its task_invoke cannot be sent", async () => {
    const ch = channel();
    const d = await leased(ch, {
      transport: {
        ...ch.transport,
        send: () => {
          throw new Error("transport failed");
        },
      },
    });
    expect(await d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: NEVER })).toEqual(
      err({ kind: "failed", reason: "task_invoke send failed: transport failed" }),
    );
    expect(d.state).toBe("dead");
  });

  it("fails a pending task at once when the worker's stream fails", async () => {
    // A failed stream means the worker is gone: the task fails now rather
    // than on its deadline.
    const ch = channel();
    const d = await leased(ch);
    const outcome = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: NEVER });
    ch.fail(new Error("transport: maximum buffer reached"));
    expect(await outcome).toEqual(
      err({ kind: "failed", reason: "transport: maximum buffer reached" }),
    );
  });

  it("dies once when the channel fails with no task in flight", async () => {
    const ch = channel();
    const d = await leased(ch);
    d.release();
    ch.fail(new Error("transport: worker closed its output"));

    expect(await d.dead).toBe("transport: worker closed its output");
    expect(ch.close).toHaveBeenCalledTimes(1);
    expect(d.tryAcquire()).toBe(false);
  });

  it("keeps the close reason when the stream ends after close()", async () => {
    const ch = channel();
    const d = await leased(ch);
    d.close("disposed");
    await flush();
    expect(await d.dead).toBe("disposed");
  });

  it("dispatches sequential tasks on a persistent channel (per-task ctxHandler)", async () => {
    // One Dispatcher serves many tasks; each `invoke()` passes its own
    // ctxHandler, and ctx_calls during task N route to handler N only.
    const ch = channel();
    const d = await leased(ch);

    const handlerA: CtxHandler = { handle: vi.fn().mockResolvedValue("A") };
    const handlerB: CtxHandler = { handle: vi.fn().mockResolvedValue("B") };

    ch.onSend((m) => {
      if (m.type === "task_invoke") {
        ch.emit({ type: "ctx_call", taskId: m.id, id: `ctx-${m.id}`, method: "now", args: {} });
      } else {
        ch.emit(result(`done-${m.taskId}`, m.taskId));
        ch.emit({ type: "task_exited", id: m.taskId });
      }
    });

    const a = await d.invoke({ ...INVOKE, id: "A" }, { ctxHandler: handlerA, deadline: NEVER });
    expect(a).toEqual(completed(result("done-A", "A")));
    expect(handlerA.handle).toHaveBeenCalledTimes(1);
    expect(handlerB.handle).not.toHaveBeenCalled();

    const b = await d.invoke({ ...INVOKE, id: "B" }, { ctxHandler: handlerB, deadline: NEVER });
    expect(b).toEqual(completed(result("done-B", "B")));
    expect(handlerA.handle).toHaveBeenCalledTimes(1);
    expect(handlerB.handle).toHaveBeenCalledTimes(1);
  });

  it("fails the pending task when its ctx_result cannot be sent", async () => {
    // Otherwise the task would hang on a worker awaiting a ctx_result it
    // will never get.
    const ch = channel();
    const d = await leased(ch, {
      transport: {
        ...ch.transport,
        send: (m) => {
          if (m.type === "ctx_result") throw new Error("transport: closed");
          ch.transport.send(m);
        },
      },
    });

    const outcome = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: NEVER });
    ch.emit({ type: "ctx_call", taskId: "task-1", id: "ctx-1", method: "now", args: {} });

    expect(await outcome).toEqual(
      err({ kind: "failed", reason: expect.stringMatching(/ctx_result send failed/) }),
    );
  });

  describe("ctx_call task binding", () => {
    it("does not serve a finished task's late ctx_call with the next task's handler", async () => {
      const ch = channel();
      const d = await leased(ch);
      const handlerA = mock<CtxHandler>();
      const handlerB = mock<CtxHandler>();

      const a = d.invoke({ ...INVOKE, id: "task-A" }, { ctxHandler: handlerA, deadline: NEVER });
      ch.emit(result(null, "task-A"));
      ch.emit({ type: "task_exited", id: "task-A" });
      await a;
      d.invoke({ ...INVOKE, id: "task-B" }, { ctxHandler: handlerB, deadline: NEVER });
      // Task A's code outlived its result and calls ctx while B is in flight.
      ch.emit({
        type: "ctx_call",
        id: "ctx-late",
        taskId: "task-A",
        method: "secrets.get",
        args: { name: "token" },
      });
      await flush();

      expect(handlerA.handle).not.toHaveBeenCalled();
      expect(handlerB.handle).not.toHaveBeenCalled();
      expect(ctxResultsOf(ch)).toEqual([]);
      d.close("done");
    });

    it("refuses a ctx_call when no task is in flight", async () => {
      const ch = channel();
      const d = await leased(ch);
      const handler = mock<CtxHandler>();

      const a = d.invoke(INVOKE, { ctxHandler: handler, deadline: NEVER });
      ch.emit(result(null));
      ch.emit({ type: "task_exited", id: "task-1" });
      await a;
      ch.emit({ type: "ctx_call", taskId: "task-1", id: "c", method: "now", args: {} });
      await flush();

      expect(handler.handle).not.toHaveBeenCalled();
      expect(ctxResultsOf(ch)).toEqual([]);
    });

    it("refuses a ctx_call naming a task other than the running one", async () => {
      const ch = channel();
      const d = await leased(ch);
      const handler = mock<CtxHandler>();

      d.invoke(INVOKE, { ctxHandler: handler, deadline: NEVER });
      ch.emit({ type: "ctx_call", taskId: "task-2", id: "c", method: "now", args: {} });
      await flush();

      expect(handler.handle).not.toHaveBeenCalled();
      expect(ctxResultsOf(ch)).toEqual([]);
      d.close("done");
    });

    it("refuses a ctx_call from a task that has returned but not yet exited", async () => {
      const ch = channel();
      const d = await leased(ch);
      const handler = mock<CtxHandler>();

      const outcome = d.invoke(INVOKE, { ctxHandler: handler, deadline: NEVER });
      ch.emit(result(null));
      ch.emit({ type: "ctx_call", taskId: "task-1", id: "c", method: "now", args: {} });
      await flush();

      expect(handler.handle).not.toHaveBeenCalled();
      ch.emit({ type: "task_exited", id: "task-1" });
      await outcome;
    });

    it("drops the reply to a call whose task returned while it was being served", async () => {
      const ch = channel();
      const d = await leased(ch);
      let release: (v: unknown) => void = () => {};
      const handler = mock<CtxHandler>();
      handler.handle.mockImplementation(() => new Promise((resolve) => (release = resolve)));

      const outcome = d.invoke(INVOKE, { ctxHandler: handler, deadline: NEVER });
      ch.emit({ type: "ctx_call", taskId: "task-1", id: "c", method: "now", args: {} });
      await flush();
      ch.emit(result(null));
      ch.emit({ type: "task_exited", id: "task-1" });
      await outcome;
      release("late");
      await flush();

      expect(handler.handle).toHaveBeenCalledTimes(1);
      expect(ctxResultsOf(ch)).toEqual([]);
    });

    it("drops the reply to a call whose task returned but has not yet exited", async () => {
      const ch = channel();
      const d = await leased(ch);
      let release: (v: unknown) => void = () => {};
      const handler = mock<CtxHandler>();
      handler.handle.mockImplementation(() => new Promise((resolve) => (release = resolve)));

      const outcome = d.invoke(INVOKE, { ctxHandler: handler, deadline: NEVER });
      ch.emit({ type: "ctx_call", taskId: "task-1", id: "c", method: "now", args: {} });
      await flush();
      // Still on the worker: it awaits task_exited.
      ch.emit(result(null));
      await flush();
      release("late");
      await flush();

      expect(ctxResultsOf(ch)).toEqual([]);
      ch.emit({ type: "task_exited", id: "task-1" });
      await outcome;
    });
  });

  describe("task exit", () => {
    it("holds the worker until task_exited, then settles with the task's result", async () => {
      const ch = channel();
      const d = await leased(ch);
      let settled = false;
      const outcome = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: NEVER }).then((o) => {
        settled = true;
        return o;
      });

      ch.emit(result(5));
      await flush();
      expect(settled).toBe(false);
      expect(() =>
        d.invoke({ ...INVOKE, id: "task-2" }, { ctxHandler: noopHandler(), deadline: NEVER }),
      ).toThrow(/in-flight/);
      d.release();
      expect(d.state).toBe("awaiting_exit");

      ch.emit({ type: "task_exited", id: "task-1" });
      expect(await outcome).toEqual(completed(result(5)));
    });

    it("keeps the first of duplicate task_results", async () => {
      const ch = channel();
      const d = await leased(ch);
      const outcome = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: NEVER });
      ch.emit(result("first"));
      ch.emit(result("second"));
      ch.emit({ type: "task_exited", id: "task-1" });
      expect(await outcome).toEqual(completed(result("first")));
    });

    it("reports a task that exited without a result as failed", async () => {
      const ch = channel();
      const d = await leased(ch);
      const outcome = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: NEVER });
      ch.emit({ type: "task_exited", id: "task-1" });
      expect(await outcome).toEqual(
        completed({
          type: "task_result",
          id: "task-1",
          ok: false,
          error: "task_exited_without_result",
        }),
      );
      expect(d.state).toBe("leased");
    });

    it("keeps a delivered result, exit unconfirmed, on a task_exited id mismatch", async () => {
      const ch = channel();
      const d = await leased(ch);
      const outcome = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: NEVER });
      ch.emit(result(null));
      ch.emit({ type: "task_exited", id: "other" });
      expect(await outcome).toEqual(
        completed(result(null), {
          kind: "unconfirmed",
          reason: expect.stringMatching(/task_exited id mismatch/),
        }),
      );
      expect(d.state).toBe("dead");
    });

    it("keeps a delivered result when a second task_result names another task", async () => {
      const ch = channel();
      const d = await leased(ch);
      const outcome = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: NEVER });
      ch.emit(result("mine"));
      ch.emit(result("forged", "other"));
      expect(await outcome).toEqual(
        completed(result("mine"), {
          kind: "unconfirmed",
          reason: expect.stringMatching(/task_result id mismatch/),
        }),
      );
    });

    it("keeps a delivered result when the stream fails before task_exited", async () => {
      const ch = channel();
      const d = await leased(ch);
      const outcome = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: NEVER });
      ch.emit(result(7));
      await flush();
      ch.fail(new Error("transport: worker closed its output"));
      expect(await outcome).toEqual(
        completed(result(7), {
          kind: "unconfirmed",
          reason: "transport: worker closed its output",
        }),
      );
    });

    it("keeps a delivered result when closed before task_exited", async () => {
      const ch = channel();
      const d = await leased(ch);
      const outcome = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: NEVER });
      ch.emit({ type: "task_result", id: "task-1", ok: false, error: "boom" });
      await flush();
      d.close("supervisor unresponsive");
      expect(await outcome).toEqual(
        completed(
          { type: "task_result", id: "task-1", ok: false, error: "boom" },
          { kind: "unconfirmed", reason: "supervisor unresponsive" },
        ),
      );
    });

    it("fails the task outright when closed before its result", async () => {
      const ch = channel();
      const d = await leased(ch);
      const outcome = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: NEVER });
      d.close("supervisor unresponsive");
      expect(await outcome).toEqual(err({ kind: "failed", reason: "supervisor unresponsive" }));
    });
  });

  describe("deadline", () => {
    it("stops watching a task's deadline once the task settles", async () => {
      const ch = channel();
      const d = await leased(ch);
      const deadline = new AbortController();
      const outcome = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: deadline.signal });
      expect(getEventListeners(deadline.signal, "abort")).toHaveLength(1);

      ch.emit(result(1));
      ch.emit({ type: "task_exited", id: "task-1" });
      await outcome;

      expect(getEventListeners(deadline.signal, "abort")).toEqual([]);
    });

    it("fails a running task whose deadline passes, and dies", async () => {
      const ch = channel();
      const d = await leased(ch);
      const deadline = new AbortController();
      const outcome = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: deadline.signal });
      deadline.abort();
      expect(await outcome).toEqual(err({ kind: "timed_out" }));
      expect(d.state).toBe("dead");
      expect(ch.close).toHaveBeenCalled();
    });

    it("keeps a delivered result when the deadline passes before the exit", async () => {
      const ch = channel();
      const d = await leased(ch);
      const deadline = new AbortController();
      const outcome = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: deadline.signal });
      ch.emit(result(1));
      await flush();
      deadline.abort();
      expect(await outcome).toEqual(
        completed(result(1), { kind: "unconfirmed", reason: "task deadline passed" }),
      );
    });

    it("ignores the deadline of a task that already settled", async () => {
      const ch = channel();
      const d = await leased(ch);
      const deadline = new AbortController();
      const first = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: deadline.signal });
      ch.emit(result(1));
      ch.emit({ type: "task_exited", id: "task-1" });
      await first;

      const second = d.invoke(
        { ...INVOKE, id: "task-2" },
        { ctxHandler: noopHandler(), deadline: NEVER },
      );
      deadline.abort();
      expect(d.state).toBe("running");
      ch.emit(result(2, "task-2"));
      ch.emit({ type: "task_exited", id: "task-2" });
      expect(await second).toEqual(completed(result(2, "task-2")));
    });
  });

  describe("lease", () => {
    it("release returns a leased worker to idle, and holds one with a task on it", async () => {
      const ch = channel();
      const d = await leased(ch);
      const outcome = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: NEVER });
      d.release();
      expect(d.state).toBe("running");
      expect(d.tryAcquire()).toBe(false);

      ch.emit(result(1));
      ch.emit({ type: "task_exited", id: "task-1" });
      await outcome;
      expect(d.state).toBe("leased");
      d.release();
      expect(d.state).toBe("idle");
      expect(d.tryAcquire()).toBe(true);
    });

    it("aborting its signal closes the channel", async () => {
      const ch = channel();
      const lifetime = new AbortController();
      const d = await leased(ch, { signal: lifetime.signal });
      const outcome = d.invoke(INVOKE, { ctxHandler: noopHandler(), deadline: NEVER });
      lifetime.abort(new Error("pool disposed"));
      expect(await outcome).toEqual(err({ kind: "failed", reason: "pool disposed" }));
      expect(await d.dead).toBe("pool disposed");
      expect(ch.close).toHaveBeenCalled();
    });
  });
});
