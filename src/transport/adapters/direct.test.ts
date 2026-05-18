import { ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { inngest } from "../../inngest/client.js";
import type { directInbound } from "../../inngest/events.js";
import {
  invokeInngestFn,
  type MockStep,
  mockAttachmentStore,
  mockStep,
  mockTransport,
} from "../../test/factories.js";
import { setup } from "./direct.js";

type DirectInboundData = z.infer<typeof directInbound.schema>;

interface DirectInboundCtx {
  event: { data: DirectInboundData };
  step: MockStep;
}

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
    createConversation: vi
      .fn()
      .mockResolvedValue(ok({ ...activeSession, profileName: "assistant" })),
    emit: vi.fn().mockResolvedValue(ok(undefined)),
    ...transportOverrides,
  });

  const result = await setup({
    channelId: "direct-ch",
    credentials: {},
    transport,
    attachments: mockAttachmentStore(),
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

      await invokeInngestFn<DirectInboundCtx>(inboundFn, { event: baseEvent, step });

      expect(transport.resolveSession).toHaveBeenCalledWith("console-0");
      expect(transport.emit).toHaveBeenCalledWith("session-1", "hello", expect.any(Date));
    });

    it("creates conversation when no session exists", async () => {
      const { transport, inboundFn } = await setupAdapter({
        resolveSession: vi.fn().mockResolvedValue(null),
      });
      const step = mockStep();

      await invokeInngestFn<DirectInboundCtx>(inboundFn, { event: baseEvent, step });

      expect(transport.createConversation).toHaveBeenCalledWith("console-0", "console-0", {
        isPrivate: true,
      });
    });

    it("handles /new by closing session", async () => {
      const { transport, inboundFn } = await setupAdapter();
      const step = mockStep();

      const result = await invokeInngestFn<DirectInboundCtx>(inboundFn, {
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

  describe("sendVoice", () => {
    it("emits directOutbound with base64 audio + mediaType, content empty", async () => {
      const { adapter } = await setupAdapter();
      const sendSpy = vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] });

      await adapter.sendVoice!("console-0", {
        audio: Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x01, 0x02]),
        mediaType: "audio/ogg",
      });

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const event = sendSpy.mock.calls[0]![0] as { name: string; data: Record<string, unknown> };
      expect(event.name).toBe("adapter/direct/outbound");
      expect(event.data).toMatchObject({
        platformAddress: "console-0",
        content: "",
        voice: {
          mediaType: "audio/ogg",
        },
      });
      // base64-encoded round-trips back to the original bytes — guards
      // against accidentally serializing the Buffer object itself.
      const data = (event.data.voice as { data: string }).data;
      expect(Buffer.from(data, "base64").toString("hex")).toBe("4f6767530102");

      sendSpy.mockRestore();
    });

    it("does not include images or other fields on the voice event", async () => {
      const { adapter } = await setupAdapter();
      const sendSpy = vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] });

      await adapter.sendVoice!("console-0", {
        audio: Buffer.from("x"),
        mediaType: "audio/ogg",
      });

      const event = sendSpy.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(event.data).not.toHaveProperty("images");

      sendSpy.mockRestore();
    });
  });
});
