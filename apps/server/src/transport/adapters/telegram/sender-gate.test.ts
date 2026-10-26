import { Api, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../../logger.js";
import { senderGate } from "./sender-gate.js";

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
const sender = { id: 42, is_bot: false, first_name: "Mallory" };

const message: Update = {
  update_id: 1,
  message: {
    message_id: 1,
    date: DATE,
    chat: { id: 42, type: "private", first_name: "Mallory" },
    from: sender,
    text: "the plan",
  },
};
const tap: Update = {
  update_id: 2,
  callback_query: { id: "q", from: sender, chat_instance: "c", data: "resume:work" },
};
const channelPost: Update = {
  update_id: 3,
  channel_post: {
    message_id: 1,
    date: DATE,
    chat: { id: -100, type: "channel", title: "News" },
    text: "post",
  },
};

/** Run `update` through the gate with `admits` as the channel's answer. */
async function gate(update: Update, admits: () => Promise<boolean>) {
  const transport = { senders: { admits: vi.fn(admits) } };
  const next = vi.fn().mockResolvedValue(undefined);
  await senderGate(transport)(new Context(update, new Api("test-token"), me), next);
  return { admits: transport.senders.admits, next };
}

describe("senderGate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes an admitted sender's update on", async () => {
    const { admits, next } = await gate(message, async () => true);

    expect(admits).toHaveBeenCalledWith("42");
    expect(next).toHaveBeenCalledOnce();
  });

  it("stops a message from a sender the channel doesn't admit, logging the handle once", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    const { next } = await gate(message, async () => false);

    expect(next).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith({ handle: "42" }, expect.any(String));
  });

  it("stops a callback query from a sender the channel doesn't admit", async () => {
    const { admits, next } = await gate(tap, async () => false);

    expect(admits).toHaveBeenCalledWith("42");
    expect(next).not.toHaveBeenCalled();
  });

  it("drops an update with no sender without asking the channel", async () => {
    const { admits, next } = await gate(channelPost, async () => true);

    expect(admits).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("drops the update when the admission check throws, logging the handle and not the update", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const failure = new Error("db down");

    const { next } = await gate(message, () => Promise.reject(failure));

    expect(next).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      { handle: "42", updateId: 1, err: failure },
      expect.any(String),
    );
  });
});
