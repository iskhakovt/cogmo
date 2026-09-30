import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { expectDefined } from "../../test/assertions.js";
import type { ExecuteStreamHandle, PlanStreamHandle } from "./progress-stream.js";
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

const registries: CodingStreamingRegistry[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
});

/** The orchestrators' handles for the subscribed task, and the bot it renders to. */
function start(args?: { editIntervalMs?: number }): {
  plan: PlanStreamHandle;
  execute: ExecuteStreamHandle;
  bot: FakeBotState;
} {
  const registry = CodingStreamingRegistry.create({
    endedTasks: async () => new Set(),
    sweepIntervalMs: 60_000,
  });
  registries.push(registry);
  const bot = fakeBot();
  startCodingProgressSubscriber({
    taskId: TASK_ID,
    chatId: 42,
    goal: "do a thing",
    bot: bot.bot,
    registry,
    // 0 ms → no throttle, every event triggers an edit. Makes assertions
    // deterministic without needing fake timers.
    editIntervalMs: args?.editIntervalMs ?? 0,
  });
  return {
    plan: registry.planStream(TASK_ID),
    execute: registry.executeStream(TASK_ID),
    bot,
  };
}

/** Let the bot calls a publish queued run. */
function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

describe("startCodingProgressSubscriber", () => {
  it("posts the initial message on the first event, edits subsequently", async () => {
    const { plan, bot } = start();

    await plan.appendText("Hello");
    await tick();

    expect(bot.sent).toHaveLength(1);
    const sent0 = expectDefined(bot.sent[0], "first send");
    expect(sent0.chatId).toBe(42);
    expect(sent0.text).toContain("🧠 Planning");
    expect(sent0.text).toContain("Hello");
    expect(sent0.replyMarkup).toBeUndefined();
    expect(bot.edits).toHaveLength(0);

    await plan.appendText(" world");
    await tick();
    expect(bot.edits).toHaveLength(1);
    expect(expectDefined(bot.edits[0], "first edit").text).toContain("Hello world");
  });

  it("plan_finalized attaches the inline keyboard with Approve / Revise / Cancel", async () => {
    const { plan, bot } = start();

    await plan.finalize("## Plan\nbody");
    await tick();

    expect(bot.sent).toHaveLength(1);
    const planSent = expectDefined(bot.sent[0], "plan sent");
    expect(planSent.text).toContain("Plan ready");
    expect(planSent.text).toContain("## Plan\nbody");

    const markup = InlineKeyboardSchema.parse(planSent.replyMarkup);
    expect(
      expectDefined(markup.inline_keyboard[0], "first keyboard row").map((b) => b.callback_data),
    ).toEqual([`plan:${TASK_ID}:approve`, `plan:${TASK_ID}:revise`, `plan:${TASK_ID}:cancel`]);
  });

  it("plan_finalized with autoApproved:true omits the inline keyboard", async () => {
    // Suppression contract: when the plan orchestrator's autoapprove
    // path is about to fire, the keyboard would either be misleading
    // (Approve no-ops against an already-approved plan) or
    // action-at-a-distance (a stray Cancel tap mid-execute). The
    // subscriber renders the body text but no reply_markup, leaving
    // execute_started to take over the message.
    const { plan, bot } = start();

    await plan.finalize("## Plan\nbody", { autoApproved: true });
    await tick();

    expect(bot.sent).toHaveLength(1);
    const planSent = expectDefined(bot.sent[0], "plan sent");
    expect(planSent.text).toContain("## Plan\nbody");
    expect(planSent.replyMarkup).toBeUndefined();
  });

  it("execute_started flips phase to executing and resets the body", async () => {
    const { plan, execute, bot } = start();
    await plan.finalize("plan body");
    await tick();

    await execute.started();
    await tick();

    const lastEdit = bot.edits.at(-1);
    expect(lastEdit?.text).toContain("⚙️ Executing");
    expect(lastEdit?.text).not.toContain("plan body");
  });

  it("execute_complete renders pending_verify + token counter, and ends the stream", async () => {
    const { execute, bot } = start();
    await execute.started();
    await tick();
    await execute.appendText("narrating...");
    await tick();
    await execute.complete(true, { input: 100, output: 20 });
    await tick();

    const completionEdit = bot.edits.at(-1);
    expect(completionEdit?.text).toContain("Execute done");
    expect(completionEdit?.text).toContain("awaiting verify");
    expect(completionEdit?.text).toContain("120 tokens");
    expect(completionEdit?.text).toContain("in 100");
    expect(completionEdit?.text).toContain("out 20");

    // The stream has ended, so a late publish reaches nothing.
    const editCountAtCompletion = bot.edits.length;
    await execute.appendText("late narration");
    await tick();
    expect(bot.edits).toHaveLength(editCountAtCompletion);
  });

  it("failed event renders the failure reason and ends the stream", async () => {
    const { plan, bot } = start();
    await plan.appendText("x");
    await tick();

    await plan.fail("claude exit code 2");
    await tick();

    const lastEdit = bot.edits.at(-1);
    expect(lastEdit?.text).toContain("❌ Failed");
    expect(lastEdit?.text).toContain("claude exit code 2");

    const editCountAtFailure = bot.edits.length;
    await plan.appendText("ignored");
    await tick();
    expect(bot.edits).toHaveLength(editCountAtFailure);
  });

  it("an execute failure renders its reason", async () => {
    // The execute orchestrator reports a failed CLI or push as
    // `complete(false)` and then, back to back, `fail(reason)`.
    const { execute, bot } = start();
    await execute.started();
    await tick();

    await execute.complete(false);
    await execute.fail("claude exit code 1");
    await tick();

    const lastEdit = bot.edits.at(-1);
    expect(lastEdit?.text).toContain("❌ Failed");
    expect(lastEdit?.text).toContain("claude exit code 1");
  });

  it("tool_call / tool_result events update the activity line during execute", async () => {
    const { execute, bot } = start();
    await execute.started();
    await tick();
    await execute.toolCall("Read");
    await tick();
    await execute.toolResult("Read", true, "ok");
    await tick();

    const edits = bot.edits.map((e) => e.text);
    expect(edits.some((t) => t.includes("Read…"))).toBe(true);
    expect(edits.some((t) => t.includes("Read ✓"))).toBe(true);
  });

  it("swallows 'message is not modified' edit errors silently", async () => {
    const { plan, bot } = start();
    await plan.appendText("x");
    await tick();

    // Make the next edit throw the benign Telegram error.
    bot.bot.editMessageText = vi.fn(async () => {
      throw new Error("Bad Request: message is not modified");
    });
    await expect(plan.appendText("y")).resolves.toBeUndefined();
    await tick();
  });

  describe("single-message-edit invariant", () => {
    it("uses the same telegram message_id across many text deltas", async () => {
      const { plan, bot } = start();

      // 20 text deltas, no throttle — every one must edit the SAME message
      // returned by the initial sendMessage. The chat must never see a
      // second post.
      for (let i = 0; i < 20; i++) {
        await plan.appendText(`chunk-${i} `);
        await tick();
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
      const { plan, execute, bot } = start();

      // Walk the full lifecycle: planning deltas, plan_finalized,
      // execute_started, execute deltas, execute_complete. All edits must
      // target the same message_id.
      await plan.appendText("draft ");
      await tick();
      await plan.appendText("plan body");
      await tick();
      await plan.finalize("## Plan\nfinal");
      await tick();
      await execute.started();
      await tick();
      await execute.toolCall("Read");
      await tick();
      await execute.toolResult("Read", true);
      await tick();
      await execute.complete(true, { input: 10, output: 5 });
      await tick();

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

      const { plan, bot } = start({ editIntervalMs: 500 });

      // First delta posts the message (initial post bypasses throttle).
      await plan.appendText("a");
      await tick();
      expect(bot.sent).toHaveLength(1);
      expect(bot.edits).toHaveLength(0);

      // 10 deltas in a tight burst inside the 500ms window. Throttle should
      // suppress all of them — Date.now() doesn't advance until we say so.
      for (let i = 0; i < 10; i++) {
        await plan.appendText(`${i}`);
        await tick();
      }
      expect(bot.edits).toHaveLength(0);

      // Cross the threshold; the next delta should produce one edit.
      vi.setSystemTime(new Date(600));
      await plan.appendText("after");
      await tick();
      expect(bot.edits).toHaveLength(1);
      expect(expectDefined(bot.edits[0], "after edit").text).toContain("after");
    });

    it("force-edits on plan_finalized even when the throttle window is open", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(0));

      const { plan, bot } = start({ editIntervalMs: 500 });

      // Initial post via a text delta.
      await plan.appendText("drafting ");
      await tick();
      expect(bot.sent).toHaveLength(1);

      // A second text delta inside the window is throttled away.
      vi.setSystemTime(new Date(50));
      await plan.appendText("more");
      await tick();
      expect(bot.edits).toHaveLength(0);

      // plan_finalized arrives while the throttle window is still open.
      // Design contract: it must force-edit so the keyboard ships with the
      // final plan body, not on a later throttled tick.
      vi.setSystemTime(new Date(100));
      await plan.finalize("## Plan\nbody");
      await tick();

      expect(bot.edits).toHaveLength(1);
      const planEdit = expectDefined(bot.edits[0], "plan edit");
      expect(planEdit.text).toContain("Plan ready");
      expect(planEdit.text).toContain("## Plan\nbody");
      expect(planEdit.replyMarkup).toBeDefined();
    });

    it("force-edits on terminal failed event regardless of throttle", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(0));

      const { plan, bot } = start({ editIntervalMs: 500 });

      await plan.appendText("x");
      await tick();
      expect(bot.sent).toHaveLength(1);

      // Failure arrives well inside the throttle window — must still edit
      // immediately so the user sees the failure reason without delay.
      vi.setSystemTime(new Date(20));
      await plan.fail("boom");
      await tick();

      expect(bot.edits).toHaveLength(1);
      const failEdit = expectDefined(bot.edits[0], "fail edit");
      expect(failEdit.text).toContain("❌ Failed");
      expect(failEdit.text).toContain("boom");
    });

    it("coalesces a burst of events fired at the same wall-clock tick", async () => {
      // The registry calls listeners synchronously but does not await the
      // returned promise, so handlers for back-to-back events can
      // interleave. If the throttle timestamp were only updated *after*
      // the bot call resolved, all three events below would see stale
      // `lastEditAt`, pass the throttle, and queue three editMessageText
      // calls onto `pending`. The synchronous update at the top of
      // `postOrEdit` pins the throttle so only the first event in the
      // burst fires.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(0));

      const { plan, bot } = start({ editIntervalMs: 500 });

      // Initial post lands at t=0.
      await plan.appendText("a");
      await tick();
      expect(bot.sent).toHaveLength(1);
      expect(bot.edits).toHaveLength(0);

      // Cross the throttle window, then burst three events synchronously —
      // each handle call publishes before it returns.
      vi.setSystemTime(new Date(600));
      void plan.appendText("b");
      void plan.appendText("c");
      void plan.appendText("d");
      await tick();

      expect(bot.edits).toHaveLength(1);
    });
  });
});
