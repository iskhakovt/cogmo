import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../../db/index.js";
import type { SkillDeployRow, SkillRow, SkillStore } from "../../../skills/store/index.js";
import type { ClassifierLog, SkillEffects } from "../../../skills/types.js";
import { mockTransportStore } from "../../../test/factories.js";
import { postSkillsApprovalKeyboard } from "./skills-approval-poster.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const PENDING_ID = "019d0000-0000-7000-8000-000000000001";
const SKILL_ID = "019d0000-0000-7000-8000-0000000000ab";
const DEPLOY_ID = PENDING_ID;
const CONV_ID = "019d0000-0000-7000-8000-000000000777";

interface FakeSkillStoreOpts {
  /** The pending deploy, declaring `effects`. */
  deploy?: { id: string; skillId: string; effects: SkillEffects };
  /** The skill row, which for an upgrade is still the live version. */
  skill?: Pick<SkillRow, "id" | "effects">;
}

function classifierLog(effects: SkillEffects): ClassifierLog {
  return {
    classifier_version: "test",
    risk_tier: "approve",
    declared_effects: effects,
    detected_effects: [],
    declared_secrets: [],
    declared_dependencies: [],
    validation_errors: [],
  };
}

function makeSkillStore(opts: FakeSkillStoreOpts = {}): SkillStore {
  const store = mock<SkillStore>();
  // Spread a `mock<…Row>()` to fill the fields the poster doesn't read with
  // proxy values that satisfy the type without inventing realistic data.
  store.getDeployById.mockResolvedValue(
    opts.deploy
      ? {
          ...mock<SkillDeployRow>(),
          id: opts.deploy.id,
          skillId: opts.deploy.skillId,
          classifierLog: classifierLog(opts.deploy.effects),
        }
      : undefined,
  );
  store.getSkillById.mockResolvedValue(
    opts.skill ? { ...mock<SkillRow>(), ...opts.skill } : undefined,
  );
  return store;
}

/** Post into a Telegram session and return the text sent. */
async function postedText(args: { skillStore: SkillStore; schedule?: string }): Promise<string> {
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
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  await postSkillsApprovalKeyboard({
    event: {
      pendingId: PENDING_ID,
      skillName: "notifier",
      gitSha: "abcdef0123456789",
      conversationId: CONV_ID,
      schedule: args.schedule ?? null,
    },
    channelId: "ch-telegram",
    runInTx: fakeRunInTx,
    skillStore: args.skillStore,
    transportStore,
    sendMessage,
  });
  return String(sendMessage.mock.calls[0]?.[1]);
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
      deploy: { id: DEPLOY_ID, skillId: SKILL_ID, effects: ["sends_message", "writes_filesystem"] },
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    const result = await postSkillsApprovalKeyboard({
      event: {
        pendingId: PENDING_ID,
        skillName: "notifier",
        gitSha: "abcdef0123456789",
        conversationId: CONV_ID,
        schedule: null,
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
    expect(text).not.toContain("run as");
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
        schedule: null,
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

  it("shows an upgrade's pending effects, not the live version's", async () => {
    const skillStore = makeSkillStore({
      deploy: { id: DEPLOY_ID, skillId: SKILL_ID, effects: ["sends_message"] },
      skill: { id: SKILL_ID, effects: ["reads_memory"] },
    });

    const text = await postedText({ skillStore });

    expect(text).toContain("Declared effects: sends_message");
    expect(text).not.toContain("reads_memory");
  });

  it("says a scheduled skill will run as the approver", async () => {
    const skillStore = makeSkillStore({
      deploy: { id: DEPLOY_ID, skillId: SKILL_ID, effects: [] },
    });

    const text = await postedText({ skillStore, schedule: "0 9 * * *" });

    expect(text).toContain("Schedule: 0 9 * * *");
    expect(text).toContain("run as whoever approves");
  });

  it("falls back to '(none declared)' when the deploy is missing", async () => {
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
        schedule: null,
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
      deploy: { id: DEPLOY_ID, skillId: SKILL_ID, effects: ["sends_message"] },
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
        schedule: null,
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
      deploy: { id: DEPLOY_ID, skillId: SKILL_ID, effects: [] },
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    await postSkillsApprovalKeyboard({
      event: {
        pendingId: PENDING_ID,
        skillName: "echo",
        gitSha: "abc",
        conversationId: CONV_ID,
        schedule: null,
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
