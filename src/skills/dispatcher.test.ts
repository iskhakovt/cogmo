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

const INVOKE: TaskInvoke = {
  type: "task_invoke",
  id: "task-1",
  skill: "echo",
  inputs: { x: 1 },
};

describe("Dispatcher", () => {
  it("resolves a task when the worker replies with task_result", async () => {
    const { host, worker } = makeTransportPair();
    const d = new Dispatcher({ transport: host, ctxHandler: noopHandler() });

    const captured: unknown[] = [];
    worker.onMessage((m) => captured.push(m));

    const promise = d.invoke(INVOKE);
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
    const d = new Dispatcher({ transport: host, ctxHandler: handler });

    const ctxResults: unknown[] = [];
    worker.onMessage((m) => {
      const msg = m as { type: string };
      if (msg.type === "ctx_result") ctxResults.push(m);
    });

    const promise = d.invoke(INVOKE);

    worker.postMessage({
      type: "ctx_call",
      id: "ctx-1",
      method: "secrets.get",
      args: { name: "foo" },
    });
    // Wait a microtask cycle for the handler promise to flush.
    await new Promise((r) => setImmediate(r));

    expect(handler.handle).toHaveBeenCalledWith({
      method: "secrets.get",
      args: { name: "foo" },
    });
    expect(ctxResults).toEqual([{ type: "ctx_result", id: "ctx-1", ok: true, value: "bar" }]);

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
    const d = new Dispatcher({ transport: host, ctxHandler: handler });

    const captured: unknown[] = [];
    worker.onMessage((m) => {
      const msg = m as { type: string };
      if (msg.type === "ctx_result") captured.push(m);
    });

    const promise = d.invoke(INVOKE);
    worker.postMessage({
      type: "ctx_call",
      id: "ctx-2",
      method: "secrets.get",
      args: { name: "x" },
    });
    await new Promise((r) => setImmediate(r));

    expect(captured).toEqual([
      {
        type: "ctx_result",
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
    const d = new Dispatcher({ transport: host, ctxHandler: handler });

    let last: unknown;
    worker.onMessage((m) => {
      const msg = m as { type: string };
      if (msg.type === "ctx_result") last = m;
    });

    const promise = d.invoke(INVOKE);
    worker.postMessage({
      type: "ctx_call",
      id: "ctx-3",
      method: "secrets.get",
      args: {},
    });
    await new Promise((r) => setImmediate(r));

    expect(last).toEqual({
      type: "ctx_result",
      id: "ctx-3",
      ok: false,
      errorKind: "internal",
      message: "boom",
    });

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
    const d = new Dispatcher({ transport: host, ctxHandler: handler });

    const captured: { type: string; id: string; value?: unknown }[] = [];
    worker.onMessage((m) => {
      const msg = m as { type: string; id: string };
      if (msg.type === "ctx_result") captured.push(m as never);
    });

    const promise = d.invoke(INVOKE);
    worker.postMessage({ type: "ctx_call", id: "a", method: "now", args: { id: "a" } });
    worker.postMessage({ type: "ctx_call", id: "b", method: "now", args: { id: "b" } });
    await new Promise((r) => setImmediate(r));

    // Resolve b first, then a — out of order.
    resolvers.get("b")?.("BBB");
    await new Promise((r) => setImmediate(r));
    resolvers.get("a")?.("AAA");
    await new Promise((r) => setImmediate(r));

    expect(captured.find((c) => c.id === "a")).toMatchObject({ ok: true, value: "AAA" });
    expect(captured.find((c) => c.id === "b")).toMatchObject({ ok: true, value: "BBB" });

    worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: null });
    await promise;
    d.close();
  });

  it("rejects the in-flight task on task_result id mismatch", async () => {
    const { host, worker } = makeTransportPair();
    const d = new Dispatcher({ transport: host, ctxHandler: noopHandler() });

    const promise = d.invoke(INVOKE);
    // The worker is in an inconsistent state (sent the wrong task id).
    // Rejecting surfaces the bug; logging+waiting would hang indefinitely.
    worker.postMessage({ type: "task_result", id: "wrong", ok: true, output: null });

    await expect(promise).rejects.toThrow(/id mismatch/);
    d.close();
  });

  it("rejects malformed messages without crashing", async () => {
    const { host, worker } = makeTransportPair();
    const d = new Dispatcher({ transport: host, ctxHandler: noopHandler() });
    const promise = d.invoke(INVOKE);

    worker.postMessage({ type: "garbage" });
    worker.postMessage(null);
    worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: 42 });

    const result = await promise;
    expect(result).toMatchObject({ ok: true, output: 42 });
    d.close();
  });

  it("close() rejects an in-flight task", async () => {
    const { host } = makeTransportPair();
    const d = new Dispatcher({ transport: host, ctxHandler: noopHandler() });
    const promise = d.invoke(INVOKE);
    d.close("torn-down");
    await expect(promise).rejects.toThrow(/torn-down/);
  });

  it("throws synchronously on second invoke before first completes", async () => {
    const { host } = makeTransportPair();
    const d = new Dispatcher({ transport: host, ctxHandler: noopHandler() });
    const first = d.invoke(INVOKE);
    expect(() => d.invoke({ ...INVOKE, id: "task-2" })).toThrow(/in-flight/);
    d.close();
    await expect(first).rejects.toThrow();
  });

  it("invoke() after close() throws synchronously", () => {
    const { host } = makeTransportPair();
    const d = new Dispatcher({ transport: host, ctxHandler: noopHandler() });
    d.close();
    expect(() => d.invoke(INVOKE)).toThrow(/closed/);
  });

  it("close() is idempotent", () => {
    const { host } = makeTransportPair();
    const d = new Dispatcher({ transport: host, ctxHandler: noopHandler() });
    d.close();
    expect(() => d.close()).not.toThrow();
  });

  it("ignores task_result that arrives with no pending task", async () => {
    const { host, worker } = makeTransportPair();
    const d = new Dispatcher({ transport: host, ctxHandler: noopHandler() });
    // No invoke() yet — fire a stale result.
    worker.postMessage({ type: "task_result", id: "stale", ok: true, output: 1 });
    // Then invoke; the previous result was dropped.
    const promise = d.invoke(INVOKE);
    worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: 7 });
    const result = await promise;
    expect(result).toMatchObject({ output: 7 });
    d.close();
  });

  it("propagates a transport postMessage exception synchronously", () => {
    const throwingTransport = {
      postMessage: () => {
        throw new Error("transport failed");
      },
      onMessage: () => {},
      close: () => {},
    };
    const d = new Dispatcher({ transport: throwingTransport, ctxHandler: noopHandler() });
    expect(() => d.invoke(INVOKE)).toThrow(/transport failed/);
    d.close();
  });

  it("ctx handler returning a non-promise value is wrapped correctly", async () => {
    const { host, worker } = makeTransportPair();
    const handler: CtxHandler = {
      // biome-ignore lint/suspicious/useAwait: testing sync return path
      handle: async () => "raw-string-value",
    };
    const d = new Dispatcher({ transport: host, ctxHandler: handler });

    let last: unknown;
    worker.onMessage((m) => {
      const msg = m as { type: string };
      if (msg.type === "ctx_result") last = m;
    });

    const promise = d.invoke(INVOKE);
    worker.postMessage({ type: "ctx_call", id: "c", method: "now", args: {} });
    await new Promise((r) => setImmediate(r));
    expect(last).toMatchObject({ ok: true, value: "raw-string-value" });
    worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: null });
    await promise;
    d.close();
  });

  it("handles 100 concurrent ctx calls without dropping any", async () => {
    const { host, worker } = makeTransportPair();
    const handler: CtxHandler = {
      handle: vi.fn(async ({ args }) => (args as { i: number }).i * 2),
    };
    const d = new Dispatcher({ transport: host, ctxHandler: handler });

    const ctxResults: { id: string; value: number }[] = [];
    worker.onMessage((m) => {
      const msg = m as { type: string };
      if (msg.type === "ctx_result") ctxResults.push(m as never);
    });

    const promise = d.invoke(INVOKE);
    const N = 100;
    for (let i = 0; i < N; i++) {
      worker.postMessage({ type: "ctx_call", id: `c-${i}`, method: "now", args: { i } });
    }
    // Drain microtasks until all results have arrived.
    for (let attempt = 0; attempt < 10 && ctxResults.length < N; attempt++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(ctxResults).toHaveLength(N);
    // Verify each call's value matches its input id.
    for (let i = 0; i < N; i++) {
      const r = ctxResults.find((c) => c.id === `c-${i}`);
      expect(r).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: existence asserted above
      expect((r! as unknown as { value: number }).value).toBe(i * 2);
    }

    worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: null });
    await promise;
    d.close();
  });

  it("ctx_result for unknown id is silently dropped", async () => {
    const { host, worker } = makeTransportPair();
    const d = new Dispatcher({ transport: host, ctxHandler: noopHandler() });
    const promise = d.invoke(INVOKE);
    // No ctx_call was issued — this stray ctx_result should be ignored.
    // (Dispatcher only routes ctx_results emitted by the worker; the host
    // never sees its own ctx_result, but the schema allows the message.)
    worker.postMessage({
      type: "ctx_result",
      id: "unknown",
      ok: true,
      value: null,
    });
    worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: 99 });
    const result = await promise;
    expect(result).toMatchObject({ output: 99 });
    d.close();
  });

  it("ignores task_invoke messages flowing back from the worker", async () => {
    // Defensive — task_invoke is host→worker only. If the worker echoes one,
    // the dispatcher logs and ignores. Asserts no crash + task still resolves.
    const { host, worker } = makeTransportPair();
    const d = new Dispatcher({ transport: host, ctxHandler: noopHandler() });
    const promise = d.invoke(INVOKE);
    worker.postMessage({
      type: "task_invoke",
      id: "echo",
      skill: "x",
      inputs: {},
    });
    worker.postMessage({ type: "task_result", id: "task-1", ok: true, output: 1 });
    const result = await promise;
    expect(result).toMatchObject({ output: 1 });
    d.close();
  });

  it("rejects pending invoke when transport reports a fatal error", async () => {
    // Regression test: an earlier sysbox transport surfaced overflow as a
    // synthetic `{ type: "fatal" }` frame on `onMessage`, but `fatal` isn't
    // in the worker protocol so the dispatcher dropped it silently and the
    // task hung until host wall-clock fired. The fix routes fatal errors
    // through `onError` and the dispatcher rejects immediately.
    let fireError: ((err: Error) => void) | null = null;
    const transport: RpcTransport = {
      postMessage: () => {},
      onMessage: () => {},
      onError: (h) => {
        fireError = h;
      },
      close: () => {},
    };
    const d = new Dispatcher({ transport, ctxHandler: noopHandler() });
    const promise = d.invoke(INVOKE);
    expect(fireError).not.toBeNull();
    fireError?.(new Error("transport: maximum buffer reached"));
    await expect(promise).rejects.toThrow(/transport: maximum buffer reached/);
  });
});
