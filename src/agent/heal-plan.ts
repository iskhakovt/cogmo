/**
 * Compute a heal plan from raw history + validated history.
 *
 * The agent's history-invariant validator (`./history-invariants.ts`) returns
 * a repaired in-memory `Message[]`. To persist the repair we need to know:
 *  - which existing rows to mark superseded (hide from `getHistory`),
 *  - which new rows to insert (the repaired tail).
 *
 * Strategy: walk both arrays from the head, find the first index where they
 * diverge, then supersede every original from that index onward and insert
 * every validated message from that index onward. Append-only at the storage
 * layer (UUIDv7 ordering preserved); visibility flipped via `superseded_at`.
 *
 * Content preservation: when the validator merges (e.g. orphan tool_use →
 * synthesized tool_result prepended to the user's text), the merged message
 * appears at the divergence position in the validated array, so its content
 * is reinserted as a new row. Drop-only repairs (empty content) supersede
 * without inserting; the original row's content was already empty.
 */

import * as R from "remeda";
import type { Message } from "../llm/types.js";

export interface HealPlan {
  /** ids of existing rows to mark superseded */
  supersededIds: string[];
  /** new messages to append (already in correct order) */
  insertions: Message[];
  /** index in `originals` where the two streams first differ; equal to `originals.length` when only insertions are needed */
  divergenceIndex: number;
}

/**
 * Returns true when no heal is needed (validator made no changes).
 */
export function isNoOp(plan: HealPlan): boolean {
  return plan.supersededIds.length === 0 && plan.insertions.length === 0;
}

/**
 * Find the first index where `validated` differs from `originals`. Originals
 * are compared by their `message` field (id is opaque to validator output).
 */
export function computeHealPlan(
  originals: ReadonlyArray<{ id: string; message: Message }>,
  validated: ReadonlyArray<Message>,
): HealPlan {
  const limit = Math.min(originals.length, validated.length);
  let i = 0;
  while (i < limit) {
    const orig = originals[i];
    const val = validated[i];
    if (!orig || !val || !R.isDeepEqual(orig.message, val)) break;
    i++;
  }
  return {
    supersededIds: originals.slice(i).map((o) => o.id),
    insertions: validated.slice(i).map((m) => ({ ...m })),
    divergenceIndex: i,
  };
}
