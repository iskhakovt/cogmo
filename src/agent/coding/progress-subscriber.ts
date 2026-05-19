import { logger } from "../../logger.js";
import { buildPlanKeyboard, type PlanInlineKeyboardMarkup } from "./plan-keyboard.js";
import {
  describeToolCall,
  describeToolResult,
  formatProgressMessage,
  type ProgressFormatInput,
  type ProgressPhase,
  type ProgressTokenCounter,
} from "./progress-format.js";
import type { CodingStreamingRegistry } from "./streaming-registry.js";

const log = logger.child({ component: "coding.progress-subscriber" });

/**
 * Minimal Telegram bot surface the subscriber needs. Typed locally so
 * tests can stub it without pulling in grammY's full Bot type.
 */
export interface ProgressBot {
  sendMessage(
    chatId: number,
    text: string,
    options?: { reply_markup?: PlanInlineKeyboardMarkup },
  ): Promise<{ message_id: number }>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options?: { reply_markup?: PlanInlineKeyboardMarkup },
  ): Promise<unknown>;
}

export interface SubscriberArgs {
  taskId: string;
  chatId: number;
  goal: string;
  channelId: string;
  bot: ProgressBot;
  registry: CodingStreamingRegistry;
  /** ms between throttled in-place edits during streaming. */
  editIntervalMs?: number;
}

/**
 * Per-task subscriber that owns the lifecycle of one Telegram message:
 * post once, edit in place as plan + execute events arrive, attach the
 * inline keyboard when the plan finalises, render the final state on
 * complete / fail.
 *
 * Single-process by design — a process restart loses the in-memory
 * subscriber. The orchestrator keeps running (Inngest-durable) and the
 * eventual completion writes are visible in DB; the user just won't see
 * the live stream until reconnect logic lands in a later slice.
 */
export function startCodingProgressSubscriber(args: SubscriberArgs): () => void {
  const { taskId, chatId, goal, channelId, bot, registry } = args;
  const editIntervalMs = args.editIntervalMs ?? 500;

  const state: ProgressFormatInput = { goal, phase: "planning", body: "" };
  let messageId: number | null = null;
  // Sentinel — the first event sees an effectively infinite gap and
  // always passes the throttle, so no `messageId === null` bypass is
  // needed in `maybeEdit`.
  let lastEditAt = Number.NEGATIVE_INFINITY;
  // Serialize bot calls so concurrent in-flight edits can't race the
  // sendMessage that creates the initial message id.
  let pending: Promise<void> = Promise.resolve();

  async function postOrEdit(replyMarkup?: PlanInlineKeyboardMarkup): Promise<void> {
    // Update synchronously before awaiting the bot call. Registry.publish
    // doesn't await listener promises, so handlers for back-to-back events
    // interleave; the next handler's throttle check must see this bump or
    // it reads a stale timestamp and queues a redundant edit.
    lastEditAt = Date.now();
    const text = formatProgressMessage(state);
    const opts = replyMarkup ? { reply_markup: replyMarkup } : undefined;
    pending = pending.then(async () => {
      try {
        if (messageId === null) {
          const sent = await bot.sendMessage(chatId, text, opts);
          messageId = sent.message_id;
          registry.setProgressMessageRef(taskId, {
            channelId,
            chatId: String(chatId),
            messageId: String(sent.message_id),
          });
        } else {
          await bot.editMessageText(chatId, messageId, text, opts);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "";
        // Telegram returns 400 on no-op edits; benign.
        if (msg.includes("message is not modified")) return;
        log.warn({ err, taskId, chatId }, "telegram: progress edit failed");
      }
    });
    await pending;
  }

  async function maybeEdit(): Promise<void> {
    const now = Date.now();
    if (now - lastEditAt < editIntervalMs) return;
    await postOrEdit();
  }

  const unsubscribe = registry.subscribe(taskId, async (event) => {
    switch (event.kind) {
      case "text":
        state.body += event.delta;
        await maybeEdit();
        break;
      case "tool_call":
        state.lastActivity = describeToolCall(event.tool);
        await maybeEdit();
        break;
      case "tool_result":
        state.lastActivity = describeToolResult(event.tool, event.ok, event.summary);
        await maybeEdit();
        break;
      case "plan_finalized":
        state.phase = "awaiting_approval";
        state.body = event.plan;
        // Force a post (bypass throttle) so the keyboard arrives with
        // the final plan body, not a stale interim edit.
        await postOrEdit(buildPlanKeyboard(taskId));
        break;
      case "execute_started":
        state.phase = "executing";
        // Reset body — execute narration starts from scratch; the plan
        // text is kept in the DB and on prior message edits in scrollback.
        state.body = "";
        delete state.lastActivity;
        await postOrEdit();
        break;
      case "execute_complete":
        state.phase = setPhase(event.ok, "pending_verify", "failed");
        delete state.lastActivity;
        if (event.tokens) state.tokens = event.tokens;
        await postOrEdit();
        // Once execute completes (success or fail), the subscriber is
        // done — drop the listener to free memory.
        unsubscribe();
        break;
      case "failed":
        state.phase = "failed";
        state.failureReason = event.reason;
        await postOrEdit();
        unsubscribe();
        break;
    }
  });

  return () => unsubscribe();
}

function setPhase(ok: boolean, ifTrue: ProgressPhase, ifFalse: ProgressPhase): ProgressPhase {
  return ok ? ifTrue : ifFalse;
}

/** Re-exported for tests. */
export type { ProgressTokenCounter };
