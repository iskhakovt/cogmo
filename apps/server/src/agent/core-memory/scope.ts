/**
 * Core memory scopes (design/memory.md → Core Memory Scope by Profile Class).
 * A block's scope follows from its key and the writing profile's class: the
 * `identity` block with no class is shared by every persona, any other block
 * with no class is the unclassed bucket, and a block with a class belongs to
 * that class.
 */

/** The one key a classed profile shares with every persona. */
export const IDENTITY_BLOCK_KEY = "identity";

/** A stored block with its scope: `profileClass` is null for the shared block and the unclassed bucket. */
export interface ScopedCoreMemoryBlock {
  profileClass: string | null;
  key: string;
  content: string;
}
