import type { Transactor } from "../../db/index.js";
import type { AgentStore, Profile } from "../store/index.js";
import { admitsFirstParty, type CoreMemoryScope } from "./scope.js";

/**
 * None for a profile whose trust excludes `first-party` or that can't be
 * loaded: core memory is written by profiles the user controls
 * (design/memory.md → Boundaries).
 */
export async function loadCoreMemoryScope(
  deps: { runInTx: Transactor; agentStore: Pick<AgentStore, "listProfileClasses"> },
  args: { userId: string; profile: Profile | undefined },
): Promise<CoreMemoryScope> {
  const { profile } = args;
  if (profile === undefined || !admitsFirstParty(profile)) return { kind: "none" };
  const profileClass = profile.profileClass;
  if (profileClass === null) return { kind: "unclassed" };
  const classes = await deps.runInTx((tx) => deps.agentStore.listProfileClasses(tx, args.userId));
  return {
    kind: "classed",
    profileClass,
    restricted: classes.some((c) => c.name === profileClass && c.restricted),
  };
}
