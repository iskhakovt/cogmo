import type { Inngest } from "inngest";
import type { CooldownState } from "../../agent/store/schema.js";
import {
  buildConversationCooldownClearedEvent,
  type CooldownClearedBy,
  calculateElapsedCooldown,
} from "../../inngest/events.js";

/**
 * Telemetry for the three transport clear-trigger sites (`/repair`,
 * `setProfile`, `profiles.update` w/ `clearCooldownForConversation`).
 * Each site (a) loads the conversation's prior `cooldown_state` inside
 * `runInTx`, (b) writes the clear, (c) calls this helper AFTER the tx
 * commits. Skipping the emit when `priorState` is null mirrors the
 * tx's `clearCooldown !== null` gate — only emit when a clear
 * actually happened.
 *
 * Explicit bus-dedup `id` keyed on `(conversationId, lastErroredAt)`
 * — the specific cooldown being cleared. Transport methods aren't
 * wrapped in Inngest's retry harness, but the explicit id is
 * belt-and-braces against a caller-side retry (e.g. a Telegram
 * command retried by the user) double-firing downstream consumers.
 * See design/agent-resilience.md → Telemetry.
 */
export async function emitCooldownClearedIfAny(
  inngest: Inngest,
  priorState: CooldownState | null,
  conversationId: string,
  clearedBy: CooldownClearedBy,
): Promise<void> {
  if (priorState === null) return;
  await inngest.send(
    buildConversationCooldownClearedEvent(
      {
        conversationId,
        clearedBy,
        elapsedCooldownSeconds: calculateElapsedCooldown(priorState.lastErroredAt),
      },
      `cooldown-cleared-${conversationId}-${priorState.lastErroredAt}`,
    ),
  );
}
