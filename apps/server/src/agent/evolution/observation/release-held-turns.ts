/**
 * `held → pending`, `held_extracted → extracted`: put a conversation's held
 * memories turns back in the plan, a `held` turn once the fire's profile isn't
 * bound and a `held_extracted` one once the profile that extracted it isn't
 * (design/observation.md → Slice 2a → Held).
 */

import * as R from "remeda";
import type { Transactor } from "../../../db/index.js";
import { type AgentStore, bindsUnseenUserRule, memoryRulesFor } from "../../store/index.js";
import type { ObserverFire } from "../drain-pending-memories.js";

export interface ReleaseHeldTurnsDeps {
  runInTx: Transactor;
  store: Pick<
    AgentStore,
    "getMemoryRules" | "releaseHeldTurns" | "listHeldExtractedTurns" | "releaseHeldExtractedTurns"
  >;
}

export async function releaseHeldTurns(
  deps: ReleaseHeldTurnsDeps,
  args: { fire: ObserverFire },
): Promise<{ released: number }> {
  const { fire } = args;
  const { conversationId } = fire;
  return deps.runInTx(async (tx) => {
    const heldExtracted = await deps.store.listHeldExtractedTurns(tx, { conversationId });
    const profileIds = R.unique([
      fire.profileId,
      ...heldExtracted.map((t) => t.extraction.profileId),
    ]);
    const rules = await deps.store.getMemoryRules(tx, { profileIds, userId: fire.userId });
    const rulesFor = (profileId: string) => memoryRulesFor(rules, profileId);

    const held = bindsUnseenUserRule(rulesFor(fire.profileId), fire.seesUserRules)
      ? 0
      : await deps.store.releaseHeldTurns(tx, { conversationId });
    const unbound = heldExtracted
      .filter(
        (t) => !bindsUnseenUserRule(rulesFor(t.extraction.profileId), t.extraction.seesUserRules),
      )
      .map((t) => t.id);
    const extracted = await deps.store.releaseHeldExtractedTurns(tx, { ids: unbound });
    return { released: held + extracted };
  });
}
