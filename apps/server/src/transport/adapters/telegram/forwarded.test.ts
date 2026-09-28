import type { MessageOrigin } from "grammy/types";
import { describe, expect, it } from "vitest";
import { inboundTextBlock } from "./forwarded.js";

const DATE = 1700000000;
const SENT_AT = "2023-11-14T22:13:20.000Z";

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
