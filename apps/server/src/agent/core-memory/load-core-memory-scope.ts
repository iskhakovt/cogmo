import type { Transactor } from "../../db/index.js";
import type { AgentStore, Profile } from "../store/index.js";
import type { CoreMemoryScope } from "./scope.js";

/**
 * The core-memory scope a profile's turn gets. A profile whose trust excludes
 * `first-party` (a null `memory_scope` admits it) or that can't be loaded gets
 * none: core memory is written by profiles the user controls. Otherwise the
 * profile's class decides, with the restricted flag read from the
 * conversation user's registry.
 */
export async function loadCoreMemoryScope(
  deps: { runInTx: Transactor; agentStore: Pick<AgentStore, "listProfileClasses"> },
  args: { userId: string; profile: Profile | undefined },
): Promise<CoreMemoryScope> {
  const { profile } = args;
  if (profile === undefined) return { kind: "none" };
  if (profile.memoryScope !== null && !profile.memoryScope.trust.includes("first-party")) {
    return { kind: "none" };
  }
  const profileClass = profile.profileClass;
  if (profileClass === null) return { kind: "unclassed" };
  const classes = await deps.runInTx((tx) => deps.agentStore.listProfileClasses(tx, args.userId));
  return {
    kind: "classed",
    profileClass,
    restricted: classes.some((c) => c.name === profileClass && c.restricted),
  };
}
