/**
 * `extracted → applied | held_extracted`: retain a turn's stored facts, or hold
 * them while a rule binds the profile that extracted them (design/observation.md
 * → Slice 2a → Keys, Held).
 */

import * as R from "remeda";
import { match } from "ts-pattern";
import type { Transactor } from "../../../db/index.js";
import type { MemoryProvider, RetainBatchItem } from "../../../memory/provider.js";
import { type AgentStore, bindsUnseenUserRule, type OpenTurn } from "../../store/index.js";
import type { ObservationStatusValue } from "../../store/schema.js";
import type { ObserverFire } from "../drain-pending-memories.js";
import { RetainUnavailableError } from "./failure.js";
import type { TurnExtraction } from "./turn-extraction.js";
import type { MemoryTurnOutcome } from "./turn-outcome.js";

export interface RetainTurnMemoriesDeps {
  runInTx: Transactor;
  store: Pick<AgentStore, "getTurnObservation" | "getMemoryRules" | "transitionExtractedTurn">;
  memory: Pick<MemoryProvider, "retainBatch">;
}

export interface RetainTurnMemoriesArgs {
  turn: OpenTurn;
  fire: ObserverFire;
}

/** What the retain finds to do: nothing (another run moved the row), hold it, or retain it. */
type RetainRead =
  | { kind: "moved"; status: ObservationStatusValue }
  | { kind: "hold" }
  | { kind: "retain"; extraction: TurnExtraction };

export async function retainTurnMemories(
  deps: RetainTurnMemoriesDeps,
  args: RetainTurnMemoriesArgs,
): Promise<MemoryTurnOutcome> {
  const { fire, turn } = args;
  const observationId = turn.observationId;
  const read = await deps.runInTx(async (tx): Promise<RetainRead> => {
    const row = await deps.store.getTurnObservation(tx, observationId);
    // The id came from this run's plan, and no code deletes the rows.
    if (row === undefined) throw new Error(`turn observation ${observationId} is missing`);
    // The caller read it `extracted` in this step: another run moved it since.
    if (row.status !== "extracted") return { kind: "moved", status: row.status };
    const { extraction } = row;
    // The extracting profile's rules, not the fire's: the prompt was its.
    const rules = await deps.store.getMemoryRules(tx, {
      profileIds: [extraction.profileId],
      userId: fire.userId,
    });
    // An extraction with no facts has nothing a rule could forbid.
    return extraction.items.length > 0 && bindsUnseenUserRule(rules, extraction.seesUserRules)
      ? { kind: "hold" }
      : { kind: "retain", extraction };
  });
  return match(read)
    .returnType<Promise<MemoryTurnOutcome>>()
    .with({ kind: "moved" }, async ({ status }) => ({ kind: "taken", status }))
    .with({ kind: "hold" }, () =>
      moveExtracted(deps, observationId, "held_extracted", () => ({ kind: "held" })),
    )
    .with({ kind: "retain" }, ({ extraction }) => retain(deps, args, extraction))
    .exhaustive();
}

async function retain(
  deps: RetainTurnMemoriesDeps,
  args: RetainTurnMemoriesArgs,
  extraction: TurnExtraction,
): Promise<MemoryTurnOutcome> {
  const { fire, turn } = args;
  const { items, dropped } = extraction;
  // Built before the call, so only the call's own throw reads as unavailable.
  const batch = retainItems(extraction, turn.cursor);
  if (batch.length > 0) {
    try {
      await deps.memory.retainBatch(fire.userId, batch);
    } catch (err) {
      throw new RetainUnavailableError(err);
    }
  }
  return moveExtracted(deps, turn.observationId, "applied", () => ({
    kind: "applied",
    byNetwork: R.countBy(items, (m) => m.network),
    droppedNoEvidence: dropped.noEvidence,
  }));
}

async function moveExtracted(
  deps: RetainTurnMemoriesDeps,
  id: string,
  to: "applied" | "held_extracted",
  moved: () => MemoryTurnOutcome,
): Promise<MemoryTurnOutcome> {
  const result = await deps.runInTx((tx) => deps.store.transitionExtractedTurn(tx, { id, to }));
  return match(result)
    .returnType<MemoryTurnOutcome>()
    .with({ kind: "transitioned" }, moved)
    .with({ kind: "stale" }, ({ status }) => ({ kind: "taken", status }))
    .exhaustive();
}

/** Item `i` of a turn's extraction retains under `observer:turn:<cursor>:<i>`. */
function retainItems(extraction: TurnExtraction, cursor: string): RetainBatchItem[] {
  const { profileClass } = extraction;
  return extraction.items.map((m, i) => ({
    content: m.fact,
    documentId: `observer:turn:${cursor}:${i}`,
    ...(m.context !== undefined && { context: m.context }),
    tags: [
      `network:${m.network}`,
      `compartment:${m.compartment}`,
      `trust:${m.trust}`,
      ...(profileClass === null ? [] : [`profile_class:${profileClass}`]),
    ],
    metadata: { source: "conversation" },
    observationScopes: "per_tag",
  }));
}
