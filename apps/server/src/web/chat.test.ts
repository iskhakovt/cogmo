import type { IncomingMessage, ServerResponse } from "node:http";
import { err } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
// vitest-mock-extended gives typed partial mocks for the node http req/res, so
// the SSE handler is unit-testable without a real socket (the disconnect race is
// otherwise non-deterministic over the wire).
import { mock } from "vitest-mock-extended";
import { mockTransportDeep } from "../test/factories.js";
import { WebStreamRegistry } from "../transport/adapters/web/stream-registry.js";
import { handleChat, serializeFrame } from "./chat.js";

const OWNER = "web-owner";

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
    });
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.anything());
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
