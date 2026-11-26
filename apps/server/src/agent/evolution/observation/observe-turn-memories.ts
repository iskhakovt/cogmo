/**
 * Observe one planned turn's memories: the body of one durable step
 * (design/observation.md → Slice 2a → One fire). The row is the re-entry
 * guard: a `pending` turn is extracted and its facts stored before any is
 * retained, so a re-run of an `extracted` turn re-sends them without a model
 * call. Each move is its own use case: `holdTurn`, `skipEmptyTurn`,
 * `storeTurnExtraction`, `retainTurnMemories` and `recordTurnAttempt`.
 */

import { match } from "ts-pattern";
import { logger } from "../../../logger.js";
import {
  type AgentStore,
  bindsUnseenUserRule,
  type MemoryRule,
  type TurnMessage,
} from "../../store/index.js";
import type { ObservationStatusValue } from "../../store/schema.js";
import {
  type ExtractedMemory,
  extractTurnMemories,
  type MemoryExtractionDeps,
} from "../extract-memories.js";
import { classifyTurnFailure, ExtractionUnavailableError } from "./failure.js";
import { holdTurn } from "./hold-turn.js";
import { recordTurnAttempt } from "./record-turn-attempt.js";
import {
  type RetainTurnMemoriesArgs,
  type RetainTurnMemoriesDeps,
  retainTurnMemories,
} from "./retain-turn-memories.js";
import { skipEmptyTurn } from "./skip-empty-turn.js";
import { storeTurnExtraction } from "./store-turn-extraction.js";
import type { StoredMemory } from "./turn-extraction.js";
import type { MemoryTurnOutcome } from "./turn-outcome.js";
import { quotes, renderContext, renderTurn } from "./turns.js";

export interface ObserveTurnMemoriesDeps extends MemoryExtractionDeps, RetainTurnMemoriesDeps {
  store: RetainTurnMemoriesDeps["store"] &
    Pick<
      AgentStore,
      | "findAnsweredCursorBefore"
      | "listTurnMessages"
      | "transitionPendingTurn"
      | "recordTurnAttempt"
    >;
}

export interface ObserveTurnMemoriesArgs extends RetainTurnMemoriesArgs {
  /** The run extracting, recorded on the stored extraction. */
  runId: string;
  /** The fire's profile's `profile_class`, recorded on the extraction to tag every fact. */
  profileClass: string | null;
}

/** The row as the step finds it, with what a `pending` turn needs. */
type Loaded =
  | { kind: "done"; status: ObservationStatusValue }
  | { kind: "extracted" }
  | {
      kind: "pending";
      attempts: number;
      rules: ReadonlyArray<MemoryRule>;
      /** The cursor of the turn answered before this one: the context. */
      previous: string | undefined;
      rows: ReadonlyArray<TurnMessage>;
    };

export async function observeTurnMemories(
  deps: ObserveTurnMemoriesDeps,
  args: ObserveTurnMemoriesArgs,
): Promise<MemoryTurnOutcome> {
  const { store } = deps;
  const { fire, turn } = args;
  const loaded = await deps.runInTx(async (tx): Promise<Loaded> => {
    const row = await store.getTurnObservation(tx, turn.observationId);
    // The id came from this run's plan, and no code deletes the rows.
    if (row === undefined) throw new Error(`turn observation ${turn.observationId} is missing`);
    return match(row.status)
      .returnType<Promise<Loaded>>()
      .with("held", "held_extracted", "applied", "failed", "skipped", async (status) => ({
        kind: "done",
        status,
      }))
      .with("extracted", async () => ({ kind: "extracted" }))
      .with("pending", async () => {
        const rules = await store.getMemoryRules(tx, {
          profileIds: [fire.profileId],
          userId: fire.userId,
        });
        const previous = await store.findAnsweredCursorBefore(
          tx,
          fire.conversationId,
          turn.firstMessageId,
        );
        const cursors = previous === undefined ? [turn.cursor] : [turn.cursor, previous];
        const rows = await store.listTurnMessages(tx, fire.conversationId, cursors);
        return { kind: "pending", attempts: row.attempts, rules, previous, rows };
      })
      .exhaustive();
  });
  return match(loaded)
    .returnType<Promise<MemoryTurnOutcome>>()
    .with({ kind: "done" }, async (done) => done)
    .with({ kind: "extracted" }, () => retainTurnMemories(deps, args))
    .with({ kind: "pending" }, (pending) => observePending(deps, args, pending))
    .exhaustive();
}

async function observePending(
  deps: ObserveTurnMemoriesDeps,
  args: ObserveTurnMemoriesArgs,
  loaded: Extract<Loaded, { kind: "pending" }>,
): Promise<MemoryTurnOutcome> {
  const { fire, turn } = args;
  const observationId = turn.observationId;
  if (bindsUnseenUserRule(loaded.rules, fire.seesUserRules)) {
    logger.info(
      { ...fire, observationId },
      "observer: turn's memories held — a user's memory rule binds a profile that can't see it",
    );
    return holdTurn(deps, { observationId });
  }
  const rendered = renderTurn(loaded.rows, turn.cursor);
  // Nothing a fact could quote: no model call.
  if (rendered.transcript.trim() === "") return skipEmptyTurn(deps, { observationId });

  const text = {
    turn: rendered.transcript,
    context: loaded.previous === undefined ? null : renderContext(loaded.rows, loaded.previous),
  };
  let extracted: ReadonlyArray<ExtractedMemory>;
  try {
    extracted = await extractTurnMemories(text, loaded.rules, deps);
  } catch (err) {
    const failure = classifyTurnFailure(err);
    // Not the turn's doing: the step retries it, and the row stays as it is.
    if (failure === null) throw new ExtractionUnavailableError(err);
    logger.warn(
      { err, conversationId: fire.conversationId, observationId },
      "observer: turn's memory extraction failed",
    );
    return recordTurnAttempt(deps, {
      observationId,
      from: "pending",
      seen: loaded.attempts,
      failure,
    });
  }

  // Tool results and forwarded text count: facts come from tool output too.
  const items = extracted.filter((m) => quotes(m.evidence, rendered.transcript)).map(stored);
  const noEvidence = extracted.length - items.length;
  if (noEvidence > 0) {
    logger.info(
      { conversationId: fire.conversationId, observationId, droppedNoEvidence: noEvidence },
      "observer: dropped facts whose evidence the turn doesn't hold",
    );
  }
  const result = await storeTurnExtraction(deps, {
    observationId,
    extraction: {
      phase: "memories",
      runId: args.runId,
      profileId: fire.profileId,
      profileClass: args.profileClass,
      seesUserRules: fire.seesUserRules,
      items,
      dropped: { noEvidence },
    },
  });
  return match(result)
    .returnType<Promise<MemoryTurnOutcome>>()
    .with({ kind: "stale" }, async ({ status }) => ({ kind: "taken", status }))
    .with({ kind: "stored" }, () => retainTurnMemories(deps, args))
    .exhaustive();
}

function stored(m: ExtractedMemory): StoredMemory {
  return {
    fact: m.fact,
    network: m.network,
    compartment: m.compartment,
    trust: m.trust,
    ...(m.context !== undefined && { context: m.context }),
    evidence: m.evidence,
  };
}
