import { Bot } from "grammy";
import type { Chat, Message, Update, UserFromGetMe } from "grammy/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../../logger.js";
import { privateChatGate } from "./private-chat-gate.js";

const DATE = 1700000000;
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
const owner = { id: 42, is_bot: false, first_name: "Timur" };

const PRIVATE: Chat.PrivateChat = { id: 42, type: "private", first_name: "Timur" };
const GROUP: Chat.GroupChat = { id: -100, type: "group", title: "Friends" };
const SUPERGROUP: Chat.SupergroupChat = { id: -1001, type: "supergroup", title: "Club" };
const CHANNEL: Chat.ChannelChat = { id: -1002, type: "channel", title: "News" };

/** The owner's text message in `chat`, a private chat or a group. */
function text(chat: Update.NonChannel["chat"]): Message.TextMessage & Update.NonChannel {
  return { message_id: 1, date: DATE, chat, from: owner, text: "the plan" };
}

const channelPost: Message.TextMessage & Update.Channel = {
  message_id: 1,
  date: DATE,
  chat: CHANNEL,
  text: "the news",
};

function tapOn(chat: Update.NonChannel["chat"]): Update {
  return {
    update_id: 1,
    callback_query: {
      id: "q",
      from: owner,
      chat_instance: "c",
      data: "resume:work",
      message: text(chat),
    },
  };
}

/** Run `update` through a real bot with the gate ahead of a handler for every update. */
async function handle(update: Update) {
  const bot = new Bot("test-token", { botInfo: me });
  const handler = vi.fn();
  bot.use(privateChatGate());
  bot.use(handler);
  await bot.handleUpdate(update);
  return handler;
}

describe("privateChatGate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each<[string, Update]>([
    ["a message", { update_id: 1, message: text(PRIVATE) }],
    ["an edited message", { update_id: 1, edited_message: { ...text(PRIVATE), edit_date: DATE } }],
    ["a callback query", tapOn(PRIVATE)],
  ])("passes %s from a private chat on", async (_, update) => {
    const handler = await handle(update);

    expect(handler).toHaveBeenCalledOnce();
  });

  it.each<[string, Update]>([
    ["a group message", { update_id: 1, message: text(GROUP) }],
    ["a supergroup message", { update_id: 1, message: text(SUPERGROUP) }],
    ["a channel post", { update_id: 1, channel_post: channelPost }],
    [
      "an edited group message",
      { update_id: 1, edited_message: { ...text(GROUP), edit_date: DATE } },
    ],
    ["a tap in a group", tapOn(GROUP)],
    ["a tap in a supergroup", tapOn(SUPERGROUP)],
  ])("drops %s", async (_, update) => {
    const handler = await handle(update);

    expect(handler).not.toHaveBeenCalled();
  });

  it("drops an update with no chat", async () => {
    const handler = await handle({
      update_id: 1,
      callback_query: { id: "q", from: owner, chat_instance: "c", inline_message_id: "i" },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("logs a dropped update once at info, with the chat's id and type", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    await handle({ update_id: 7, message: text(SUPERGROUP) });

    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      { updateId: 7, chatId: -1001, chatType: "supergroup" },
      expect.any(String),
    );
  });
});
