import { match } from "ts-pattern";
import { logger } from "../../logger.js";
import { buildPlanKeyboard, type PlanInlineKeyboardMarkup } from "./plan-keyboard.js";
import {
  describeToolCall,
  describeToolResult,
  formatProgressMessage,
  type ProgressFormatInput,
  type ProgressPhase,
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
  bot: ProgressBot;
  registry: Pick<CodingStreamingRegistry, "subscribe">;
  /** ms between throttled in-place edits during streaming. */
  editIntervalMs?: number;
}

/**
 * Per-task subscriber that owns one Telegram message: post once, edit in
 * place as plan + execute events arrive, attach the inline keyboard when
 * the plan finalises, render the final state on complete / fail. It lives
 * as long as the task's stream in the registry, which ends it.
 *
 * Single-process by design — a process restart loses the in-memory
 * subscriber. The orchestrator keeps running (Inngest-durable) and the
 * eventual completion writes are visible in DB; the user doesn't see the
 * rest of the live stream.
 */
export function startCodingProgressSubscriber(args: SubscriberArgs): void {
  const { taskId, chatId, goal, bot, registry } = args;
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
    // Update synchronously before awaiting the bot call. The registry
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

  registry.subscribe(taskId, async (event) => {
    await match(event)
      .with({ kind: "text" }, (e) => {
        state.body += e.delta;
        return maybeEdit();
      })
      .with({ kind: "tool_call" }, (e) => {
        state.lastActivity = describeToolCall(e.tool);
        return maybeEdit();
      })
      .with({ kind: "tool_result" }, (e) => {
        state.lastActivity = describeToolResult(e.tool, e.ok, e.summary);
        return maybeEdit();
      })
      .with({ kind: "plan_finalized" }, (e) => {
        state.phase = "awaiting_approval";
        state.body = e.plan;
        // Force a post (bypass throttle) so the final plan body lands
        // before execute_started arrives. The approve/revise/cancel
        // keyboard is suppressed when the plan orchestrator is about to
        // auto-approve — those buttons would be misleading (Approve is
        // a no-op against an already-approved plan, and a stray Cancel
        // tap mid-execute is action-at-a-distance).
        return postOrEdit(e.autoApproved ? undefined : buildPlanKeyboard(taskId));
      })
      .with({ kind: "execute_started" }, () => {
        state.phase = "executing";
        // Reset body — execute narration starts from scratch; the plan
        // text is kept in the DB and on prior message edits in scrollback.
        state.body = "";
        delete state.lastActivity;
        return postOrEdit();
      })
      .with({ kind: "execute_complete" }, (e) => {
        state.phase = setPhase(e.ok, "pending_verify", "failed");
        delete state.lastActivity;
        if (e.tokens) state.tokens = e.tokens;
        return postOrEdit();
      })
      .with({ kind: "failed" }, (e) => {
        state.phase = "failed";
        state.failureReason = e.reason;
        return postOrEdit();
      })
      .exhaustive();
  });
}

function setPhase(ok: boolean, ifTrue: ProgressPhase, ifFalse: ProgressPhase): ProgressPhase {
  return ok ? ifTrue : ifFalse;
}
