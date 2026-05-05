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
 */

import { inngest } from "../inngest/client.js";
import { conversationErrored } from "../inngest/events.js";
import { logger } from "../logger.js";
import type { AgentStore } from "./store/index.js";

export interface RecoverConversationDeps {
  agentStore: AgentStore;
}

export function createRecoverConversation(deps: RecoverConversationDeps) {
  const { agentStore } = deps;

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
        return agentStore.getConversation(conversationId);
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
        await agentStore.setConversationStatus(conversationId, "errored");
      });
      logger.warn(
        { conversationId, errorClass, causeClass, errorMessage },
        "recover-conversation: conversation marked errored",
      );
      return { status: "marked_errored" };
    },
  );
}
