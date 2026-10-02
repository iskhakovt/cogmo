import { match } from "ts-pattern";
import { z } from "zod";
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
  agentStore: Pick<
    AgentStore,
    "insertMessages" | "clearCooldown" | "findLastAssistantMessageByInbound" | "isCursorRebatched"
  >;
}

export interface PersistTurnArgs {
  conversationId: string;
  runId: string;
  triggerInboundId: string | null;
  snapshot: { profileId: string; model: string };
  /** The batch's last inbound: the cursor the turn's rows are written with. */
  maxInboundId: string;
  /**
   * The reply admission found (`last-assistant`), or null before the first.
   * Every row this turn's checks look for is newer, so they read no further back.
   */
  lastAnsweredMessageId: string | null;
  /** The conversation's cooldown when admission let the turn through: an elapsed one this turn probes. */
  priorCooldown: CooldownState | null;
  result: AgentLoopResult;
}

/**
 * What `persist-new-messages` settled. `persisted` names the turn's final
 * reply row, written by this run. `superseded`: another reply owns the
 * batch's inbounds — a later turn re-batched them, or another run of the
 * same batch persisted a different reply — so nothing was written
 * (design/observation.md → Late replies).
 */
export type PersistOutcome = { kind: "persisted"; messageId: string } | { kind: "superseded" };

/** The step's memo. An `{ id }` memo is accepted and reads as `persisted`. */
const PersistOutcomeSchema = z.union([
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("persisted"), messageId: z.string() }),
    z.object({ kind: z.literal("superseded") }),
  ]),
  z
    .object({ id: z.string() })
    .transform(({ id }): PersistOutcome => ({ kind: "persisted", messageId: id })),
]);

/** What the persist transaction found or did. */
type PersistWrite =
  | { kind: "inserted"; messageId: string }
  | { kind: "own_earlier_write"; messageId: string }
  | { kind: "superseded" };

/**
 * Persist the turn's new messages — tool turns and the final assistant — and
 * emit what the turn settles: a cleared cooldown when it persisted, a
 * degraded turn either way (the apology streamed whether or not it persists).
 *
 * The persist transaction first looks for a reply already on the turn's
 * cursor. One whose content is this run's final message is this run's own
 * earlier write (a re-run after commit): `persisted` with its id, nothing
 * written. A different one is another run of the same batch: `superseded`.
 * Otherwise it is `superseded` when a later turn row covers the cursor, and
 * inserts when none does.
 *
 * Steps, in order: `persist-new-messages`, `emit-cooldown-cleared` (when
 * `persisted` and the turn probed an elapsed cooldown),
 * `emit-conversation-degraded` (when the loop degraded).
 */
export async function persistTurn(
  step: TurnSteps,
  deps: PersistTurnDeps,
  args: PersistTurnArgs,
): Promise<PersistOutcome> {
  const { conversationId, snapshot, result, priorCooldown, maxInboundId } = args;
  const afterMessageId = args.lastAnsweredMessageId;

  const memo = await step.run("persist-new-messages", async (): Promise<PersistOutcome> => {
    const finalMessage = result.newMessages.at(-1);
    if (finalMessage === undefined) throw new Error("persistTurn: the loop returned no messages");
    // Both checks read in the insert's transaction, so the decision and the
    // write share one snapshot. REPEATABLE READ takes no predicate lock: a
    // row committed by a transaction overlapping this one is missed
    // (design/observation.md → Late replies).
    const write = await deps.runInTx(async (tx): Promise<PersistWrite> => {
      const existing = await deps.agentStore.findLastAssistantMessageByInbound(tx, {
        conversationId,
        inboundId: maxInboundId,
        afterMessageId,
        content: finalMessage.content,
      });
      if (existing !== undefined) {
        // The final message comes from a memoized step (`llm-iter<N>`,
        // `degraded-reply`), so this run's own earlier write holds exactly
        // this content; another run of the batch sampled its own reply. An
        // identical reply from another run reads as this run's, and the same
        // text is delivered twice (design/observation.md → Late replies).
        return existing.sameContent
          ? { kind: "own_earlier_write", messageId: existing.id }
          : { kind: "superseded" };
      }
      const rebatched = await deps.agentStore.isCursorRebatched(tx, {
        conversationId,
        cursor: maxInboundId,
        afterMessageId,
      });
      if (rebatched) return { kind: "superseded" };
      const inserted = await deps.agentStore.insertMessages(tx, {
        conversationId,
        messages: result.newMessages,
        profileId: snapshot.profileId,
        model: snapshot.model,
        lastInboundMessageId: maxInboundId,
        lastMessageInputTokens: result.usage.inputTokens,
        lastMessageOutputTokens: result.usage.outputTokens,
      });
      // Half-open success: when the entry guard saw an elapsed cooldown
      // and admitted this probe turn, clear `cooldown_state` in the same
      // transaction. Strict prior-cooldown gating avoids a per-turn
      // pointless UPDATE on Closed conversations.
      if (priorCooldown !== null) {
        await deps.agentStore.clearCooldown(tx, conversationId);
      }
      return { kind: "inserted", messageId: inserted.id };
    });
    // Inside the step, because the bare body re-executes once per remaining
    // boundary and would record the same turn 3-6 times; a step body fires
    // once and is suppressed on replay. After the transaction, so a
    // transaction that keeps failing adds no sample, and for every outcome
    // except this run's own earlier write, whose attempt already reached
    // this line or crashed before it. A `superseded` attempt has no such
    // marker, so a step retried after it finished but before Inngest stored
    // the result records the turn twice. For a histogram read to spot
    // runaway iteration counts, repeated copies of one value are worse than
    // a missing one, and that retry window is the only source of them.
    return match(write)
      .returnType<PersistOutcome>()
      .with({ kind: "inserted" }, ({ messageId }) => {
        agentIterations.record(result.iterations, { model: result.model });
        return { kind: "persisted", messageId };
      })
      .with({ kind: "own_earlier_write" }, ({ messageId }) => ({ kind: "persisted", messageId }))
      .with({ kind: "superseded" }, () => {
        agentIterations.record(result.iterations, { model: result.model });
        return { kind: "superseded" };
      })
      .exhaustive();
  });
  const outcome = PersistOutcomeSchema.parse(memo);

  // The cooldown was cleared only where the turn's rows were written.
  const clearedCooldown = match(outcome)
    .with({ kind: "persisted" }, () => priorCooldown)
    .with({ kind: "superseded" }, () => null)
    .exhaustive();
  await emitTurnEvents(step, args, clearedCooldown);
  return outcome;
}

async function emitTurnEvents(
  step: TurnSteps,
  args: PersistTurnArgs,
  clearedCooldown: CooldownState | null,
): Promise<void> {
  const { conversationId, result } = args;

  // Half-open success: cooldown was cleared inside the persist tx.
  // Emit `conversation/cooldown/cleared` as a separate durable step
  // AFTER persist commits so the event can't fire on a rolled-back
  // tx. Same pattern as the degrade emit below. The pre-tx
  // cooldown carries `lastErroredAt` for the elapsed
  // calculation. Explicit bus-dedup `id` keyed on the cooldown
  // being cleared protects against `step.sendEvent`'s at-least-once
  // delivery contract — a retry after the send registers but before
  // the cache write would otherwise double-fire downstream
  // consumers. See design/agent-resilience.md → Telemetry.
  if (clearedCooldown !== null) {
    await step.sendEvent(
      "emit-cooldown-cleared",
      buildConversationCooldownClearedEvent(
        {
          conversationId,
          clearedBy: "success",
          elapsedCooldownSeconds: calculateElapsedCooldown(clearedCooldown.lastErroredAt),
        },
        `cooldown-cleared-${conversationId}-${clearedCooldown.lastErroredAt}`,
      ),
    );
  }

  // Emit the degrade signal as a separate durable step after persist —
  // `step.sendEvent` provides exactly-once delivery, same pattern as
  // `conversation/errored` in `onFailure`. A superseded turn emits it too:
  // the apology already streamed to the user. See
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
}
