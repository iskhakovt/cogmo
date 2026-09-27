/** Core memory scopes: design/memory.md → Core Memory Scope by Profile Class. */

import type { Transaction } from "../../db/index.js";
import type { AgentStore } from "../store/index.js";

/** The one key a classed profile shares with every persona. */
export const IDENTITY_BLOCK_KEY = "identity";

/** Leads of the groups a classed profile sees its blocks under. */
export const SHARED_GROUP = "Shared by every persona:";
export const OWN_GROUP = "Only in this persona:";

/** A stored block with its scope: `profileClass` is null for the shared block and the unclassed bucket. */
export interface ScopedCoreMemoryBlock {
  profileClass: string | null;
  key: string;
  content: string;
}

/**
 * Where one turn reads and writes core memory, frozen for the turn: nothing
 * for a third-party or unloadable profile, the unclassed bucket for a profile
 * without a class, or the profile's class and its restricted flag.
 */
export type CoreMemoryScope =
  | { readonly kind: "none" }
  | { readonly kind: "unclassed" }
  | { readonly kind: "classed"; readonly profileClass: string; readonly restricted: boolean };

/** What one turn sees of core memory: its scope and the blocks visible to it, in render order. */
export interface CoreMemoryView {
  readonly scope: CoreMemoryScope;
  readonly blocks: ReadonlyArray<ScopedCoreMemoryBlock>;
}

/**
 * Leaves out an unrestricted class's own `identity`, which a turn frozen
 * restricted can write after `/classes unrestrict` lands (design/memory.md →
 * Class Lifecycle).
 */
export async function readCoreMemory(
  tx: Transaction,
  store: Pick<AgentStore, "getCoreMemoryBlocks">,
  userId: string,
  scope: CoreMemoryScope,
): Promise<CoreMemoryView> {
  switch (scope.kind) {
    case "none":
      return { scope, blocks: [] };
    case "unclassed":
      return { scope, blocks: await store.getCoreMemoryBlocks(tx, userId, null) };
    case "classed": {
      const blocks = await store.getCoreMemoryBlocks(tx, userId, scope.profileClass);
      return {
        scope,
        blocks: scope.restricted
          ? blocks
          : blocks.filter((b) => b.profileClass === null || b.key !== IDENTITY_BLOCK_KEY),
      };
    }
  }
}
