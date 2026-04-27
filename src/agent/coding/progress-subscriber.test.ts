import { describe, expect, it, vi } from "vitest";
import { CodingProgressSubscriber, type ProgressBot } from "./progress-subscriber.js";
import { CodingStreamingRegistry } from "./streaming-registry.js";

const TASK_ID = "019d0000-0000-7000-8000-000000000001";

interface FakeBotState {
  bot: ProgressBot;
  sent: { chatId: number; text: string; replyMarkup?: unknown }[];
  edits: { chatId: number; messageId: number; text: string; replyMarkup?: unknown }[];
}

function fakeBot(): FakeBotState {
  const state: FakeBotState = { bot: undefined as unknown as ProgressBot, sent: [], edits: [] };
  state.bot = {
    sendMessage: vi.fn(async (chatId: number, text: string, opts) => {
      state.sent.push({
        chatId,
        text,
        ...(opts?.reply_markup && { replyMarkup: opts.reply_markup }),
      });
      // Telegram returns sequential numeric message ids; tests use length as a proxy.
      return { message_id: 1000 + state.sent.length };
    }),
    editMessageText: vi.fn(async (chatId: number, messageId: number, text: string, opts) => {
      state.edits.push({
        chatId,
        messageId,
        text,
        ...(opts?.reply_markup && { replyMarkup: opts.reply_markup }),
      });
      return {};
    }),
  };
  return state;
}

function start(args?: { editIntervalMs?: number }): {
  registry: CodingStreamingRegistry;
  bot: FakeBotState;
} {
  const registry = new CodingStreamingRegistry();
  const bot = fakeBot();
  CodingProgressSubscriber.start({
    taskId: TASK_ID,
    chatId: 42,
    goal: "do a thing",
    channelId: "ch-1",
    bot: bot.bot,
    registry,
    // 0 ms → no throttle, every event triggers an edit. Makes assertions
    // deterministic without needing fake timers.
    editIntervalMs: args?.editIntervalMs ?? 0,
  });
  return { registry, bot };
}

describe("CodingProgressSubscriber", () => {
  it("posts the initial message on the first event, edits subsequently", async () => {
    const { registry, bot } = start();

    registry.publish(TASK_ID, { kind: "text", delta: "Hello" });
    // Wait for the queued bot.sendMessage to flush.
    await new Promise((r) => setImmediate(r));

    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0].chatId).toBe(42);
    expect(bot.sent[0].text).toContain("🧠 Planning");
    expect(bot.sent[0].text).toContain("Hello");
    expect(bot.sent[0].replyMarkup).toBeUndefined();
    expect(bot.edits).toHaveLength(0);

    registry.publish(TASK_ID, { kind: "text", delta: " world" });
    await new Promise((r) => setImmediate(r));
    expect(bot.edits).toHaveLength(1);
    expect(bot.edits[0].text).toContain("Hello world");
  });

  it("plan_finalized attaches the inline keyboard with Approve / Revise / Cancel", async () => {
    const { registry, bot } = start();

    registry.publish(TASK_ID, { kind: "plan_finalized", plan: "## Plan\nbody" });
    await new Promise((r) => setImmediate(r));

    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0].text).toContain("Plan ready");
    expect(bot.sent[0].text).toContain("## Plan\nbody");

    const markup = bot.sent[0].replyMarkup as {
      inline_keyboard: { callback_data: string }[][];
    };
    expect(markup.inline_keyboard[0].map((b) => b.callback_data)).toEqual([
      `plan:${TASK_ID}:approve`,
      `plan:${TASK_ID}:revise`,
      `plan:${TASK_ID}:cancel`,
    ]);
  });

  it("execute_started flips phase to executing and resets the body", async () => {
    const { registry, bot } = start();
    // Plan goes through first.
    registry.publish(TASK_ID, { kind: "plan_finalized", plan: "plan body" });
    await new Promise((r) => setImmediate(r));

    registry.publish(TASK_ID, { kind: "execute_started" });
    await new Promise((r) => setImmediate(r));

    const lastEdit = bot.edits.at(-1);
    expect(lastEdit?.text).toContain("⚙️ Executing");
    expect(lastEdit?.text).not.toContain("plan body");
  });

  it("execute_complete renders pending_verify + token counter, then unsubscribes", async () => {
    const { registry, bot } = start();
    registry.publish(TASK_ID, { kind: "execute_started" });
    await new Promise((r) => setImmediate(r));
    registry.publish(TASK_ID, { kind: "text", delta: "narrating..." });
    await new Promise((r) => setImmediate(r));
    registry.publish(TASK_ID, {
      kind: "execute_complete",
      ok: true,
      tokens: { input: 100, output: 20 },
    });
    await new Promise((r) => setImmediate(r));

    const completionEdit = bot.edits.at(-1);
    expect(completionEdit?.text).toContain("✅ Done");
    expect(completionEdit?.text).toContain("120 tokens");
    expect(completionEdit?.text).toContain("in 100");
    expect(completionEdit?.text).toContain("out 20");

    // Post-completion events are ignored — listener was detached.
    const editCountAtCompletion = bot.edits.length;
    registry.publish(TASK_ID, { kind: "text", delta: "ignored" });
    await new Promise((r) => setImmediate(r));
    expect(bot.edits).toHaveLength(editCountAtCompletion);
  });

  it("failed event renders the failure reason and detaches", async () => {
    const { registry, bot } = start();
    registry.publish(TASK_ID, { kind: "text", delta: "x" });
    await new Promise((r) => setImmediate(r));

    registry.publish(TASK_ID, { kind: "failed", reason: "claude exit code 2" });
    await new Promise((r) => setImmediate(r));

    const lastEdit = bot.edits.at(-1);
    expect(lastEdit?.text).toContain("❌ Failed");
    expect(lastEdit?.text).toContain("claude exit code 2");

    const editCountAtFailure = bot.edits.length;
    registry.publish(TASK_ID, { kind: "text", delta: "ignored" });
    await new Promise((r) => setImmediate(r));
    expect(bot.edits).toHaveLength(editCountAtFailure);
  });

  it("registers the message ref so the callback handler can edit the same message", async () => {
    const { registry, bot } = start();
    registry.publish(TASK_ID, { kind: "plan_finalized", plan: "p" });
    await new Promise((r) => setImmediate(r));

    const ref = registry.getSnapshot(TASK_ID)?.progressMessageRef;
    expect(ref).toBeDefined();
    expect(ref?.channelId).toBe("ch-1");
    expect(ref?.chatId).toBe("42");
    // First sendMessage returns message_id 1001 by our fake bot's convention.
    expect(ref?.messageId).toBe(String(1000 + bot.sent.length));
  });

  it("tool_call / tool_result events update the activity line during execute", async () => {
    const { registry, bot } = start();
    registry.publish(TASK_ID, { kind: "execute_started" });
    await new Promise((r) => setImmediate(r));
    registry.publish(TASK_ID, { kind: "tool_call", tool: "Read" });
    await new Promise((r) => setImmediate(r));
    registry.publish(TASK_ID, { kind: "tool_result", tool: "Read", ok: true, summary: "ok" });
    await new Promise((r) => setImmediate(r));

    const edits = bot.edits.map((e) => e.text);
    expect(edits.some((t) => t.includes("Read…"))).toBe(true);
    expect(edits.some((t) => t.includes("Read ✓"))).toBe(true);
  });

  it("swallows 'message is not modified' edit errors silently", async () => {
    const { registry, bot } = start();
    registry.publish(TASK_ID, { kind: "text", delta: "x" });
    await new Promise((r) => setImmediate(r));

    // Make the next edit throw the benign Telegram error.
    bot.bot.editMessageText = vi.fn(async () => {
      throw new Error("Bad Request: message is not modified");
    });
    expect(() => registry.publish(TASK_ID, { kind: "text", delta: "y" })).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});
