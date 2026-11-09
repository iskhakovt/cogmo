import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../../db/index.js";
import type { SkillsDeployOutcomeData } from "../../../inngest/events.js";
import { mockTransportStore } from "../../../test/factories.js";
import { postSkillsDeployOutcome } from "./skills-deploy-outcome-poster.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const DEPLOY_ID = "019d0000-0000-7000-8000-000000000001";
const SKILL_ID = "019d0000-0000-7000-8000-0000000000ab";
const CONV_ID = "019d0000-0000-7000-8000-000000000777";

type Deployed = Extract<SkillsDeployOutcomeData, { outcome: "live" | "pending_approval" }>;

/** A first deploy of `briefing` declaring nothing beyond its description. */
function deployed(
  outcome: Deployed["outcome"],
  overrides: Partial<Omit<Deployed, "outcome">> = {},
): SkillsDeployOutcomeData {
  return {
    outcome,
    conversationId: CONV_ID,
    skillId: SKILL_ID,
    deployId: DEPLOY_ID,
    skillName: "briefing",
    riskTier: outcome === "live" ? "notify" : "approve",
    reasons: [],
    gitSha: "def5678def5678def5678",
    priorGitSha: null,
    description: "Posts the morning briefing.",
    effects: { declared: [], detected: [] },
    hosts: [],
    secrets: [],
    dependencies: [],
    schedule: null,
    ...overrides,
  };
}

/** Every fact a deploy can carry. */
const FULL_FACTS = {
  reasons: ["acting_effect", "secrets_with_network"],
  effects: { declared: ["sends_message"], detected: ["reads_memory"] },
  hosts: ["api.example.com", "*.cdn.example.com"],
  secrets: [
    { name: "api_key", bound: true },
    { name: "legacy_token", bound: false },
  ],
  dependencies: ["httpx==0.27.0"],
  schedule: "0 9 * * *",
} satisfies Partial<Deployed>;

function telegramSessionStore() {
  return mockTransportStore({
    getActiveSessionsForConversation: vi.fn().mockResolvedValue([
      {
        id: "session-other-tg",
        channelId: "ch-telegram-other",
        platformAddress: "111",
        conversationId: CONV_ID,
      },
      {
        id: "session-tg",
        channelId: "ch-telegram",
        platformAddress: "424242",
        conversationId: CONV_ID,
      },
    ]),
  });
}

/** The text the poster sends this channel's session for `event`. */
async function textOf(event: SkillsDeployOutcomeData): Promise<string> {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  await postSkillsDeployOutcome({
    event,
    channelId: "ch-telegram",
    runInTx: fakeRunInTx,
    transportStore: telegramSessionStore(),
    sendMessage,
  });
  const [call] = sendMessage.mock.calls;
  if (!call) throw new Error("nothing was sent");
  const [, text] = call;
  if (typeof text !== "string") throw new Error("the message text is not a string");
  return text;
}

describe("the message text", () => {
  it("live, first deploy: headline, description and every fact", async () => {
    expect(await textOf(deployed("live", FULL_FACTS))).toBe(
      [
        "✅ Skill briefing is live",
        "Posts the morning briefing.",
        "",
        "Why notify: an acting effect (write, send, delete, financial or subprocess); a secret together with network access",
        "Effects: declared sends_message; detected reads_memory",
        "Hosts: api.example.com, *.cdn.example.com",
        "Secrets: api_key (bound), legacy_token (raw)",
        "Dependencies: httpx==0.27.0",
        "Schedule: 0 9 * * * — runs as whoever registered it",
      ].join("\n"),
    );
  });

  it("live, update: names both shas", async () => {
    const text = await textOf(deployed("live", { priorGitSha: "abc1234abc1234" }));
    expect(text.split("\n")[0]).toBe("✅ Skill briefing updated abc1234 → def5678");
  });

  it("live, re-register of the live sha: reads as live, not as an update", async () => {
    const text = await textOf(deployed("live", { priorGitSha: "def5678def5678def5678" }));
    expect(text.split("\n")[0]).toBe("✅ Skill briefing is live");
  });

  it("live with nothing declared: leaves the empty sections out", async () => {
    expect(await textOf(deployed("live"))).toBe(
      ["✅ Skill briefing is live", "Posts the morning briefing.", "", "Effects: none"].join("\n"),
    );
  });

  it("live: an effect only one side has reads none on the other", async () => {
    const text = await textOf(
      deployed("live", { effects: { declared: [], detected: ["reads_memory"] } }),
    );
    expect(text).toContain("Effects: declared none; detected reads_memory");
  });

  it("pending: headline, facts, commit and what each button does", async () => {
    expect(
      await textOf(deployed("pending_approval", { ...FULL_FACTS, priorGitSha: "abc1234ff" })),
    ).toBe(
      [
        "🛡️ Skill deploy awaiting approval: briefing",
        "Posts the morning briefing.",
        "",
        "Why approve: an acting effect (write, send, delete, financial or subprocess); a secret together with network access",
        "Effects: declared sends_message; detected reads_memory",
        "Hosts: api.example.com, *.cdn.example.com",
        "Secrets: api_key (bound), legacy_token (raw)",
        "Dependencies: httpx==0.27.0",
        "Schedule: 0 9 * * * — runs as whoever approves it",
        "Commit: def5678, replacing abc1234",
        "",
        "Approve puts it live. Deny resolves this deploy as denied; a changed version needs a new register.",
      ].join("\n"),
    );
  });

  it("pending, first deploy: the commit alone", async () => {
    expect(await textOf(deployed("pending_approval"))).toContain("\nCommit: def5678\n");
  });

  it("rejected: the skill's name and each error on its own line", async () => {
    expect(
      await textOf({
        outcome: "rejected",
        conversationId: CONV_ID,
        skillName: "briefing",
        gitSha: "def5678def5678",
        errors: ['inputs.type: expected literal "object"', "undeclared effect: sends_message"],
      }),
    ).toBe(
      [
        "❌ Skill register rejected: briefing",
        'inputs.type: expected literal "object"',
        "undeclared effect: sends_message",
      ].join("\n"),
    );
  });

  it("rejected before the manifest was read: the branch's sha stands in for the name", async () => {
    const text = await textOf({
      outcome: "rejected",
      conversationId: CONV_ID,
      skillName: "",
      gitSha: "def5678def5678",
      errors: ["missing_skill_md: SKILL.md not found at branch tip"],
    });
    expect(text.split("\n")[0]).toBe("❌ Skill register rejected: def5678");
  });

  it("rejected with no sha either: says the branch is unknown", async () => {
    const text = await textOf({
      outcome: "rejected",
      conversationId: CONV_ID,
      skillName: "",
      gitSha: "",
      errors: ["branch_not_found: skill/x"],
    });
    expect(text.split("\n")[0]).toBe("❌ Skill register rejected: unknown branch");
  });
});

describe("postSkillsDeployOutcome", () => {
  it("live: posts to this channel's session with a Disable button", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    const result = await postSkillsDeployOutcome({
      event: deployed("live"),
      channelId: "ch-telegram",
      runInTx: fakeRunInTx,
      transportStore: telegramSessionStore(),
      sendMessage,
    });

    expect(result).toEqual({ posted: true });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      424242,
      expect.stringContaining("✅ Skill briefing is live"),
      {
        reply_markup: {
          inline_keyboard: [[{ text: "🚫 Disable", callback_data: `skill:${SKILL_ID}:disable` }]],
        },
      },
    );
  });

  it("live edit: adds Roll back keyed by the deploy id", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await postSkillsDeployOutcome({
      event: deployed("live", { priorGitSha: "abc1234abc1234" }),
      channelId: "ch-telegram",
      runInTx: fakeRunInTx,
      transportStore: telegramSessionStore(),
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledWith(424242, expect.any(String), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🚫 Disable", callback_data: `skill:${SKILL_ID}:disable` },
            { text: "↩️ Roll back", callback_data: `skill:${DEPLOY_ID}:rollback` },
          ],
        ],
      },
    });
  });

  it("live at the version it replaced: says it is live, with Disable alone", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await postSkillsDeployOutcome({
      // The default deploy's own sha.
      event: deployed("live", { priorGitSha: "def5678def5678def5678" }),
      channelId: "ch-telegram",
      runInTx: fakeRunInTx,
      transportStore: telegramSessionStore(),
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      424242,
      expect.stringMatching(/^✅ Skill briefing is live\n/),
      {
        reply_markup: {
          inline_keyboard: [[{ text: "🚫 Disable", callback_data: `skill:${SKILL_ID}:disable` }]],
        },
      },
    );
  });

  it("pending: posts Approve / Deny keyed by the deploy id", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    await postSkillsDeployOutcome({
      event: deployed("pending_approval"),
      channelId: "ch-telegram",
      runInTx: fakeRunInTx,
      transportStore: telegramSessionStore(),
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledWith(424242, expect.any(String), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `skill:${DEPLOY_ID}:approve` },
            { text: "❌ Deny", callback_data: `skill:${DEPLOY_ID}:deny` },
          ],
        ],
      },
    });
  });

  it("rejected: posts with no keyboard", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    await postSkillsDeployOutcome({
      event: {
        outcome: "rejected",
        conversationId: CONV_ID,
        skillName: "briefing",
        gitSha: "def5678",
        errors: ["bad"],
      },
      channelId: "ch-telegram",
      runInTx: fakeRunInTx,
      transportStore: telegramSessionStore(),
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledWith(424242, expect.stringContaining("rejected"), {});
  });

  it("skips when no Telegram session exists for the conversation", async () => {
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
    const sendMessage = vi.fn();

    const result = await postSkillsDeployOutcome({
      event: deployed("live"),
      channelId: "ch-telegram",
      runInTx: fakeRunInTx,
      transportStore,
      sendMessage,
    });

    expect(result).toEqual({ posted: false, reason: "no_telegram_session" });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("returns send_failed when bot.sendMessage throws (closed chat / blocked bot)", async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValue(new Error("Forbidden: bot was blocked by the user"));

    const result = await postSkillsDeployOutcome({
      event: deployed("pending_approval"),
      channelId: "ch-telegram",
      runInTx: fakeRunInTx,
      transportStore: telegramSessionStore(),
      sendMessage,
    });

    expect(result).toEqual({ posted: false, reason: "send_failed" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
