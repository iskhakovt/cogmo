import { ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { asBatchAdapter, expectDefined } from "../../test/assertions.js";
import {
  makeStepRun,
  mockAttachmentStore,
  mockInngest,
  mockTransport,
} from "../../test/factories.js";
import { handleDirectInbound, setup } from "./direct.js";

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

function makeTransport(overrides?: Partial<ReturnType<typeof mockTransport>>) {
  return mockTransport({
    resolveSession: vi.fn().mockResolvedValue(activeSession),
    createConversation: vi
      .fn()
      .mockResolvedValue(ok({ ...activeSession, profileName: "assistant" })),
    emit: vi.fn().mockResolvedValue(ok(undefined)),
    ...overrides,
  });
}

async function setupAdapter(transportOverrides?: Partial<ReturnType<typeof mockTransport>>) {
  const transport = makeTransport(transportOverrides);
  const inngest = mockInngest();

  const result = await setup({
    channelId: "direct-ch",
    credentials: {},
    transport,
    inngest,
    attachments: mockAttachmentStore(),
    boundary: { promptTimeoutMs: 30000, minUserTurns: 3 },
  });

  return { transport, adapter: asBatchAdapter(result.adapter), inngest };
}

describe("direct adapter", () => {
  describe("handleDirectInbound", () => {
    it("resolves session and emits via transport", async () => {
      const transport = makeTransport();

      await handleDirectInbound({ transport }, baseEvent.data, makeStepRun());

      expect(transport.resolveSession).toHaveBeenCalledWith("console-0");
      expect(transport.emit).toHaveBeenCalledWith("session-1", "hello", expect.any(Date));
    });

    it("creates conversation when no session exists", async () => {
      const transport = makeTransport({ resolveSession: vi.fn().mockResolvedValue(null) });

      await handleDirectInbound({ transport }, baseEvent.data, makeStepRun());

      expect(transport.createConversation).toHaveBeenCalledWith("console-0", "console-0", {
        isPrivate: true,
      });
    });

    it("handles /new by closing session", async () => {
      const transport = makeTransport();

      const result = await handleDirectInbound(
        { transport },
        { ...baseEvent.data, text: "/new" },
        makeStepRun(),
      );

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
      const { adapter, inngest } = await setupAdapter();
      const send = vi.mocked(inngest.send);

      await adapter.sendVoice!("console-0", {
        audio: Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x01, 0x02]),
        mediaType: "audio/ogg",
      });

      expect(send).toHaveBeenCalledTimes(1);
      const event = expectDefined(send.mock.calls[0])[0] as {
        name: string;
        data: Record<string, unknown>;
      };
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
    });

    it("does not include images or other fields on the voice event", async () => {
      const { adapter, inngest } = await setupAdapter();
      const send = vi.mocked(inngest.send);

      await adapter.sendVoice!("console-0", {
        audio: Buffer.from("x"),
        mediaType: "audio/ogg",
      });

      const event = expectDefined(send.mock.calls[0])[0] as { data: Record<string, unknown> };
      expect(event.data).not.toHaveProperty("images");
    });
  });
});
