import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockAttachmentStore, mockInngest, mockTransport } from "../../../test/factories.js";
import { mockBotApi, resetGrammyMock } from "../../../test/telegram/grammy-mock.js";
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
});
