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
import { handleChat, serializeFrame } from "./chat.js";

const OWNER = "web-owner";
/** For the cases that never open a stream. */
const NO_SHUTDOWN = new AbortController().signal;

/** A minimal GET-stream request; `destroyed` simulates a disconnect during the resume await. */
function streamReq(destroyed = false): IncomingMessage {
  return mock<IncomingMessage>({
    method: "GET",
    url: "/api/chat/conv-1/stream?tab=tab-1",
    destroyed,
  });
}

describe("handleChat — stream route", () => {
  it("closes the session and skips the stream when the client vanished mid-resume", async () => {
    const registry = new WebStreamRegistry();
    const transport = mockTransportDeep({}); // resumeConversation default -> ok, id "session-resumed"
    const res = mock<ServerResponse>();

    await handleChat(streamReq(true), res, "/api/chat/conv-1/stream", {
      transport,
      registry,
      ownerHandle: OWNER,
      shutdownSignal: NO_SHUTDOWN,
    });

    expect(transport.closeSession).toHaveBeenCalledWith("session-resumed");
    expect(res.writeHead).not.toHaveBeenCalled(); // never opened the stream
    expect(registry.size).toBe(0);
  });

  it("maps a not-found conversation to 404", async () => {
    const res = mock<ServerResponse>();
    const transport = mockTransportDeep({
      resumeConversation: vi
        .fn()
        .mockResolvedValue(err({ code: "conversation_not_found" as const })),
    });
    await handleChat(streamReq(), res, "/api/chat/conv-1/stream", {
      transport,
      registry: new WebStreamRegistry(),
      ownerHandle: OWNER,
      shutdownSignal: NO_SHUTDOWN,
    });
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.anything());
  });

  it("maps access_denied to 403", async () => {
    const res = mock<ServerResponse>();
    const transport = mockTransportDeep({
      resumeConversation: vi
        .fn()
        .mockResolvedValue(err({ code: "access_denied" as const, reason: "not owned" })),
    });
    await handleChat(streamReq(), res, "/api/chat/conv-1/stream", {
      transport,
      registry: new WebStreamRegistry(),
      ownerHandle: OWNER,
      shutdownSignal: NO_SHUTDOWN,
    });
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.anything());
  });

  it("ends the stream, stops the heartbeat and closes the session on shutdown", async () => {
    vi.useFakeTimers();
    try {
      const registry = new WebStreamRegistry();
      const transport = mockTransportDeep({});
      // A live response: `end()` on the mock emits no `close`, so the shutdown
      // path has to tear down on its own.
      const res = mock<ServerResponse>({ destroyed: false, writableEnded: false });
      const shutdown = new AbortController();
      await handleChat(streamReq(), res, "/api/chat/conv-1/stream", {
        transport,
        registry,
        ownerHandle: OWNER,
        shutdownSignal: shutdown.signal,
      });
      expect(registry.size).toBe(1);

      shutdown.abort();

      expect(res.end).toHaveBeenCalledTimes(1);
      expect(registry.size).toBe(0);
      expect(transport.closeSession).toHaveBeenCalledWith("session-resumed");
      res.write.mockClear();
      vi.advanceTimersByTime(60_000);
      expect(res.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a stream that resumes after shutdown began", async () => {
    const registry = new WebStreamRegistry();
    const transport = mockTransportDeep({});
    const res = mock<ServerResponse>({ destroyed: false, writableEnded: false });

    await handleChat(streamReq(), res, "/api/chat/conv-1/stream", {
      transport,
      registry,
      ownerHandle: OWNER,
      shutdownSignal: AbortSignal.abort(),
    });

    expect(res.writeHead).toHaveBeenCalledWith(503, expect.anything());
    expect(transport.closeSession).toHaveBeenCalledWith("session-resumed");
    expect(registry.size).toBe(0);
  });

  it("stops listening for shutdown once the client disconnects", async () => {
    const registry = new WebStreamRegistry();
    const transport = mockTransportDeep({});
    const res = mock<ServerResponse>({ destroyed: false, writableEnded: false });
    const shutdown = new AbortController();
    await handleChat(streamReq(), res, "/api/chat/conv-1/stream", {
      transport,
      registry,
      ownerHandle: OWNER,
      shutdownSignal: shutdown.signal,
    });
    const [, onClose] = expectDefined(
      res.on.mock.calls.find(([event]) => event === "close"),
      "close listener",
    );

    onClose();
    shutdown.abort();

    expect(res.end).not.toHaveBeenCalled();
    expect(transport.closeSession).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
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
