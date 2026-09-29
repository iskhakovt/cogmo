import type { IncomingMessage, ServerResponse } from "node:http";
import { err } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
// vitest-mock-extended gives typed partial mocks for the node http req/res, so
// the SSE handler is unit-testable without a real socket (the disconnect race is
// otherwise non-deterministic over the wire).
import { mock } from "vitest-mock-extended";
import { expectDefined } from "../test/assertions.js";
import { mockTransportDeep } from "../test/factories.js";
import { WebStreamRegistry } from "../transport/adapters/web/stream-registry.js";
import { type ChatRouteDeps, handleChat, SessionCloses, serializeFrame } from "./chat.js";

const OWNER = "web-owner";

/** A minimal GET-stream request; `destroyed` simulates a disconnect during the resume await. */
function streamReq(destroyed = false): IncomingMessage {
  return mock<IncomingMessage>({
    method: "GET",
    url: "/api/chat/conv-1/stream?tab=tab-1",
    destroyed,
  });
}

/** A live response: `end()` on the mock emits no `close`. */
function liveRes() {
  return mock<ServerResponse>({ destroyed: false, writableEnded: false });
}

/** Route deps with a never-aborted shutdown signal unless overridden. */
function routeDeps(overrides: Partial<ChatRouteDeps> = {}): ChatRouteDeps {
  return {
    transport: mockTransportDeep({}), // resumeConversation default -> ok, id "session-resumed"
    registry: new WebStreamRegistry(),
    ownerHandle: OWNER,
    shutdownSignal: new AbortController().signal,
    sessionCloses: new SessionCloses(),
    ...overrides,
  };
}

/** The listener the stream route registered for the response's `close`. */
function closeListener(res: ReturnType<typeof liveRes>): () => void {
  const [, listener] = expectDefined(
    res.on.mock.calls.find(([event]) => event === "close"),
    "close listener",
  );
  return listener;
}

describe("handleChat — stream route", () => {
  it("closes the session and skips the stream when the client vanished mid-resume", async () => {
    const deps = routeDeps();
    const res = mock<ServerResponse>();

    await handleChat(streamReq(true), res, "/api/chat/conv-1/stream", deps);

    expect(deps.transport.closeSession).toHaveBeenCalledWith("session-resumed");
    expect(res.writeHead).not.toHaveBeenCalled(); // never opened the stream
    expect(deps.registry.size).toBe(0);
  });

  it("maps a not-found conversation to 404", async () => {
    const res = mock<ServerResponse>();
    const transport = mockTransportDeep({
      resumeConversation: vi
        .fn()
        .mockResolvedValue(err({ code: "conversation_not_found" as const })),
    });
    await handleChat(streamReq(), res, "/api/chat/conv-1/stream", routeDeps({ transport }));
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.anything());
  });

  it("maps access_denied to 403", async () => {
    const res = mock<ServerResponse>();
    const transport = mockTransportDeep({
      resumeConversation: vi
        .fn()
        .mockResolvedValue(err({ code: "access_denied" as const, reason: "not owned" })),
    });
    await handleChat(streamReq(), res, "/api/chat/conv-1/stream", routeDeps({ transport }));
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.anything());
  });

  it("ends the stream, stops the heartbeat and closes the session once on shutdown", async () => {
    vi.useFakeTimers();
    try {
      const shutdown = new AbortController();
      const deps = routeDeps({ shutdownSignal: shutdown.signal });
      const res = liveRes();
      await handleChat(streamReq(), res, "/api/chat/conv-1/stream", deps);
      expect(deps.registry.size).toBe(1);

      shutdown.abort();
      // A real response emits `close` once `end()` completes.
      closeListener(res)();

      expect(res.end).toHaveBeenCalledTimes(1);
      expect(deps.registry.size).toBe(0);
      expect(deps.transport.closeSession).toHaveBeenCalledTimes(1);
      expect(deps.transport.closeSession).toHaveBeenCalledWith("session-resumed");
      res.write.mockClear();
      vi.advanceTimersByTime(60_000);
      expect(res.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a stream that resumes after shutdown began", async () => {
    const deps = routeDeps({ shutdownSignal: AbortSignal.abort() });
    const res = liveRes();

    await handleChat(streamReq(), res, "/api/chat/conv-1/stream", deps);

    expect(res.writeHead).toHaveBeenCalledWith(503, expect.anything());
    expect(deps.transport.closeSession).toHaveBeenCalledWith("session-resumed");
    expect(deps.registry.size).toBe(0);
  });

  it("stops listening for shutdown once the client disconnects", async () => {
    const shutdown = new AbortController();
    const deps = routeDeps({ shutdownSignal: shutdown.signal });
    const res = liveRes();
    await handleChat(streamReq(), res, "/api/chat/conv-1/stream", deps);

    closeListener(res)();
    shutdown.abort();

    expect(res.end).not.toHaveBeenCalled();
    expect(deps.transport.closeSession).toHaveBeenCalledTimes(1);
    expect(deps.registry.size).toBe(0);
  });
});

describe("SessionCloses", () => {
  it("settles once every close in flight has, a failed one included", async () => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const transport = mockTransportDeep({
      closeSession: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    });
    const closes = new SessionCloses();
    closes.start(transport, "session-a");
    closes.start(transport, "session-b");
    let settled = false;

    const settling = closes.settled().then(() => {
      settled = true;
    });
    first.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    second.reject(new Error("db gone"));

    await settling;
    expect(settled).toBe(true);
  });
});

describe("serializeFrame", () => {
  it("splits a multi-line data payload into one data: line each (SSE spec)", () => {
    expect(serializeFrame({ event: "status", data: "a\nb" })).toBe(
      "event: status\ndata: a\ndata: b\n\n",
    );
  });

  it("emits id, event, and data in order", () => {
    expect(serializeFrame({ id: "7", event: "x", data: "{}" })).toBe(
      "id: 7\nevent: x\ndata: {}\n\n",
    );
  });

  it("omits id and event when absent (the default message event)", () => {
    expect(serializeFrame({ data: "hi" })).toBe("data: hi\n\n");
  });
});
