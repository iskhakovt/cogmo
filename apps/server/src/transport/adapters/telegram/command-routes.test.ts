import { matchFilter } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectDefined } from "../../../test/assertions.js";
import {
  botApiError,
  commandComposer,
  handlers,
  mockBotApi,
  resetGrammyMock,
} from "../../../test/telegram/grammy-mock.js";
import {
  captureLogLines,
  createAdapter,
  createAdapterWithToken,
  makeCtx,
} from "../../../test/telegram/harness.js";

vi.mock("grammy", async () => (await import("../../../test/telegram/grammy-mock.js")).grammyModule);

describe("registerCommands", () => {
  beforeEach(() => {
    resetGrammyMock();
  });

  it("registers the bot command menu on setup", async () => {
    await createAdapter();

    expect(mockBotApi.setMyCommands).toHaveBeenCalledOnce();
    const firstCall = mockBotApi.setMyCommands.mock.calls[0];
    if (!firstCall) throw new Error("expected setMyCommands to have been called");
    const [commands] = firstCall;
    const names = (commands as Array<{ command: string; description: string }>).map(
      (c) => c.command,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "new",
        "sessions",
        "resume",
        "name",
        "end",
        "profile",
        "model",
        "repo",
        "mcp",
        "repair",
        "cancel",
        "start",
      ]),
    );
    for (const c of commands as Array<{ command: string; description: string }>) {
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  it("/start sends welcome", async () => {
    await createAdapter();
    const ctx = makeCtx(111);
    await handlers.get("command:start")!(ctx);

    expect(ctx.reply).toHaveBeenCalled();
  });

  it("/new supersedes the chat's session in one call", async () => {
    const { transport } = await createAdapter();
    const ctx = makeCtx(111, "/new", 42);
    await handlers.get("command:new")!(ctx);

    expect(transport.closeSession).not.toHaveBeenCalled();
    expect(transport.createConversation).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ supersede: true }),
    );
    // handleNew names the profile it used in the reply; the mocked createConversation default returns profileName "assistant".
    expect(ctx.reply.mock.calls[0]?.[0]).toBe('New conversation started with profile "assistant".');
  });

  describe("the command menu's warning", () => {
    /** Shaped like a Bot API token (numeric id, colon, URL-safe base64), but not one. */
    const TOKEN = "123456:AAsecret-tok_en";
    const ENCODED = encodeURIComponent(TOKEN);

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("masks the bot token, raw and percent-encoded, bare and in a URL", async () => {
      const lines = captureLogLines();
      mockBotApi.setMyCommands.mockRejectedValueOnce(
        botApiError(
          "setMyCommands",
          400,
          `Bad Request: ${TOKEN} ${ENCODED} https://bot-api.local/bot${TOKEN}/setMyCommands`,
        ),
      );

      await createAdapterWithToken(TOKEN);

      const line = lines.filter((l) => l.includes("failed to register telegram bot commands"));
      expect(line).toHaveLength(1);
      expect(line[0]).not.toContain(TOKEN);
      expect(line[0]).not.toContain(ENCODED);
      expect(line[0]).toContain("Bad Request: <redacted> <redacted>");
    });
  });

  describe("forwarded messages", () => {
    it("registers every command on the composer that drops forwarded messages", async () => {
      await createAdapter();

      expect(matchFilter).toHaveBeenCalledWith(":forward_origin");
      const registered = commandComposer.command.mock.calls.map(([cmd]) => cmd);
      const [menu] = expectDefined(mockBotApi.setMyCommands.mock.calls[0], "setMyCommands call");
      const menuCommands = (menu as Array<{ command: string }>).map((c) => c.command);
      expect(registered).toEqual(expect.arrayContaining(["start", ...menuCommands]));
    });
  });
});
