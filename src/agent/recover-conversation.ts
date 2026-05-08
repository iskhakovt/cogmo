/**
 * Recovery function — listens for `conversation/errored` and marks the
 * conversation as irrecoverable so `handle-message`'s status guard
 * refuses further inbound until a human resets it.
 *
 * Triggered by the `onFailure` handler on `handle-message` after Inngest
 * retries exhaust (or immediately on a `NonRetriableError`).
 *
 * Minimal scope: this version just sets `status = errored`. It doesn't
 * attempt repair-and-retry — without a repair pathway in place, retrying
 * a deterministic failure (auth revoked, model deprecated, content
 * moderation, malformed tool schema, programmer bug) just burns LLM
 * calls on the same upstream error. The status guard makes failures
 * cheap; a future PR can add a repair branch on top if/when concrete
 * recovery cases arise (orphan history reintroduced by a second writer,
 * provider transient classification expanded, etc.).
 *
 * `retries: 0` — one shot per failure event. If this function itself
 * fails mid-run, Inngest's standard alerting catches it; we don't want
 * a recovery cascade.
 *
 * Race window between `conversation/errored` emission and the status
 * write: a new inbound arriving in that gap will pass `handle-message`'s
 * status guard (status is still `active`), run the agent loop, fail the
 * same way, and trip `onFailure` again — which re-emits
 * `conversation/errored` and re-runs this function. The cycle converges:
 * each failed retry costs one LLM call, but eventually a `recover-conversation`
 * run lands its `setConversationStatus` write before the next inbound
 * passes the guard, and the guard starts skipping. Self-healing without
 * an explicit retry policy. Worth knowing this isn't a bug if you're
 * tracing duplicate `conversation/errored` events in telemetry.
 */

import type { Transactor } from "../db/index.js";
import { inngest } from "../inngest/client.js";
import { conversationErrored } from "../inngest/events.js";
import { logger } from "../logger.js";
import type { AgentStore } from "./store/index.js";

export interface RecoverConversationDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
}

export function createRecoverConversation(deps: RecoverConversationDeps) {
  const { runInTx, agentStore } = deps;

  return inngest.createFunction(
    {
      id: "recover-conversation",
      triggers: [conversationErrored],
      retries: 0,
      concurrency: { limit: 1, key: "event.data.conversationId" },
    },
    async ({ event, step }) => {
      const { conversationId, errorClass, causeClass, errorMessage } = event.data;

      const conv = await step.run("load-conversation", async () => {
        return runInTx((tx) => agentStore.getConversation(tx, conversationId));
      });
      if (!conv) {
        logger.warn(
          { conversationId, errorClass, errorMessage },
          "recover-conversation: conversation not found",
        );
        return { status: "skipped", reason: "conversation_not_found" };
      }
      if (conv.status === "errored") {
        // Already marked — earlier failure on the same conversation already
        // tripped this. Nothing to do.
        return { status: "skipped", reason: "already_errored" };
      }

      await step.run("mark-errored", async () => {
        await runInTx((tx) => agentStore.setConversationStatus(tx, conversationId, "errored"));
      });
      logger.warn(
        { conversationId, errorClass, causeClass, errorMessage },
        "recover-conversation: conversation marked errored",
      );
      return { status: "marked_errored" };
    },
  );
}
