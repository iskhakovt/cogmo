/** `setup()` with a stub transport, and the grammY contexts the adapter's tests drive its handlers with. */

import { ok } from "neverthrow";
import { vi } from "vitest";
import { setup } from "../../transport/adapters/telegram/index.js";
import { asBatchAdapter } from "../assertions.js";
import { mockAttachmentStore, mockInngest, mockTransport } from "../factories.js";

export function makeCtx(fromId: number, text = "hello", chatId = 42) {
  return {
    from: { id: fromId },
    chat: { id: chatId },
    message: { text, date: 1700000000 },
    reply: vi.fn().mockResolvedValue({}),
    api: { sendChatAction: vi.fn().mockResolvedValue(true) },
  };
}

export function makePhotoCtx(fromId: number, caption?: string, chatId = 42) {
  return {
    from: { id: fromId },
    chat: { id: chatId },
    message: {
      date: 1700000000,
      caption,
      photo: [
        { file_id: "small_id", width: 90, height: 90 },
        { file_id: "large_id", width: 800, height: 600 },
      ],
    },
    api: {
      sendChatAction: vi.fn().mockResolvedValue(true),
      getFile: vi.fn().mockResolvedValue({ file_path: "photos/file_1.jpg" }),
    },
  };
}

export function makeVoiceCtx(
  fromId: number,
  voice: { file_id?: string; duration?: number; mime_type?: string } = {},
  caption?: string,
  chatId = 42,
) {
  return {
    from: { id: fromId },
    chat: { id: chatId },
    message: {
      date: 1700000000,
      caption,
      voice: {
        file_id: voice.file_id ?? "voice_id",
        duration: voice.duration ?? 5,
        ...(voice.mime_type !== undefined && { mime_type: voice.mime_type }),
      },
    },
    api: {
      sendChatAction: vi.fn().mockResolvedValue(true),
      getFile: vi.fn().mockResolvedValue({ file_path: "voice/file_1.ogg" }),
    },
  };
}

export function makeDocumentCtx(
  fromId: number,
  doc: {
    file_id?: string;
    file_name?: string;
    mime_type?: string;
  } = {},
  caption?: string,
  chatId = 42,
) {
  return {
    from: { id: fromId },
    chat: { id: chatId },
    message: {
      date: 1700000000,
      caption,
      document: {
        file_id: doc.file_id ?? "doc_id",
        ...(doc.file_name !== undefined && { file_name: doc.file_name }),
        ...(doc.mime_type !== undefined && { mime_type: doc.mime_type }),
      },
    },
    api: {
      sendChatAction: vi.fn().mockResolvedValue(true),
      getFile: vi.fn().mockResolvedValue({ file_path: "documents/file_1" }),
    },
  };
}

export async function createAdapter(
  transportOverrides?: Partial<ReturnType<typeof mockTransport>>,
) {
  const transport = mockTransport({
    resolveSession: vi.fn().mockResolvedValue({
      id: "session-1",
      channelId: "tg-ch",
      platformAddress: "42",
      conversationId: "conv-1",
      status: "active",
      receive: "routed",
    }),
    createConversation: vi.fn().mockResolvedValue(
      ok({
        id: "session-2",
        channelId: "tg-ch",
        platformAddress: "42",
        conversationId: "conv-2",
        status: "active",
        receive: "routed",
        profileName: "assistant",
      }),
    ),
    emit: vi.fn().mockResolvedValue(ok(undefined)),
    ...transportOverrides,
  });

  const attachments = mockAttachmentStore();

  const result = await setup({
    channelId: "tg-ch",
    credentials: { token: "fake" },
    transport,
    attachments,
    inngest: mockInngest(),
    boundary: { promptTimeoutMs: 30000, minUserTurns: 3 },
  });

  return { adapter: asBatchAdapter(result.adapter), transport, attachments };
}
