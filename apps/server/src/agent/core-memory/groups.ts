/**
 * How a turn's core-memory blocks group when they render, in `# User` and in
 * a turn context's announcements alike (design/memory.md → What the Model
 * Sees).
 */

import type { CoreMemoryView, ScopedCoreMemoryBlock } from "./scope.js";

const SHARED_GROUP = "Shared by every persona:";

const RESTRICTED_SHARED_GROUP =
  "Shared by every persona. This persona's own `identity`, if it has one, wins where the two " +
  "differ, and the lines it leaves out still come from here. An `identity` you save here " +
  "becomes that one and stays in this persona, so write only the lines that differ from this " +
  "block, not a copy of it:";

const OWN_GROUP = "Only in this persona:";

/** A run of blocks under its lead; an unclassed turn's one group has none. */
export interface BlockGroup {
  lead: string | null;
  blocks: ReadonlyArray<ScopedCoreMemoryBlock>;
}

/**
 * `view`'s blocks as they render: an unclassed turn's in one group without a
 * lead; a classed turn's shared blocks, then its class's own, each group led
 * and left out when empty. No groups when the view holds no block.
 */
export function blockGroups({ scope, blocks }: CoreMemoryView): BlockGroup[] {
  if (blocks.length === 0) return [];
  if (scope.kind !== "classed") return [{ lead: null, blocks }];
  return [
    {
      lead: scope.restricted ? RESTRICTED_SHARED_GROUP : SHARED_GROUP,
      blocks: blocks.filter((b) => b.profileClass === null),
    },
    { lead: OWN_GROUP, blocks: blocks.filter((b) => b.profileClass !== null) },
  ].filter((group) => group.blocks.length > 0);
}

/** The groups rendered with `format` for each group's blocks, each under its lead. */
export function formatBlockGroups(
  groups: ReadonlyArray<BlockGroup>,
  format: (blocks: ReadonlyArray<ScopedCoreMemoryBlock>) => string,
): string {
  return groups
    .map(({ lead, blocks }) => (lead === null ? format(blocks) : `${lead}\n\n${format(blocks)}`))
    .join("\n\n");
}
