import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../../db/index.js";
import type { SkillStore } from "../../../skills/store/index.js";
import { mockTransportStore } from "../../../test/factories.js";
import { postSkillsApprovalKeyboard } from "./skills-approval-poster.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const PENDING_ID = "019d0000-0000-7000-8000-000000000001";
const SKILL_ID = "019d0000-0000-7000-8000-0000000000ab";
const DEPLOY_ID = PENDING_ID;
const CONV_ID = "019d0000-0000-7000-8000-000000000777";

interface FakeSkillStoreOpts {
  deploy?: { id: string; skillId: string };
  skill?: { id: string; effects: string[] };
}

function makeSkillStore(opts: FakeSkillStoreOpts = {}): SkillStore {
  const store = mock<SkillStore>();
  store.getDeployById.mockResolvedValue(
    // biome-ignore lint/suspicious/noExplicitAny: test fixture — the poster only reads {id, skillId}
    opts.deploy === undefined ? null : ({ ...opts.deploy } as any),
  );
  store.getSkillById.mockResolvedValue(
    // biome-ignore lint/suspicious/noExplicitAny: test fixture — the poster only reads {id, effects}
    opts.skill === undefined ? null : ({ ...opts.skill } as any),
  );
  return store;
}

describe("postSkillsApprovalKeyboard", () => {
  it("happy path: posts keyboard with skill summary + declared effects", async () => {
    const transportStore = mockTransportStore({
      getActiveSessionsForConversation: vi.fn().mockResolvedValue([
        {
          id: "session-tg",
          channelId: "ch-telegram",
          platformAddress: "424242",
          conversationId: CONV_ID,
        },
      ]),
    });
    const skillStore = makeSkillStore({
      deploy: { id: DEPLOY_ID, skillId: SKILL_ID },
      skill: { id: SKILL_ID, effects: ["sends_message", "writes_filesystem"] },
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    const result = await postSkillsApprovalKeyboard({
      event: {
        pendingId: PENDING_ID,
        skillName: "notifier",
        gitSha: "abcdef0123456789",
        conversationId: CONV_ID,
      },
      channelId: "ch-telegram",
      runInTx: fakeRunInTx,
      skillStore,
      transportStore,
      sendMessage,
    });

    expect(result).toEqual({ posted: true });
    expect(sendMessage).toHaveBeenCalledTimes(1);

    const [chatId, text, opts] = sendMessage.mock.calls[0] ?? [];
    expect(chatId).toBe(424242);
    expect(text).toContain("notifier");
    expect(text).toContain("sends_message, writes_filesystem");
    expect(text).toContain("abcdef0"); // 7-char short sha
    expect(opts.reply_markup.inline_keyboard).toHaveLength(1);
    expect(opts.reply_markup.inline_keyboard[0]).toHaveLength(2);
    expect(opts.reply_markup.inline_keyboard[0][0].callback_data).toBe(
      `skill:${PENDING_ID}:approve`,
    );
    expect(opts.reply_markup.inline_keyboard[0][1].callback_data).toBe(`skill:${PENDING_ID}:deny`);
  });

  it("skips when no Telegram session exists for the originating conversation", async () => {
    const transportStore = mockTransportStore({
      getActiveSessionsForConversation: vi.fn().mockResolvedValue([
        // A direct-channel session, but no telegram one.
        {
          id: "session-direct",
          channelId: "ch-direct",
          platformAddress: "addr",
          conversationId: CONV_ID,
        },
      ]),
    });
    const skillStore = makeSkillStore();
    const sendMessage = vi.fn();

    const result = await postSkillsApprovalKeyboard({
      event: {
        pendingId: PENDING_ID,
        skillName: "notifier",
        gitSha: "abc",
        conversationId: CONV_ID,
      },
      channelId: "ch-telegram",
      runInTx: fakeRunInTx,
      skillStore,
      transportStore,
      sendMessage,
    });

    expect(result).toEqual({ posted: false, reason: "no_telegram_session" });
    expect(sendMessage).not.toHaveBeenCalled();
    // No DB lookups when there's no session to post into.
    expect(skillStore.getDeployById).not.toHaveBeenCalled();
  });

  it("falls back to '(none declared)' when the deploy is missing or the skill has no effects", async () => {
    const transportStore = mockTransportStore({
      getActiveSessionsForConversation: vi.fn().mockResolvedValue([
        {
          id: "session-tg",
          channelId: "ch-telegram",
          platformAddress: "424242",
          conversationId: CONV_ID,
        },
      ]),
    });
    // Deploy lookup returns null — skill lookup is skipped.
    const skillStore = makeSkillStore({});
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    const result = await postSkillsApprovalKeyboard({
      event: {
        pendingId: PENDING_ID,
        skillName: "echo",
        gitSha: "0123456",
        conversationId: CONV_ID,
      },
      channelId: "ch-telegram",
      runInTx: fakeRunInTx,
      skillStore,
      transportStore,
      sendMessage,
    });

    expect(result).toEqual({ posted: true });
    const [, text] = sendMessage.mock.calls[0] ?? [];
    expect(text).toContain("(none declared)");
  });

  it("returns send_failed and logs when bot.sendMessage throws (closed chat / blocked bot)", async () => {
    const transportStore = mockTransportStore({
      getActiveSessionsForConversation: vi.fn().mockResolvedValue([
        {
          id: "session-tg",
          channelId: "ch-telegram",
          platformAddress: "424242",
          conversationId: CONV_ID,
        },
      ]),
    });
    const skillStore = makeSkillStore({
      deploy: { id: DEPLOY_ID, skillId: SKILL_ID },
      skill: { id: SKILL_ID, effects: ["sends_message"] },
    });
    const sendMessage = vi
      .fn()
      .mockRejectedValue(new Error("Forbidden: bot was blocked by the user"));

    const result = await postSkillsApprovalKeyboard({
      event: {
        pendingId: PENDING_ID,
        skillName: "notifier",
        gitSha: "abc",
        conversationId: CONV_ID,
      },
      channelId: "ch-telegram",
      runInTx: fakeRunInTx,
      skillStore,
      transportStore,
      sendMessage,
    });

    expect(result).toEqual({ posted: false, reason: "send_failed" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("filters by channelId — ignores sessions from other channels", async () => {
    const transportStore = mockTransportStore({
      getActiveSessionsForConversation: vi.fn().mockResolvedValue([
        {
          id: "session-other-tg",
          channelId: "ch-telegram-other",
          platformAddress: "111",
          conversationId: CONV_ID,
        },
        {
          id: "session-mine",
          channelId: "ch-telegram",
          platformAddress: "424242",
          conversationId: CONV_ID,
        },
      ]),
    });
    const skillStore = makeSkillStore({
      deploy: { id: DEPLOY_ID, skillId: SKILL_ID },
      skill: { id: SKILL_ID, effects: [] },
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    await postSkillsApprovalKeyboard({
      event: {
        pendingId: PENDING_ID,
        skillName: "echo",
        gitSha: "abc",
        conversationId: CONV_ID,
      },
      channelId: "ch-telegram",
      runInTx: fakeRunInTx,
      skillStore,
      transportStore,
      sendMessage,
    });

    // Posted to the matching channel's session, not the other one.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toBe(424242);
  });
});
