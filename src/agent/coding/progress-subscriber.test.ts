import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { expectDefined } from "../../test/assertions.js";
import { type ProgressBot, startCodingProgressSubscriber } from "./progress-subscriber.js";
import { CodingStreamingRegistry } from "./streaming-registry.js";

const InlineKeyboardSchema = z.object({
  inline_keyboard: z.array(z.array(z.object({ callback_data: z.string() }).passthrough())),
});

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
  startCodingProgressSubscriber({
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

describe("startCodingProgressSubscriber", () => {
  it("posts the initial message on the first event, edits subsequently", async () => {
    const { registry, bot } = start();

    registry.publish(TASK_ID, { kind: "text", delta: "Hello" });
    // Wait for the queued bot.sendMessage to flush.
    await new Promise((r) => setImmediate(r));

    expect(bot.sent).toHaveLength(1);
    const sent0 = expectDefined(bot.sent[0], "first send");
    expect(sent0.chatId).toBe(42);
    expect(sent0.text).toContain("🧠 Planning");
    expect(sent0.text).toContain("Hello");
    expect(sent0.replyMarkup).toBeUndefined();
    expect(bot.edits).toHaveLength(0);

    registry.publish(TASK_ID, { kind: "text", delta: " world" });
    await new Promise((r) => setImmediate(r));
    expect(bot.edits).toHaveLength(1);
    expect(expectDefined(bot.edits[0], "first edit").text).toContain("Hello world");
  });

  it("plan_finalized attaches the inline keyboard with Approve / Revise / Cancel", async () => {
    const { registry, bot } = start();

    registry.publish(TASK_ID, { kind: "plan_finalized", plan: "## Plan\nbody" });
    await new Promise((r) => setImmediate(r));

    expect(bot.sent).toHaveLength(1);
    const planSent = expectDefined(bot.sent[0], "plan sent");
    expect(planSent.text).toContain("Plan ready");
    expect(planSent.text).toContain("## Plan\nbody");

    const markup = InlineKeyboardSchema.parse(planSent.replyMarkup);
    expect(
      expectDefined(markup.inline_keyboard[0], "first keyboard row").map((b) => b.callback_data),
    ).toEqual([`plan:${TASK_ID}:approve`, `plan:${TASK_ID}:revise`, `plan:${TASK_ID}:cancel`]);
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
    expect(completionEdit?.text).toContain("Execute done");
    expect(completionEdit?.text).toContain("awaiting verify");
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

  describe("single-message-edit invariant", () => {
    it("uses the same telegram message_id across many text deltas", async () => {
      const { registry, bot } = start();

      // 20 text deltas, no throttle — every one must edit the SAME message
      // returned by the initial sendMessage. The chat must never see a
      // second post.
      for (let i = 0; i < 20; i++) {
        registry.publish(TASK_ID, { kind: "text", delta: `chunk-${i} ` });
        await new Promise((r) => setImmediate(r));
      }

      expect(bot.sent).toHaveLength(1);
      expect(bot.edits).toHaveLength(19);
      // Every edit targets the single message_id returned by sendMessage —
      // the fake bot returns 1001 for the first (and only) sendMessage call.
      const distinctEditedIds = new Set(bot.edits.map((e) => e.messageId));
      expect(distinctEditedIds.size).toBe(1);
      expect(distinctEditedIds.has(1001)).toBe(true);
    });

    it("keeps the message_id stable across plan -> execute -> complete phases", async () => {
      const { registry, bot } = start();

      // Walk the full lifecycle: planning deltas, plan_finalized,
      // execute_started, execute deltas, execute_complete. All edits must
      // target the same message_id.
      registry.publish(TASK_ID, { kind: "text", delta: "draft " });
      await new Promise((r) => setImmediate(r));
      registry.publish(TASK_ID, { kind: "text", delta: "plan body" });
      await new Promise((r) => setImmediate(r));
      registry.publish(TASK_ID, { kind: "plan_finalized", plan: "## Plan\nfinal" });
      await new Promise((r) => setImmediate(r));
      registry.publish(TASK_ID, { kind: "execute_started" });
      await new Promise((r) => setImmediate(r));
      registry.publish(TASK_ID, { kind: "tool_call", tool: "Read" });
      await new Promise((r) => setImmediate(r));
      registry.publish(TASK_ID, { kind: "tool_result", tool: "Read", ok: true });
      await new Promise((r) => setImmediate(r));
      registry.publish(TASK_ID, {
        kind: "execute_complete",
        ok: true,
        tokens: { input: 10, output: 5 },
      });
      await new Promise((r) => setImmediate(r));

      // Exactly one initial post; everything else is an in-place edit.
      expect(bot.sent).toHaveLength(1);
      expect(bot.edits.length).toBeGreaterThanOrEqual(6);

      const ids = new Set(bot.edits.map((e) => e.messageId));
      expect(ids.size).toBe(1);
      expect(ids.has(1001)).toBe(true);
    });
  });

  describe("edit throttle", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("rate-limits text-delta edits within the configured interval", async () => {
      // Fake only Date so setImmediate / microtasks still run normally.
      // The subscriber's throttle uses Date.now() comparisons; `setImmediate`
      // remains real so the queued bot.* promises drain between publishes.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(0));

      const { registry, bot } = start({ editIntervalMs: 500 });

      // First delta posts the message (initial post bypasses throttle).
      registry.publish(TASK_ID, { kind: "text", delta: "a" });
      await new Promise((r) => setImmediate(r));
      expect(bot.sent).toHaveLength(1);
      expect(bot.edits).toHaveLength(0);

      // 10 deltas in a tight burst inside the 500ms window. Throttle should
      // suppress all of them — Date.now() doesn't advance until we say so.
      for (let i = 0; i < 10; i++) {
        registry.publish(TASK_ID, { kind: "text", delta: `${i}` });
        await new Promise((r) => setImmediate(r));
      }
      expect(bot.edits).toHaveLength(0);

      // Cross the threshold; the next delta should produce one edit.
      vi.setSystemTime(new Date(600));
      registry.publish(TASK_ID, { kind: "text", delta: "after" });
      await new Promise((r) => setImmediate(r));
      expect(bot.edits).toHaveLength(1);
      expect(expectDefined(bot.edits[0], "after edit").text).toContain("after");
    });

    it("force-edits on plan_finalized even when the throttle window is open", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(0));

      const { registry, bot } = start({ editIntervalMs: 500 });

      // Initial post via a text delta.
      registry.publish(TASK_ID, { kind: "text", delta: "drafting " });
      await new Promise((r) => setImmediate(r));
      expect(bot.sent).toHaveLength(1);

      // A second text delta inside the window is throttled away.
      vi.setSystemTime(new Date(50));
      registry.publish(TASK_ID, { kind: "text", delta: "more" });
      await new Promise((r) => setImmediate(r));
      expect(bot.edits).toHaveLength(0);

      // plan_finalized arrives while the throttle window is still open.
      // Design contract: it must force-edit so the keyboard ships with the
      // final plan body, not on a later throttled tick.
      vi.setSystemTime(new Date(100));
      registry.publish(TASK_ID, { kind: "plan_finalized", plan: "## Plan\nbody" });
      await new Promise((r) => setImmediate(r));

      expect(bot.edits).toHaveLength(1);
      const planEdit = expectDefined(bot.edits[0], "plan edit");
      expect(planEdit.text).toContain("Plan ready");
      expect(planEdit.text).toContain("## Plan\nbody");
      expect(planEdit.replyMarkup).toBeDefined();
    });

    it("force-edits on terminal failed event regardless of throttle", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(0));

      const { registry, bot } = start({ editIntervalMs: 500 });

      registry.publish(TASK_ID, { kind: "text", delta: "x" });
      await new Promise((r) => setImmediate(r));
      expect(bot.sent).toHaveLength(1);

      // Failure arrives well inside the throttle window — must still edit
      // immediately so the user sees the failure reason without delay.
      vi.setSystemTime(new Date(20));
      registry.publish(TASK_ID, { kind: "failed", reason: "boom" });
      await new Promise((r) => setImmediate(r));

      expect(bot.edits).toHaveLength(1);
      const failEdit = expectDefined(bot.edits[0], "fail edit");
      expect(failEdit.text).toContain("❌ Failed");
      expect(failEdit.text).toContain("boom");
    });

    it("coalesces a burst of events fired at the same wall-clock tick", async () => {
      // The registry's `publish` calls listeners synchronously but does
      // not await the returned promise (`streaming-registry.ts:102-113`),
      // so handlers for back-to-back events can interleave. If the
      // throttle timestamp were only updated *after* the bot call
      // resolved, all three events below would see stale `lastEditAt`,
      // pass the throttle, and queue three editMessageText calls onto
      // `pending`. The synchronous update at the top of `postOrEdit`
      // pins the throttle so only the first event in the burst fires.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(0));

      const { registry, bot } = start({ editIntervalMs: 500 });

      // Initial post lands at t=0.
      registry.publish(TASK_ID, { kind: "text", delta: "a" });
      await new Promise((r) => setImmediate(r));
      expect(bot.sent).toHaveLength(1);
      expect(bot.edits).toHaveLength(0);

      // Cross the throttle window, then burst three events synchronously
      // without awaiting in between — this is what registry.publish does
      // when text deltas stream in from the orchestrator.
      vi.setSystemTime(new Date(600));
      registry.publish(TASK_ID, { kind: "text", delta: "b" });
      registry.publish(TASK_ID, { kind: "text", delta: "c" });
      registry.publish(TASK_ID, { kind: "text", delta: "d" });
      await new Promise((r) => setImmediate(r));

      expect(bot.edits).toHaveLength(1);
    });
  });
});
