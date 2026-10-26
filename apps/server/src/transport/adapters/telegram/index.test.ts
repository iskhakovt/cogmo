import { err } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAN_CALLBACK_REGEX } from "../../../agent/coding/plan-keyboard.js";
import {
  mockAttachmentStore,
  mockInngest,
  mockTransport,
  mockTransportDeep,
} from "../../../test/factories.js";
import {
  botLifecycle,
  deliverUpdate,
  mockBotApi,
  resetGrammyMock,
  runUpdate,
} from "../../../test/telegram/grammy-mock.js";
import {
  makeCtx,
  makeDocumentCtx,
  makePhotoCtx,
  makeVoiceCtx,
} from "../../../test/telegram/harness.js";
import type { Transport } from "../../transport.js";
import { setup } from "./index.js";

vi.mock("grammy", async () => (await import("../../../test/telegram/grammy-mock.js")).grammyModule);

function setupWith(
  credentials: Parameters<typeof setup>[0]["credentials"],
  transport: Transport = mockTransport(),
) {
  return setup({
    channelId: "tg-ch",
    credentials,
    transport,
    attachments: mockAttachmentStore(),
    inngest: mockInngest(),
    boundary: { promptTimeoutMs: 30000, minUserTurns: 3 },
  });
}

describe("setup", () => {
  beforeEach(() => {
    resetGrammyMock();
  });

  it("refuses credentials without a bot token, before building a bot", async () => {
    await expect(setupWith({ apiRoot: "https://api.example" })).rejects.toThrow(
      /telegram credentials/,
    );
    expect(mockBotApi.setMyCommands).not.toHaveBeenCalled();
  });

  it("refuses a non-string api root", async () => {
    await expect(setupWith({ token: "fake", apiRoot: 42 })).rejects.toThrow(/telegram credentials/);
  });

  it("starts with a token and an optional api root", async () => {
    await expect(setupWith({ token: "fake" })).resolves.toBeDefined();
    await expect(
      setupWith({ token: "fake", apiRoot: "https://api.example" }),
    ).resolves.toBeDefined();
  });

  it("builds the bot on Telegram's own server when the apiRoot is empty", async () => {
    await setupWith({ token: "fake", apiRoot: "" });

    expect(botLifecycle.options).toEqual({ client: { apiRoot: "https://api.telegram.org" } });
  });

  it("builds the bot on the channel's apiRoot", async () => {
    await setupWith({ token: "fake", apiRoot: "http://bot-api.local:8081" });

    expect(botLifecycle.options).toEqual({ client: { apiRoot: "http://bot-api.local:8081" } });
  });

  // grammY runs middleware in registration order, and a handler that answers
  // an update doesn't call next(). The update-id middleware goes first so it
  // wraps every handler, then the sender gate, so no handler runs for a sender
  // the channel doesn't admit; commands go ahead of the message handlers, so a
  // `/new` never also reaches `message:text`; polling starts last.
  it("registers the bot's middleware in dispatch order", async () => {
    await setupWith({ token: "fake" });

    const order = botLifecycle.registrations;
    expect(order.slice(0, 3)).toEqual(["use", "use", "drop"]);
    expect(order.at(-1)).toBe("start");
    const drop = order.indexOf("drop");
    const text = order.indexOf("on:message:text");
    expect(text).toBeGreaterThan(drop);
    expect(order.lastIndexOf("callbackQuery")).toBeLessThan(text);
  });

  it("counts an update whose handler throws as handled", async () => {
    const handler = vi.fn(async () => {
      throw new Error("handler failed");
    });
    botLifecycle.polling = () => runUpdate(5, handler).catch(() => {});
    const { adapter } = await setupWith({ token: "fake" });

    await adapter.stop();

    expect(handler).toHaveBeenCalledOnce();
    expect(mockBotApi.getUpdates).toHaveBeenCalledWith({ offset: 6, limit: 1, timeout: 0 });
  });

  it("counts an update the sender gate drops as handled", async () => {
    const handler = vi.fn(async () => {});
    botLifecycle.polling = () => runUpdate(5, handler);
    const { adapter } = await setupWith({ token: "fake" }, strangerTransport());

    await adapter.stop();

    expect(handler).not.toHaveBeenCalled();
    expect(mockBotApi.getUpdates).toHaveBeenCalledWith({ offset: 6, limit: 1, timeout: 0 });
  });
});

const STRANGER = 999;
const TASK_ID = "00000000-0000-0000-0000-000000000001";

/** Paths of the mock functions under `value` that were called, e.g. `api.getFile`. */
function calledMocks(value: object, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, member]) => {
    const path = `${prefix}${key}`;
    if (vi.isMockFunction(member)) return member.mock.calls.length > 0 ? [path] : [];
    return typeof member === "object" && member !== null ? calledMocks(member, `${path}.`) : [];
  });
}

/** An update carrying `ctx`, with every way a handler could answer it recorded. */
function update<C extends object>(ctx: C) {
  return {
    update: { update_id: 1 },
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    editMessageText: vi.fn().mockResolvedValue({}),
    editMessageReplyMarkup: vi.fn().mockResolvedValue({}),
    ...ctx,
  };
}

function tap(data: string, match: ReadonlyArray<string>) {
  return { from: { id: STRANGER }, chat: { id: STRANGER }, callbackQuery: { data }, match };
}

/** A transport that admits no one and, past the gate, rejects a stranger as the Transport does. */
function strangerTransport(): Transport {
  const rejected = () => vi.fn().mockResolvedValue(err({ code: "identity_rejected" as const }));
  return mockTransportDeep({
    senders: { admits: vi.fn().mockResolvedValue(false) },
    createConversation: rejected(),
    resumeConversation: rejected(),
    coding: { approvePlan: rejected() },
  });
}

describe("the sender gate", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetGrammyMock();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => new Uint8Array([104, 105]).buffer,
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each<[string, string, () => object]>([
    ["a text message", "on:message:text", () => makeCtx(STRANGER, "hello", STRANGER)],
    ["/start", "command:start", () => ({ ...makeCtx(STRANGER, "/start", STRANGER), match: "" })],
    ["/new", "command:new", () => ({ ...makeCtx(STRANGER, "/new", STRANGER), match: "" })],
    ["a photo", "on:message:photo", () => makePhotoCtx(STRANGER, undefined, STRANGER)],
    ["a voice note", "on:message:voice", () => makeVoiceCtx(STRANGER, {}, undefined, STRANGER)],
    [
      "a document",
      "on:message:document",
      () => makeDocumentCtx(STRANGER, { file_name: "notes.txt" }, undefined, STRANGER),
    ],
    ["a /sessions tap", "callbackQuery:^resume:(.+)$", () => tap("resume:work", ["", "work"])],
    [
      "a plan approval tap",
      `callbackQuery:${PLAN_CALLBACK_REGEX.source}`,
      () => tap(`plan:${TASK_ID}:approve`, []),
    ],
  ])("answers %s from a sender the channel doesn't admit with nothing", async (_, key, ctx) => {
    const transport = strangerTransport();
    await setupWith({ token: "fake" }, transport);
    const stranger = update(ctx());

    await deliverUpdate(key, stranger);

    expect(calledMocks(stranger)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calledMocks(transport)).toEqual(["senders.admits"]);
    expect(calledMocks(mockBotApi)).toEqual(["setMyCommands"]);
    expect(transport.senders.admits).toHaveBeenCalledWith(String(STRANGER));
  });

  it("passes an admitted sender's message on to its handler", async () => {
    const transport = mockTransport({
      resolveSession: vi.fn().mockResolvedValue({
        id: "session-1",
        channelId: "tg-ch",
        platformAddress: "42",
        conversationId: "conv-1",
        status: "active",
        receive: "routed",
      }),
    });
    await setupWith({ token: "fake" }, transport);
    const known = update(makeCtx(111, "hello", 42));

    await deliverUpdate("on:message:text", known);

    expect(transport.senders.admits).toHaveBeenCalledWith("111");
    expect(known.api.sendChatAction).toHaveBeenCalledWith(42, "typing");
    expect(transport.emit).toHaveBeenCalledWith("session-1", "hello", expect.any(Date));
  });

  it("passes an admitted sender's photo on to be downloaded and uploaded", async () => {
    const transport = mockTransport();
    await setupWith({ token: "fake" }, transport);

    await deliverUpdate("on:message:photo", update(makePhotoCtx(111)));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(transport.uploadAttachment).toHaveBeenCalledOnce();
    expect(transport.emit).toHaveBeenCalledOnce();
  });

  it("passes an admitted sender's /start on to its reply", async () => {
    await setupWith({ token: "fake" });
    const start = update({ ...makeCtx(111, "/start", 42), match: "" });

    await deliverUpdate("command:start", start);

    expect(start.reply).toHaveBeenCalledOnce();
  });
});
