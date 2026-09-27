/**
 * Core memory scopes (design/memory.md → Core Memory Scope by Profile Class).
 * A block's scope follows from its key and the writing profile's class: the
 * `identity` block with no class is shared by every persona, any other block
 * with no class is the unclassed bucket, and a block with a class belongs to
 * that class.
 */

import type { Transaction } from "../../db/index.js";
import type { AgentStore } from "../store/index.js";

/** The one key a classed profile shares with every persona. */
export const IDENTITY_BLOCK_KEY = "identity";

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
  | { kind: "none" }
  | { kind: "unclassed" }
  | { kind: "classed"; profileClass: string; restricted: boolean };

/** The blocks `scope` sees, in the order they render. */
export async function readCoreMemory(
  tx: Transaction,
  store: Pick<AgentStore, "getCoreMemoryBlocks">,
  userId: string,
  scope: CoreMemoryScope,
): Promise<ReadonlyArray<ScopedCoreMemoryBlock>> {
  switch (scope.kind) {
    case "none":
      return [];
    case "unclassed":
      return store.getCoreMemoryBlocks(tx, userId, null);
    case "classed":
      return store.getCoreMemoryBlocks(tx, userId, scope.profileClass);
  }
}
