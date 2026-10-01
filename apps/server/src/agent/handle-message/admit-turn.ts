import type { Logger } from "pino";
import type { Transactor } from "../../db/index.js";
import type { DeliveryRouter } from "../../transport/delivery-router.js";
import type { TransportStore } from "../../transport/store/index.js";
import { buildInCooldownReply, isInCooldown } from "../cooldown.js";
import type { DebounceConfig } from "../debounce.js";
import type { AgentStore, VoiceMode } from "../store/index.js";
import type { CooldownState } from "../store/schema.js";
import type { InboundRow } from "./inbound-batch.js";
import type { TurnSteps } from "./turn-steps.js";

export interface AdmitTurnDeps {
  runInTx: Transactor;
  agentStore: Pick<AgentStore, "getConversation" | "getLastAssistantMessage" | "getProfile">;
  transportStore: Pick<TransportStore, "getUnbatchedInbound">;
  deliveryRouter: Pick<DeliveryRouter, "notifyConversation">;
  resumePolicy: DebounceConfig["resumePolicy"];
}

export interface AdmitTurnArgs {
  conversationId: string;
  /** The `inbound/ready` trigger; null for a flush. */
  triggerInboundId: string | null;
  turnLogger: Logger;
}

/** Why a turn ends before doing any work. */
export type TurnSkipReason = "stale" | "await_input" | "no_messages" | "cooldown";

/** The conversation row as `load-conversation` returns it. */
export interface AdmittedConversation {
  id: string;
  userId: string;
  profileId: string;
  isPrivate: boolean;
  /** Null unless a failed run put the conversation in cooldown; an admitted one has elapsed. */
  cooldownState: CooldownState | null;
  voiceMode: VoiceMode | null;
}

/** The profile and models the turn stamps on every row it writes. */
export interface TurnSnapshot {
  profileId: string;
  model: string;
  summarizationModel: string;
}

/** Whether this delivery of `inbound/ready` runs a turn, and what admission loaded for it. */
export type Admission =
  | { kind: "skipped"; reason: TurnSkipReason }
  | {
      kind: "admitted";
      conv: AdmittedConversation;
      /** The previous reply's row and inbound cursor; none before the first reply. */
      lastAssistant: { id: string; lastInboundMessageId: string } | null;
      snapshot: TurnSnapshot;
      /** The unbatched inbound rows, never empty. */
      inboundMessages: ReadonlyArray<InboundRow>;
    };

/**
 * Admission: load the conversation, the previous turn's cursor, the turn
 * snapshot and the unbatched inbound batch, and decide whether this delivery
 * of `inbound/ready` runs a turn at all. A conversation in cooldown gets the
 * hand-built in-cooldown reply and no turn.
 *
 * Steps, in order: `load-conversation`, `last-assistant`, `load-turn-snapshot`,
 * `load-inbound` (unless a guard skips first), `in-cooldown-reply` (only when
 * the cooldown guard skips).
 */
export async function admitTurn(
  step: TurnSteps,
  deps: AdmitTurnDeps,
  args: AdmitTurnArgs,
): Promise<Admission> {
  const { agentStore, transportStore } = deps;
  const { conversationId, triggerInboundId, turnLogger } = args;

  const conv = await step.run("load-conversation", async () => {
    return deps.runInTx((tx) => agentStore.getConversation(tx, conversationId));
  });
  if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

  const { profileId } = conv;

  const lastAssistant = await step.run("last-assistant", async () => {
    return deps.runInTx((tx) => agentStore.getLastAssistantMessage(tx, conversationId));
  });

  // Turn snapshot — read profile + model once at turn-start and stamp them on
  // every message row this turn produces (user batch + intermediate + final
  // assistant). Mid-turn /profile switch updates conversations.profile_id but
  // the running turn keeps its snapshot; next turn picks up the new value.
  // `summarizationModel` is captured the same way: profile override falls
  // back to the chat model so a Haiku profile doesn't pay the Sonnet rate
  // for prefix summarization.
  // See design/transport/overview.md → Profile and Model Stamping.
  const snapshot = await step.run("load-turn-snapshot", async () => {
    const p = await deps.runInTx((tx) => agentStore.getProfile(tx, profileId));
    if (!p) throw new Error(`Profile not found: ${profileId}`);
    return {
      profileId,
      model: p.model,
      summarizationModel: p.summarizationModel ?? p.model,
    };
  });

  // Guard 1 — Staleness: trigger was already batched into a previous turn.
  // null trigger = flush, skip this check.
  if (
    triggerInboundId !== null &&
    lastAssistant?.lastInboundMessageId &&
    triggerInboundId <= lastAssistant.lastInboundMessageId
  ) {
    return skipped("stale");
  }

  // Guard 2 — Await_input: trigger was created before the last response.
  if (
    deps.resumePolicy === "await_input" &&
    triggerInboundId !== null &&
    lastAssistant &&
    triggerInboundId < lastAssistant.id
  ) {
    return skipped("await_input");
  }

  const inboundMessages = await step.run("load-inbound", async () => {
    return deps.runInTx((tx) =>
      transportStore.getUnbatchedInbound(
        tx,
        conversationId,
        lastAssistant?.lastInboundMessageId ?? null,
      ),
    );
  });

  // No unbatched messages — nothing to process (e.g., flush with no new input)
  if (inboundMessages.length === 0) {
    return skipped("no_messages");
  }

  // Cooldown guard — `recover-conversation` writes a `cooldown_state`
  // blob on conversations whose `handle-message` runs exhausted retries
  // (or failed non-retriably). While the cooldown window is open, we
  // refuse to spend more LLM calls; the user gets a terse hand-built
  // reply with a retry-time estimate.
  //
  // Placement is deliberate — *after* the no_messages / staleness /
  // await_input exits — so the cooldown reply only fires when there's
  // a real triggering inbound the user is actively trying to deliver.
  // Otherwise a null-trigger flush during cooldown would send a reply
  // to a message that doesn't exist.
  //
  // The debounce contract caps the reply rate naturally: a burst of
  // user messages during one debounce window coalesces to one
  // `inbound/ready` and one cooldown reply. Across multiple debounce
  // windows in the same cooldown the user gets N replies, where N is
  // the number of user-active windows — not a tight loop. See
  // design/agent-resilience.md → In-cooldown reply.
  //
  // Inbounds stay unbatched — `getUnbatchedInbound` is a pure SELECT,
  // so when the cooldown elapses the next `inbound/ready` loads the
  // entire backlog as one batch.
  const guardNow = new Date();
  if (conv.cooldownState !== null && isInCooldown(conv.cooldownState, guardNow)) {
    const cooldownState = conv.cooldownState;
    await step.run("in-cooldown-reply", async () => {
      try {
        await deps.deliveryRouter.notifyConversation(
          conversationId,
          buildInCooldownReply(cooldownState, guardNow),
        );
      } catch (notifyErr) {
        // Best-effort delivery — same shape as `onFailure`'s
        // `notify-user`. Swallowing prevents a transient session-lookup
        // or transport blip from propagating up, exhausting Inngest's
        // retry budget, and tripping `onFailure` → spuriously doubling
        // the cooldown for what's really just a delivery hiccup.
        turnLogger.error(
          { err: notifyErr },
          "in-cooldown-reply: notifyConversation failed; conversation stays in cooldown",
        );
      }
    });
    return skipped("cooldown");
  }

  return { kind: "admitted", conv, lastAssistant, snapshot, inboundMessages };
}

function skipped(reason: TurnSkipReason): Admission {
  return { kind: "skipped", reason };
}
