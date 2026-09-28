import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { CtxError, type CtxHandler, Dispatcher, type RpcTransport } from "./dispatcher.js";
import type { TaskInvoke } from "./protocol.js";

/**
 * Two-ended in-memory transport pair. `host` and `worker` exchange messages
 * — anything `host.postMessage` sends is delivered to `worker`'s message
 * handler (and vice-versa). Mirrors `MessageChannel`'s ports without
 * involving worker_threads.
 */
function makeTransportPair(): { host: RpcTransport; worker: RpcTransport } {
  const hostBus = new EventEmitter();
  const workerBus = new EventEmitter();

  const host: RpcTransport = {
    postMessage: (m) => workerBus.emit("message", m),
    onMessage: (h) => hostBus.on("message", h),
    close: () => {
      hostBus.removeAllListeners();
      workerBus.removeAllListeners();
    },
  };
  const worker: RpcTransport = {
    postMessage: (m) => hostBus.emit("message", m),
    onMessage: (h) => workerBus.on("message", h),
    close: () => {
      hostBus.removeAllListeners();
      workerBus.removeAllListeners();
    },
  };
  return { host, worker };
}

function noopHandler(): CtxHandler {
  return { handle: vi.fn().mockResolvedValue(null) };
}

/** A dispatcher that settles on `task_result`, as the Tier 1 worker uses. */
function onResult(transport: RpcTransport): Dispatcher {
  return new Dispatcher({ transport, awaitTaskExited: false });
}

/** A dispatcher that settles on `task_exited`, as the Tier 2 worker uses. */
function onExit(transport: RpcTransport): Dispatcher {
  return new Dispatcher({ transport, awaitTaskExited: true });
}

function ctxResultsFrom(worker: RpcTransport): unknown[] {
  const captured: unknown[] = [];
  worker.onMessage((m) => {
    if ((m as { type: string }).type === "ctx_result") captured.push(m);
  });
  return captured;
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

const INVOKE: TaskInvoke = {
  type: "task_invoke",
  id: "task-1",
  skill: "echo",
  inputs: { x: 1 },
};

describe("Dispatcher", () => {
  it("resolves a task when the worker replies with task_result", async () => {
    const { host, worker } = makeTransportPair();
    const d = onResult(host);

    const captured: unknown[] = [];
    worker.onMessage((m) => captured.push(m));

    const promise = d.invoke(INVOKE, { ctxHandler: noopHandler() });
    worker.postMessage({
      type: "task_result",
      id: "task-1",
      ok: true,
      output: { echo: 1 },
    });

    const result = await promise;
    expect(result).toEqual({ type: "task_result", id: "task-1", ok: true, output: { echo: 1 } });
    expect(captured[0]).toEqual(INVOKE);
    d.close();
  });

  it("services a ctx_call mid-task and routes to the handler", async () => {
    const { host, worker } = makeTransportPair();
    const handler: CtxHandler = {
      handle: vi.fn(async ({ method, args }) => {
        if (method === "secrets.get" && (args as { name: string }).name === "foo") return "bar";
        throw new Error("unexpected call");
      }),
    };
    const d = onResult(host);
    const ctxResults = ctxResultsFrom(worker);

    const promise = d.invoke(INVOKE, { ctxHandler: handler });

    worker.postMessage({
      type: "ctx_call",
      taskId: "task-1",
      id: "ctx-1",
      method: "secrets.get",
      args: { name: "foo" },
    });
    await flush();

    expect(handler.handle).toHaveBeenCalledWith({
      method: "secrets.get",
      args: { name: "foo" },
    });
    expect(ctxResults).toEqual([
      { type: "ctx_result", taskId: "task-1", id: "ctx-1", ok: true, value: "bar" },
    ]);

    worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: null });
    await promise;
    d.close();
  });

  it("surfaces CtxError as a typed ctx_result with errorKind", async () => {
    const { host, worker } = makeTransportPair();
    const handler: CtxHandler = {
      handle: vi.fn(async () => {
        throw new CtxError("not_in_allowlist", "secret 'x' not declared");
      }),
    };
    const d = onResult(host);
    const ctxResults = ctxResultsFrom(worker);

    const promise = d.invoke(INVOKE, { ctxHandler: handler });
    worker.postMessage({
      type: "ctx_call",
      taskId: "task-1",
      id: "ctx-2",
      method: "secrets.get",
      args: { name: "x" },
    });
    await flush();

    expect(ctxResults).toEqual([
      {
        type: "ctx_result",
        taskId: "task-1",
        id: "ctx-2",
        ok: false,
        errorKind: "not_in_allowlist",
        message: "secret 'x' not declared",
      },
    ]);

    worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: null });
    await promise;
    d.close();
  });

  it("wraps non-CtxError exceptions as errorKind: internal", async () => {
    const { host, worker } = makeTransportPair();
    const handler: CtxHandler = {
      handle: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const d = onResult(host);
    const ctxResults = ctxResultsFrom(worker);

    const promise = d.invoke(INVOKE, { ctxHandler: handler });
    worker.postMessage({
      type: "ctx_call",
      taskId: "task-1",
      id: "ctx-3",
      method: "secrets.get",
      args: {},
    });
    await flush();

    expect(ctxResults).toEqual([
      {
        type: "ctx_result",
        taskId: "task-1",
        id: "ctx-3",
        ok: false,
        errorKind: "internal",
        message: "boom",
      },
    ]);

    worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: null });
    await promise;
    d.close();
  });

  it("handles concurrent in-flight ctx calls correlated by id", async () => {
    const { host, worker } = makeTransportPair();
    const resolvers = new Map<string, (v: unknown) => void>();
    const handler: CtxHandler = {
      handle: vi.fn(({ args }) => {
        const id = (args as { id: string }).id;
        return new Promise((resolve) => resolvers.set(id, resolve));
      }),
    };
    const d = onResult(host);
    const ctxResults = ctxResultsFrom(worker) as { id: string }[];

    const promise = d.invoke(INVOKE, { ctxHandler: handler });
    worker.postMessage({
      type: "ctx_call",
      taskId: "task-1",
      id: "a",
      method: "now",
      args: { id: "a" },
    });
    worker.postMessage({
      type: "ctx_call",
      taskId: "task-1",
      id: "b",
      method: "now",
      args: { id: "b" },
    });
    await flush();

    // Resolve b first, then a — out of order.
    resolvers.get("b")?.("BBB");
    await flush();
    resolvers.get("a")?.("AAA");
    await flush();

    expect(ctxResults.find((c) => c.id === "a")).toMatchObject({ ok: true, value: "AAA" });
    expect(ctxResults.find((c) => c.id === "b")).toMatchObject({ ok: true, value: "BBB" });

    worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: null });
    await promise;
    d.close();
  });

  it("rejects the in-flight task on task_result id mismatch", async () => {
    const { host, worker } = makeTransportPair();
    const d = onResult(host);

    const promise = d.invoke(INVOKE, { ctxHandler: noopHandler() });
    // The worker is in an inconsistent state (sent the wrong task id).
    // Rejecting surfaces the bug; logging+waiting would hang indefinitely.
    worker.postMessage({ type: "task_result", id: "wrong", ok: true, output: null });

    await expect(promise).rejects.toThrow(/task_result id mismatch/);
    d.close();
  });

  it("rejects malformed messages without crashing", async () => {
    const { host, worker } = makeTransportPair();
    const d = onResult(host);
    const promise = d.invoke(INVOKE, { ctxHandler: noopHandler() });

    worker.postMessage({ type: "garbage" });
    worker.postMessage(null);
    worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: 42 });

    const result = await promise;
    expect(result).toMatchObject({ ok: true, output: 42 });
    d.close();
  });

  it("close() rejects an in-flight task", async () => {
    const { host } = makeTransportPair();
    const d = onResult(host);
    const promise = d.invoke(INVOKE, { ctxHandler: noopHandler() });
    d.close("torn-down");
    await expect(promise).rejects.toThrow(/torn-down/);
  });

  it("throws synchronously on second invoke before first completes", async () => {
    const { host } = makeTransportPair();
    const d = onResult(host);
    const first = d.invoke(INVOKE, { ctxHandler: noopHandler() });
    expect(() => d.invoke({ ...INVOKE, id: "task-2" }, { ctxHandler: noopHandler() })).toThrow(
      /in-flight/,
    );
    d.close();
    await expect(first).rejects.toThrow();
  });

  it("invoke() after close() throws synchronously", () => {
    const { host } = makeTransportPair();
    const d = onResult(host);
    d.close();
    expect(() => d.invoke(INVOKE, { ctxHandler: noopHandler() })).toThrow(/closed/);
  });

  it("close() is idempotent", () => {
    const { host } = makeTransportPair();
    const d = onResult(host);
    d.close();
    expect(() => d.close()).not.toThrow();
  });

  it("ignores task_result that arrives with no pending task", async () => {
    const { host, worker } = makeTransportPair();
    const d = onResult(host);
    // No invoke() yet — fire a stale result.
    worker.postMessage({ type: "task_result", id: "stale", ok: true, output: 1 });
    // Then invoke; the previous result was dropped.
    const promise = d.invoke(INVOKE, { ctxHandler: noopHandler() });
    worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: 7 });
    const result = await promise;
    expect(result).toMatchObject({ output: 7 });
    d.close();
  });

  it("propagates a transport postMessage exception synchronously", () => {
    const throwingTransport: RpcTransport = {
      postMessage: () => {
        throw new Error("transport failed");
      },
      onMessage: () => {},
      close: () => {},
    };
    const d = onResult(throwingTransport);
    expect(() => d.invoke(INVOKE, { ctxHandler: noopHandler() })).toThrow(/transport failed/);
    d.close();
  });

  it("handles 100 concurrent ctx calls without dropping any", async () => {
    const { host, worker } = makeTransportPair();
    const handler: CtxHandler = {
      handle: vi.fn(async ({ args }) => (args as { i: number }).i * 2),
    };
    const d = onResult(host);
    const ctxResults = ctxResultsFrom(worker) as { id: string; value: number }[];

    const promise = d.invoke(INVOKE, { ctxHandler: handler });
    const N = 100;
    for (let i = 0; i < N; i++) {
      worker.postMessage({
        type: "ctx_call",
        taskId: "task-1",
        id: `c-${i}`,
        method: "now",
        args: { i },
      });
    }
    // Drain microtasks until all results have arrived.
    for (let attempt = 0; attempt < 10 && ctxResults.length < N; attempt++) {
      await flush();
    }
    expect(ctxResults).toHaveLength(N);
    for (let i = 0; i < N; i++) {
      expect(ctxResults.find((c) => c.id === `c-${i}`)).toMatchObject({ value: i * 2 });
    }

    worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: null });
    await promise;
    d.close();
  });

  it("ignores ctx_result and task_invoke messages flowing back from the worker", async () => {
    // Both are host→worker only. The dispatcher logs and ignores them.
    const { host, worker } = makeTransportPair();
    const d = onResult(host);
    const promise = d.invoke(INVOKE, { ctxHandler: noopHandler() });
    worker.postMessage({ type: "ctx_result", taskId: "task-1", id: "x", ok: true, value: null });
    worker.postMessage({ type: "task_invoke", id: "echo", skill: "x", inputs: {} });
    worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: 1 });
    const result = await promise;
    expect(result).toMatchObject({ output: 1 });
    d.close();
  });

  it("rejects pending invoke when transport reports a fatal error", async () => {
    // Fatal transport conditions arrive on `onError`, not as a frame on
    // `onMessage`: the dispatcher rejects straight away instead of leaving
    // the task to the wall clock.
    const errorHandlers: Array<(err: Error) => void> = [];
    const transport: RpcTransport = {
      postMessage: () => {},
      onMessage: () => {},
      onError: (h) => {
        errorHandlers.push(h);
      },
      close: () => {},
    };
    const d = onResult(transport);
    const promise = d.invoke(INVOKE, { ctxHandler: noopHandler() });
    const fireError = errorHandlers[0];
    if (!fireError) throw new Error("expected onError to have been wired");
    fireError(new Error("transport: maximum buffer reached"));
    await expect(promise).rejects.toThrow(/transport: maximum buffer reached/);
  });

  it("dispatches sequential tasks on a persistent transport (per-task ctxHandler)", async () => {
    // One Dispatcher serves many tasks; each `invoke()` passes its own
    // ctxHandler, and ctx_calls during task N route to handler N only.
    const { host, worker } = makeTransportPair();
    const d = onResult(host);

    const handlerA: CtxHandler = { handle: vi.fn().mockResolvedValue("A") };
    const handlerB: CtxHandler = { handle: vi.fn().mockResolvedValue("B") };

    worker.onMessage((m) => {
      const msg = m as { type: string; id?: string };
      if (msg.type === "task_invoke" && msg.id === "task-A") {
        worker.postMessage({
          type: "ctx_call",
          taskId: "task-A",
          id: "ctx-A",
          method: "now",
          args: {},
        });
      } else if (msg.type === "ctx_result" && msg.id === "ctx-A") {
        worker.postMessage({ type: "task_result", id: "task-A", ok: true, output: "doneA" });
      } else if (msg.type === "task_invoke" && msg.id === "task-B") {
        worker.postMessage({
          type: "ctx_call",
          taskId: "task-B",
          id: "ctx-B",
          method: "now",
          args: {},
        });
      } else if (msg.type === "ctx_result" && msg.id === "ctx-B") {
        worker.postMessage({ type: "task_result", id: "task-B", ok: true, output: "doneB" });
      }
    });

    const a = await d.invoke({ ...INVOKE, id: "task-A" }, { ctxHandler: handlerA });
    expect(a).toMatchObject({ id: "task-A", output: "doneA" });
    expect(handlerA.handle).toHaveBeenCalledTimes(1);
    expect(handlerB.handle).not.toHaveBeenCalled();

    const b = await d.invoke({ ...INVOKE, id: "task-B" }, { ctxHandler: handlerB });
    expect(b).toMatchObject({ id: "task-B", output: "doneB" });
    expect(handlerA.handle).toHaveBeenCalledTimes(1);
    expect(handlerB.handle).toHaveBeenCalledTimes(1);

    d.close();
  });

  it("rejects the pending task when ctx_result send fails (transport closed mid-task)", async () => {
    // Without surfacing this as a task failure, `invoke()` would hang on a
    // worker still awaiting a ctx_result it will never get.
    let postMessageThrows = false;
    let messageHandler: ((m: unknown) => void) | undefined;
    const transport: RpcTransport = {
      postMessage: (m) => {
        if (postMessageThrows && (m as { type: string }).type === "ctx_result") {
          throw new Error("transport: closed");
        }
      },
      onMessage: (h) => {
        messageHandler = h;
      },
      close: () => {},
    };
    const handler: CtxHandler = { handle: vi.fn().mockResolvedValue("v") };
    const d = onResult(transport);

    const promise = d.invoke(INVOKE, { ctxHandler: handler });
    postMessageThrows = true;
    if (!messageHandler) throw new Error("expected onMessage to have been wired");
    messageHandler({ type: "ctx_call", taskId: "task-1", id: "ctx-1", method: "now", args: {} });

    await expect(promise).rejects.toThrow(/ctx_result send failed/);
    d.close();
  });

  describe("ctx_call task binding", () => {
    it("does not serve a finished task's late ctx_call with the next task's handler", async () => {
      const { host, worker } = makeTransportPair();
      const d = new Dispatcher({ transport: host, awaitTaskExited: false });
      const handlerA: CtxHandler = { handle: vi.fn().mockResolvedValue("A") };
      const handlerB: CtxHandler = { handle: vi.fn().mockResolvedValue("B") };
      const ctxResults: unknown[] = [];
      worker.onMessage((m) => {
        if ((m as { type: string }).type === "ctx_result") ctxResults.push(m);
      });

      const a = d.invoke({ ...INVOKE, id: "task-A" }, { ctxHandler: handlerA });
      worker.postMessage({ type: "task_result", id: "task-A", ok: true, output: null });
      await a;
      const b = d.invoke({ ...INVOKE, id: "task-B" }, { ctxHandler: handlerB });
      // Task A's code outlived its result and calls ctx while B is in flight.
      worker.postMessage({
        type: "ctx_call",
        id: "ctx-late",
        taskId: "task-A",
        method: "secrets.get",
        args: { name: "token" },
      });
      await new Promise((r) => setImmediate(r));

      expect(handlerA.handle).not.toHaveBeenCalled();
      expect(handlerB.handle).not.toHaveBeenCalled();
      expect(ctxResults).toEqual([]);
      worker.postMessage({ type: "task_result", id: "task-B", ok: true, output: null });
      await b;
      d.close();
    });

    it("refuses a ctx_call when no task is in flight", async () => {
      const { host, worker } = makeTransportPair();
      const d = onResult(host);
      const handler: CtxHandler = { handle: vi.fn().mockResolvedValue("v") };
      const ctxResults = ctxResultsFrom(worker);

      const a = d.invoke(INVOKE, { ctxHandler: handler });
      worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: null });
      await a;
      worker.postMessage({ type: "ctx_call", taskId: "task-1", id: "c", method: "now", args: {} });
      await flush();

      expect(handler.handle).not.toHaveBeenCalled();
      expect(ctxResults).toEqual([]);
      d.close();
    });

    it("refuses a ctx_call naming a task other than the running one", async () => {
      const { host, worker } = makeTransportPair();
      const d = onResult(host);
      const handler: CtxHandler = { handle: vi.fn().mockResolvedValue("v") };
      const ctxResults = ctxResultsFrom(worker);

      const promise = d.invoke(INVOKE, { ctxHandler: handler });
      worker.postMessage({ type: "ctx_call", taskId: "task-2", id: "c", method: "now", args: {} });
      await flush();

      expect(handler.handle).not.toHaveBeenCalled();
      expect(ctxResults).toEqual([]);
      worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: null });
      await promise;
      d.close();
    });

    it("refuses a ctx_call from a task that has returned but not yet exited", async () => {
      const { host, worker } = makeTransportPair();
      const d = onExit(host);
      const handler: CtxHandler = { handle: vi.fn().mockResolvedValue("v") };

      const promise = d.invoke(INVOKE, { ctxHandler: handler });
      worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: null });
      worker.postMessage({ type: "ctx_call", taskId: "task-1", id: "c", method: "now", args: {} });
      await flush();

      expect(handler.handle).not.toHaveBeenCalled();
      worker.postMessage({ type: "task_exited", id: "task-1" });
      await promise;
      d.close();
    });

    it("drops the reply to a call whose task returned while it was being served", async () => {
      const { host, worker } = makeTransportPair();
      const d = onResult(host);
      let release: (v: unknown) => void = () => {};
      const handler: CtxHandler = {
        handle: vi.fn(() => new Promise((resolve) => (release = resolve))),
      };
      const ctxResults = ctxResultsFrom(worker);

      const promise = d.invoke(INVOKE, { ctxHandler: handler });
      worker.postMessage({ type: "ctx_call", taskId: "task-1", id: "c", method: "now", args: {} });
      await flush();
      worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: null });
      await promise;
      release("late");
      await flush();

      expect(handler.handle).toHaveBeenCalledTimes(1);
      expect(ctxResults).toEqual([]);
      d.close();
    });
  });

  describe("awaitTaskExited", () => {
    it("settles on task_exited with the task's result", async () => {
      const { host, worker } = makeTransportPair();
      const d = onExit(host);
      let settled = false;
      const promise = d.invoke(INVOKE, { ctxHandler: noopHandler() }).then((r) => {
        settled = true;
        return r;
      });

      worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: 5 });
      await flush();
      expect(settled).toBe(false);
      expect(() => d.invoke({ ...INVOKE, id: "task-2" }, { ctxHandler: noopHandler() })).toThrow(
        /in-flight/,
      );

      worker.postMessage({ type: "task_exited", id: "task-1" });
      await expect(promise).resolves.toEqual({
        type: "task_result",
        id: "task-1",
        ok: true,
        output: 5,
      });
      d.close();
    });

    it("keeps the first of duplicate task_results", async () => {
      const { host, worker } = makeTransportPair();
      const d = onExit(host);
      const promise = d.invoke(INVOKE, { ctxHandler: noopHandler() });
      worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: "first" });
      worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: "second" });
      worker.postMessage({ type: "task_exited", id: "task-1" });
      await expect(promise).resolves.toMatchObject({ output: "first" });
      d.close();
    });

    it("reports a task that exited without a result as failed", async () => {
      const { host, worker } = makeTransportPair();
      const d = onExit(host);
      const promise = d.invoke(INVOKE, { ctxHandler: noopHandler() });
      worker.postMessage({ type: "task_exited", id: "task-1" });
      await expect(promise).resolves.toEqual({
        type: "task_result",
        id: "task-1",
        ok: false,
        error: "task_exited_without_result",
      });
      d.close();
    });

    it("rejects the in-flight task on task_exited id mismatch", async () => {
      const { host, worker } = makeTransportPair();
      const d = onExit(host);
      const promise = d.invoke(INVOKE, { ctxHandler: noopHandler() });
      worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: null });
      worker.postMessage({ type: "task_exited", id: "other" });
      await expect(promise).rejects.toThrow(/task_exited id mismatch/);
      d.close();
    });

    it("ignores task_exited on a dispatcher that settles on the result", async () => {
      const { host, worker } = makeTransportPair();
      const d = onResult(host);
      const promise = d.invoke(INVOKE, { ctxHandler: noopHandler() });
      worker.postMessage({ type: "task_exited", id: "task-1" });
      worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: 3 });
      await expect(promise).resolves.toMatchObject({ output: 3 });
      d.close();
    });
  });
});
