/**
 * The system prompt snapshot's epoch rules (design/prompt-caching.md → System
 * Prompt Snapshot): what its configuration digest covers, when an epoch
 * continues, what opening one strips, and which core-memory changes a turn
 * announces. Pure functions over durable values, so every re-invocation of a
 * turn reaches the same verdicts.
 */

import { createHash } from "node:crypto";
import type { Message } from "../llm/types.js";
import {
  type CoreMemoryScope,
  type CoreMemoryView,
  IDENTITY_BLOCK_KEY,
  type ScopedCoreMemoryBlock,
} from "./core-memory/scope.js";
import type { SystemPromptSnapshot } from "./store/index.js";

/** An epoch's snapshot as a step returns it: `openedAt` is the row's `created_at` as ISO text. */
export interface EpochSnapshot {
  openedBy: string;
  historyStart: string;
  rendered: string;
  configDigest: string;
  openedAt: string;
}

export function epochOf(row: SystemPromptSnapshot): EpochSnapshot {
  return {
    openedBy: row.openedBy,
    historyStart: row.historyStart,
    rendered: row.rendered,
    configDigest: row.configDigest,
    openedAt: row.createdAt.toISOString(),
  };
}

/**
 * The digest of everything a snapshot renders but core memory: the prompt
 * source's configuration, the tool table the turn offers, and the core-memory
 * scope, whose class and restricted flag decide which blocks `# User` shows.
 * `identityOverride` is whether a restricted class has its own `identity`: a
 * write deletes that block when no line differs from the shared one, and a
 * removal is the one core-memory change an announcement can't express.
 */
export function configDigest(args: {
  configuration: string;
  toolTable: string;
  scope: CoreMemoryScope;
  identityOverride: boolean;
}): string {
  // Positional, so a scope whose keys a replayed step returns sorted digests the same.
  const scope =
    args.scope.kind === "classed"
      ? [args.scope.kind, args.scope.profileClass, args.scope.restricted]
      : [args.scope.kind];
  return createHash("sha256")
    .update(JSON.stringify([args.configuration, args.toolTable, scope, args.identityOverride]))
    .digest("hex");
}

/** Whether `view` holds a restricted class's own `identity`. */
export function hasIdentityOverride({ scope, blocks }: CoreMemoryView): boolean {
  return (
    scope.kind === "classed" &&
    scope.restricted &&
    blocks.some((b) => b.profileClass === scope.profileClass && b.key === IDENTITY_BLOCK_KEY)
  );
}

/**
 * The first message a loaded history holds after its summary: the first row
 * in `messageIds` (whose summary entry is `null`), or the first after `cutoff`
 * once a summary through `cutoff` is stored. It identifies the summary a
 * history starts from, so a new one — this turn's or `/compact`'s — opens an
 * epoch.
 */
export function historyStart(
  messageIds: ReadonlyArray<string | null>,
  cutoff: string | null,
): string {
  const from = cutoff === null ? 0 : messageIds.indexOf(cutoff) + 1;
  const start = messageIds.slice(from).find((id) => id !== null);
  if (start === undefined) throw new Error("the history holds no message after its start");
  return start;
}

/** Whether a turn sends `snapshot`: it exists and its digest and history start are the turn's. */
export function continuesEpoch(
  snapshot: { configDigest: string; historyStart: string } | null,
  current: { configDigest: string; historyStart: string },
): boolean {
  return (
    snapshot !== null &&
    snapshot.configDigest === current.configDigest &&
    snapshot.historyStart === current.historyStart
  );
}

/**
 * `messages` with the thinking blocks of every message before `end` removed;
 * text and tool calls stay. Those blocks are bound to an earlier system prompt
 * or history, and as a leading run they can be removed without invalidating
 * the ones after them. A message left empty is dropped by the loop's history
 * sanitizer.
 */
export function stripThinkingBefore(messages: ReadonlyArray<Message>, end: number): Message[] {
  return messages.map((message, i) =>
    i >= end || typeof message.content === "string"
      ? message
      : { role: message.role, content: message.content.filter((b) => b.type !== "thinking") },
  );
}

/**
 * The blocks a turn announces: those it sees that changed after the epoch's
 * snapshot was rendered and that no turn context of the epoch has announced
 * since they changed, with their current content. A block is the pair
 * `(profileClass, key)`, since `identity` can exist shared and as a class's.
 */
export function coreMemoryToAnnounce(args: {
  view: CoreMemoryView;
  updateTimes: ReadonlyArray<{ profileClass: string | null; key: string; updatedAt: Date }>;
  epochOpenedAt: Date;
  announcements: ReadonlyArray<{
    createdAt: Date;
    blocks: ReadonlyArray<{ profileClass: string | null; key: string }>;
  }>;
}): CoreMemoryView {
  const same = (a: { profileClass: string | null; key: string }) => (b: typeof a) =>
    a.profileClass === b.profileClass && a.key === b.key;
  const changed = (block: ScopedCoreMemoryBlock): boolean => {
    const updatedAt = args.updateTimes.find(same(block))?.updatedAt;
    if (updatedAt === undefined || updatedAt < args.epochOpenedAt) return false;
    return !args.announcements.some((a) => a.createdAt > updatedAt && a.blocks.some(same(block)));
  };
  return { scope: args.view.scope, blocks: args.view.blocks.filter(changed) };
}
