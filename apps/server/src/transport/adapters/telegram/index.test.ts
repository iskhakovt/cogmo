import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockAttachmentStore, mockInngest, mockTransport } from "../../../test/factories.js";
import {
  botLifecycle,
  mockBotApi,
  resetGrammyMock,
  runUpdate,
} from "../../../test/telegram/grammy-mock.js";
import { setup } from "./index.js";

vi.mock("grammy", async () => (await import("../../../test/telegram/grammy-mock.js")).grammyModule);

function setupWith(credentials: Parameters<typeof setup>[0]["credentials"]) {
  return setup({
    channelId: "tg-ch",
    credentials,
    transport: mockTransport(),
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
  // wraps every handler; commands go ahead of the message handlers, so a
  // `/new` never also reaches `message:text`; polling starts last.
  it("registers the bot's middleware in dispatch order", async () => {
    await setupWith({ token: "fake" });

    const order = botLifecycle.registrations;
    expect(order[0]).toBe("use");
    expect(order.at(-1)).toBe("start");
    const drop = order.indexOf("drop");
    const text = order.indexOf("on:message:text");
    expect(drop).toBeGreaterThan(0);
    expect(text).toBeGreaterThan(drop);
    expect(order.lastIndexOf("callbackQuery")).toBeLessThan(text);
  });

  it("counts an update whose handler throws as handled", async () => {
    botLifecycle.polling = () =>
      runUpdate(5, async () => {
        throw new Error("handler failed");
      }).catch(() => {});
    const { adapter } = await setupWith({ token: "fake" });

    await adapter.stop();

    expect(mockBotApi.getUpdates).toHaveBeenCalledWith({ offset: 6, limit: 1, timeout: 0 });
  });
});
