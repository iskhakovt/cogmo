import type { Transactor } from "../../db/index.js";
import {
  buildConversationCooldownClearedEvent,
  calculateElapsedCooldown,
  conversationDegraded,
} from "../../inngest/events.js";
import { agentIterations } from "../../metrics.js";
import type { AgentLoopResult } from "../loop.js";
import type { AgentStore } from "../store/index.js";
import type { CooldownState } from "../store/schema.js";
import type { TurnSteps } from "./turn-steps.js";

export interface PersistTurnDeps {
  runInTx: Transactor;
  agentStore: Pick<AgentStore, "insertMessages" | "clearCooldown">;
}

export interface PersistTurnArgs {
  conversationId: string;
  runId: string;
  triggerInboundId: string | null;
  snapshot: { profileId: string; model: string };
  /** The batch's last inbound: the cursor the turn's rows are written with. */
  maxInboundId: string;
  /** The conversation's cooldown when admission let the turn through: an elapsed one this turn probes. */
  priorCooldown: CooldownState | null;
  result: AgentLoopResult;
}

/**
 * Persist the turn's new messages — tool turns and the final assistant — and
 * emit what the persisted turn settles: a cleared cooldown, a degraded turn.
 * Returns the id of the last row written.
 *
 * Steps, in order: `persist-new-messages`, `emit-cooldown-cleared` (when the
 * turn probed an elapsed cooldown), `emit-conversation-degraded` (when the
 * loop degraded).
 */
export async function persistTurn(
  step: TurnSteps,
  deps: PersistTurnDeps,
  args: PersistTurnArgs,
): Promise<string> {
  const { conversationId, snapshot, result, priorCooldown } = args;

  // Half-open success: when the entry guard saw an elapsed cooldown
  // and admitted this probe turn, clear `cooldown_state` in the same
  // transaction. Strict prior-cooldown gating avoids a per-turn
  // pointless UPDATE on Closed conversations.
  const assistantMsg = await step.run("persist-new-messages", async () => {
    const persisted = await deps.runInTx(async (tx) => {
      const inserted = await deps.agentStore.insertMessages(tx, {
        conversationId,
        messages: result.newMessages,
        profileId: snapshot.profileId,
        model: snapshot.model,
        lastInboundMessageId: args.maxInboundId,
        lastMessageInputTokens: result.usage.inputTokens,
        lastMessageOutputTokens: result.usage.outputTokens,
      });
      if (priorCooldown !== null) {
        await deps.agentStore.clearCooldown(tx, conversationId);
      }
      return inserted;
    });
    // Inside the step, because the bare body re-executes once per
    // remaining boundary and would record the same turn 3-6 times; a step
    // body fires once and is suppressed on replay. After the write,
    // because a step body re-runs on every retry too — recording first
    // would add a sample per attempt whenever the transaction is the thing
    // failing. The turn is durably persisted by the time the sample is
    // taken, and the step has not returned, so nothing downstream has
    // moved on.
    //
    // The cost is coverage: a turn whose persist fails irrecoverably is
    // never sampled, so the histogram counts turns that produced a
    // persisted reply rather than every turn the loop ran. Recording
    // ahead of the write would not buy back much — a turn that fails
    // before reaching this step is unsampled either way — and it would
    // pay in duplicates, N identical samples whenever the transaction is
    // what keeps retrying. For a histogram read to spot runaway
    // iteration counts, repeated copies of one value are worse than a
    // missing one: they invent the pattern it exists to detect.
    agentIterations.record(result.iterations, { model: result.model });
    return persisted;
  });

  // Half-open success: cooldown was cleared inside the persist tx.
  // Emit `conversation/cooldown/cleared` as a separate durable step
  // AFTER persist commits so the event can't fire on a rolled-back
  // tx. Same pattern as the degrade emit below. The pre-tx
  // `priorCooldown` carries `lastErroredAt` for the elapsed
  // calculation. Explicit bus-dedup `id` keyed on the cooldown
  // being cleared protects against `step.sendEvent`'s at-least-once
  // delivery contract — a retry after the send registers but before
  // the cache write would otherwise double-fire downstream
  // consumers. See design/agent-resilience.md → Telemetry.
  if (priorCooldown !== null) {
    await step.sendEvent(
      "emit-cooldown-cleared",
      buildConversationCooldownClearedEvent(
        {
          conversationId,
          clearedBy: "success",
          elapsedCooldownSeconds: calculateElapsedCooldown(priorCooldown.lastErroredAt),
        },
        `cooldown-cleared-${conversationId}-${priorCooldown.lastErroredAt}`,
      ),
    );
  }

  // Emit the degrade signal as a separate durable step after persist —
  // `step.sendEvent` provides exactly-once delivery, same pattern as
  // `conversation/errored` in `onFailure`. See
  // design/agent-resilience.md → Telemetry.
  if (result.degraded) {
    const degradedSubtype = result.degraded.subtype;
    await step.sendEvent(
      "emit-conversation-degraded",
      conversationDegraded.create({
        conversationId,
        runId: args.runId,
        triggerInboundId: args.triggerInboundId,
        subtype: degradedSubtype,
        reason: result.degraded.reason,
      }),
    );
  }

  return assistantMsg.id;
}
