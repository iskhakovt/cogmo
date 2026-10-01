import { matchFilter } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectDefined } from "../../../test/assertions.js";
import { commandComposer, handlers, mockBotApi, resetGrammyMock } from "./test-grammy-mock.js";
import { createAdapter, makeCtx } from "./test-harness.js";

vi.mock("grammy", async () => (await import("./test-grammy-mock.js")).grammyModule);

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

  it("/new closes session", async () => {
    const { transport } = await createAdapter();
    const ctx = makeCtx(111, "/new", 42);
    await handlers.get("command:new")!(ctx);

    expect(transport.closeSession).toHaveBeenCalledWith("session-1");
    // handleNew now surfaces the profile actually used in the reply; the
    // mocked createConversation default returns profileName "assistant".
    expect(ctx.reply.mock.calls[0]?.[0]).toBe('New conversation started with profile "assistant".');
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
