import { Api, Composer, Context } from "grammy";
import type { MessageOrigin, UserFromGetMe } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { commandComposer, inboundTextBlock, othersOrigin } from "./forwarded.js";

const DATE = 1700000000;
const SENT_AT = "2023-11-14T22:13:20.000Z";

describe("commandComposer", () => {
  const me: UserFromGetMe = {
    id: 1,
    is_bot: true,
    first_name: "Cogmo",
    username: "cogmo_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  const user = { id: 42, is_bot: false, first_name: "Timur" };

  /** Routes a `/new` message through commands on `commandComposer` and a text handler after them. */
  async function route(origin: MessageOrigin | undefined) {
    const composer = new Composer<Context>();
    const command = vi.fn();
    const text = vi.fn();
    commandComposer(composer).command("new", command);
    composer.on("message:text", text);
    const ctx = new Context(
      {
        update_id: 1,
        message: {
          message_id: 1,
          date: DATE,
          chat: { id: 42, type: "private", first_name: "Timur" },
          from: user,
          text: "/new work",
          entities: [{ type: "bot_command", offset: 0, length: 4 }],
          ...(origin !== undefined && { forward_origin: origin }),
        },
      },
      new Api("test-token"),
      me,
    );
    await composer.middleware()(ctx, () => Promise.resolve());
    return { command, text };
  }

  it("runs a command the user sent", async () => {
    const { command, text } = await route(undefined);

    expect(command).toHaveBeenCalledOnce();
    expect(text).not.toHaveBeenCalled();
  });

  it("passes a forwarded command to the text handler instead of running it", async () => {
    const { command, text } = await route({
      type: "hidden_user",
      date: DATE,
      sender_user_name: "Bob",
    });

    expect(command).not.toHaveBeenCalled();
    expect(text).toHaveBeenCalledOnce();
  });
});

describe("othersOrigin", () => {
  const SENDER = 42;

  it("drops the origin of the user's own message, forwarded back", () => {
    const own: MessageOrigin = {
      type: "user",
      date: DATE,
      sender_user: { id: SENDER, is_bot: false, first_name: "Timur" },
    };
    expect(othersOrigin(own, SENDER)).toBeUndefined();
  });

  it.each<[string, MessageOrigin]>([
    [
      "another user",
      { type: "user", date: DATE, sender_user: { id: 7, is_bot: false, first_name: "Alice" } },
    ],
    ["a hidden user", { type: "hidden_user", date: DATE, sender_user_name: "Timur" }],
    [
      "a channel",
      {
        type: "channel",
        date: DATE,
        chat: { id: SENDER, type: "channel", title: "Mine" },
        message_id: 1,
      },
    ],
  ])("keeps the origin of %s", (_label, origin) => {
    expect(othersOrigin(origin, SENDER)).toBe(origin);
  });

  it("has no origin for a message that wasn't forwarded", () => {
    expect(othersOrigin(undefined, SENDER)).toBeUndefined();
  });
});

describe("inboundTextBlock", () => {
  it("leaves text that wasn't forwarded unmarked", () => {
    expect(inboundTextBlock("hi", undefined)).toEqual({ type: "text", text: "hi" });
  });

  it.each<[string, MessageOrigin, string]>([
    [
      "a user, by full name",
      {
        type: "user",
        date: DATE,
        sender_user: { id: 1, is_bot: false, first_name: "Alice", last_name: "Smith" },
      },
      "Alice Smith",
    ],
    [
      "a user with no last name",
      { type: "user", date: DATE, sender_user: { id: 1, is_bot: false, first_name: "Alice" } },
      "Alice",
    ],
    ["a hidden user", { type: "hidden_user", date: DATE, sender_user_name: "Bob" }, "Bob"],
    [
      "a chat, with its admin's signature",
      {
        type: "chat",
        date: DATE,
        sender_chat: { id: -1, type: "supergroup", title: "Book Club" },
        author_signature: "Carol",
      },
      "Book Club (Carol)",
    ],
    [
      "a chat with no signature",
      { type: "chat", date: DATE, sender_chat: { id: -1, type: "group", title: "Book Club" } },
      "Book Club",
    ],
    [
      "a private chat, by name",
      {
        type: "chat",
        date: DATE,
        sender_chat: { id: 2, type: "private", first_name: "Erin", last_name: "Lee" },
      },
      "Erin Lee",
    ],
    [
      "a channel, with the post's signature",
      {
        type: "channel",
        date: DATE,
        chat: { id: -2, type: "channel", title: "Daily News" },
        message_id: 7,
        author_signature: "Dan",
      },
      "Daily News (Dan)",
    ],
    [
      "a channel with no signature",
      {
        type: "channel",
        date: DATE,
        chat: { id: -2, type: "channel", title: "Daily News" },
        message_id: 7,
      },
      "Daily News",
    ],
  ])("marks text forwarded from %s", (_label, origin, from) => {
    expect(inboundTextBlock("hi", origin)).toEqual({
      type: "text",
      text: "hi",
      forwarded: { origin: origin.type, from, sentAt: SENT_AT },
    });
  });
});
