import { ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { mockStep, mockTransport } from "../../test/factories.js";
import { setup } from "./direct.js";

const activeSession = {
  id: "session-1",
  channelId: "direct-ch",
  platformAddress: "console-0",
  conversationId: "conv-1",
  status: "active",
  receive: "routed",
};

const baseEvent = {
  data: {
    platformAddress: "console-0",
    text: "hello",
    platformTs: "2026-01-01T00:00:00Z",
  },
};

async function setupAdapter(transportOverrides?: Partial<ReturnType<typeof mockTransport>>) {
  const transport = mockTransport({
    resolveSession: vi.fn().mockResolvedValue(activeSession),
    createConversation: vi.fn().mockResolvedValue(ok(activeSession)),
    emit: vi.fn().mockResolvedValue(ok(undefined)),
    ...transportOverrides,
  });

  const result = await setup({
    channelId: "direct-ch",
    credentials: {},
    transport,
  });

  // The inbound Inngest function
  const inboundFn = result.functions[0];

  return { transport, adapter: result.adapter, inboundFn };
}

describe("direct adapter", () => {
  describe("inbound", () => {
    it("resolves session and emits via transport", async () => {
      const { transport, inboundFn } = await setupAdapter();
      const step = mockStep();

      await (inboundFn as any).fn({ event: baseEvent, step });

      expect(transport.resolveSession).toHaveBeenCalledWith("console-0");
      expect(transport.emit).toHaveBeenCalledWith("session-1", "hello", expect.any(Date));
    });

    it("creates conversation when no session exists", async () => {
      const { transport, inboundFn } = await setupAdapter({
        resolveSession: vi.fn().mockResolvedValue(null),
      });
      const step = mockStep();

      await (inboundFn as any).fn({ event: baseEvent, step });

      expect(transport.createConversation).toHaveBeenCalledWith("console-0", "console-0", {
        isPrivate: true,
      });
    });

    it("handles /new by closing session", async () => {
      const { transport, inboundFn } = await setupAdapter();
      const step = mockStep();

      const result = await (inboundFn as any).fn({
        event: { data: { ...baseEvent.data, text: "/new" } },
        step,
      });

      expect(transport.closeSession).toHaveBeenCalledWith("session-1");
      expect(result).toEqual({ status: "new_conversation" });
    });
  });

  describe("deliver", () => {
    it("is a function", async () => {
      const { adapter } = await setupAdapter();
      expect(adapter.deliver).toBeTypeOf("function");
    });
  });
});
