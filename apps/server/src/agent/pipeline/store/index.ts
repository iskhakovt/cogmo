import { and, count, desc, eq, max, notInArray, sql } from "drizzle-orm";
import { single } from "../../../db/helpers.js";
import type { Transaction } from "../../../db/index.js";
import type { StageArtifact, StageOutputs } from "../run-types.js";
import type { PipelineDefinition } from "../types.js";
import { pipelineDefinitions, type pipelineRunStatus, pipelineRuns } from "./schema.js";

export interface PipelineDefinitionRow {
  id: string;
  userId: string;
  name: string;
  version: number;
  sourceText: string;
  compiled: PipelineDefinition;
  active: boolean;
  createdAt: Date;
}

export interface PipelineStore {
  /**
   * Insert the next version for `(userId, name)` — version 1 when the name
   * is new, `max(version) + 1` otherwise. Always inserts `active: false`;
   * activation is a separate, explicit step after the user confirms the
   * preview. The `UNIQUE(user_id, name, version)` index backstops the
   * read-compute-insert against a concurrent define for the same name
   * (REPEATABLE READ doesn't predicate-lock); at single-user scale the
   * 23505 from a lost race is acceptable — the tool surfaces it and the
   * user retries.
   */
  insertDefinition(
    tx: Transaction,
    params: {
      userId: string;
      name: string;
      sourceText: string;
      compiled: PipelineDefinition;
    },
  ): Promise<PipelineDefinitionRow>;

  getDefinition(tx: Transaction, id: string): Promise<PipelineDefinitionRow | undefined>;

  /** Look up one version of a named pipeline; latest version when `version` is omitted. */
  getDefinitionByName(
    tx: Transaction,
    userId: string,
    name: string,
    version?: number,
  ): Promise<PipelineDefinitionRow | undefined>;

  /**
   * The one active version of a named pipeline, if the user has activated
   * any. Distinct from {@link PipelineStore.getDefinitionByName}, which
   * answers "latest version" — a run must pin the *active* version, which
   * may be older than the latest when a newer draft is awaiting confirmation.
   */
  getActiveDefinitionByName(
    tx: Transaction,
    userId: string,
    name: string,
  ): Promise<PipelineDefinitionRow | undefined>;

  /** All definition rows for a user, name ASC then version DESC. */
  listDefinitions(tx: Transaction, userId: string): Promise<readonly PipelineDefinitionRow[]>;

  /**
   * Row count for a user — the cap checks' shape. A dedicated COUNT(*)
   * because every full-row read runs the `compiled` column through
   * jsonbZod's `PipelineDefinitionSchema.parse`; counting via
   * `listDefinitions().length` near the cap would Zod-parse hundreds of
   * definitions to produce one integer.
   */
  countDefinitions(tx: Transaction, userId: string): Promise<number>;

  /**
   * Activate one version: deactivate the current active row for
   * `(userId, name)`, then flip the target on — that order keeps the
   * partial unique index satisfied throughout the tx. Ownership-checked:
   * an id belonging to another user reports `not_found`.
   */
  activateDefinition(
    tx: Transaction,
    userId: string,
    id: string,
  ): Promise<
    | { kind: "activated"; name: string; version: number }
    | { kind: "already_active"; name: string; version: number }
    | { kind: "not_found" }
  >;
}

export class DrizzlePipelineStore implements PipelineStore {
  async insertDefinition(
    tx: Transaction,
    params: {
      userId: string;
      name: string;
      sourceText: string;
      compiled: PipelineDefinition;
    },
  ): Promise<PipelineDefinitionRow> {
    const maxRows = await tx
      .select({ value: max(pipelineDefinitions.version) })
      .from(pipelineDefinitions)
      .where(
        and(
          eq(pipelineDefinitions.userId, params.userId),
          eq(pipelineDefinitions.name, params.name),
        ),
      );
    const version = (maxRows[0]?.value ?? 0) + 1;
    return single(
      await tx
        .insert(pipelineDefinitions)
        .values({
          userId: params.userId,
          name: params.name,
          version,
          sourceText: params.sourceText,
          compiled: params.compiled,
          active: false,
        })
        .returning(),
    );
  }

  async getDefinition(tx: Transaction, id: string): Promise<PipelineDefinitionRow | undefined> {
    const rows = await tx
      .select()
      .from(pipelineDefinitions)
      .where(eq(pipelineDefinitions.id, id))
      .limit(1);
    return rows[0];
  }

  async getDefinitionByName(
    tx: Transaction,
    userId: string,
    name: string,
    version?: number,
  ): Promise<PipelineDefinitionRow | undefined> {
    const conditions = [
      eq(pipelineDefinitions.userId, userId),
      eq(pipelineDefinitions.name, name),
      ...(version !== undefined ? [eq(pipelineDefinitions.version, version)] : []),
    ];
    const rows = await tx
      .select()
      .from(pipelineDefinitions)
      .where(and(...conditions))
      .orderBy(desc(pipelineDefinitions.version))
      .limit(1);
    return rows[0];
  }

  async getActiveDefinitionByName(
    tx: Transaction,
    userId: string,
    name: string,
  ): Promise<PipelineDefinitionRow | undefined> {
    const rows = await tx
      .select()
      .from(pipelineDefinitions)
      .where(
        and(
          eq(pipelineDefinitions.userId, userId),
          eq(pipelineDefinitions.name, name),
          eq(pipelineDefinitions.active, true),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async listDefinitions(
    tx: Transaction,
    userId: string,
  ): Promise<readonly PipelineDefinitionRow[]> {
    return tx
      .select()
      .from(pipelineDefinitions)
      .where(eq(pipelineDefinitions.userId, userId))
      .orderBy(pipelineDefinitions.name, desc(pipelineDefinitions.version));
  }

  async countDefinitions(tx: Transaction, userId: string): Promise<number> {
    const rows = await tx
      .select({ value: count() })
      .from(pipelineDefinitions)
      .where(eq(pipelineDefinitions.userId, userId));
    return rows[0]?.value ?? 0;
  }

  async activateDefinition(
    tx: Transaction,
    userId: string,
    id: string,
  ): Promise<
    | { kind: "activated"; name: string; version: number }
    | { kind: "already_active"; name: string; version: number }
    | { kind: "not_found" }
  > {
    // Advisory xact lock on (userId, name-space) so concurrent activations
    // of sibling versions serialize fully. A per-row FOR UPDATE is too
    // narrow here: two txs activating v1 and v2 lock different rows, and
    // the loser surfaces a non-retried 23505 from the partial unique index
    // instead of queueing. Advisory lock over SERIALIZABLE per
    // .claude/rules/store-pattern.md — this race wants prevention, not
    // retry-on-detection. Keyed on userId alone (not name) to avoid a
    // pre-lock read of the row's name; per-user serialization of
    // activations is more than fine at this scale.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
    const rows = await tx
      .select()
      .from(pipelineDefinitions)
      .where(and(eq(pipelineDefinitions.id, id), eq(pipelineDefinitions.userId, userId)))
      .limit(1)
      .for("update");
    const row = rows[0];
    if (!row) return { kind: "not_found" as const };
    if (row.active) {
      return { kind: "already_active" as const, name: row.name, version: row.version };
    }

    await tx
      .update(pipelineDefinitions)
      .set({ active: false })
      .where(
        and(
          eq(pipelineDefinitions.userId, userId),
          eq(pipelineDefinitions.name, row.name),
          eq(pipelineDefinitions.active, true),
        ),
      );
    await tx
      .update(pipelineDefinitions)
      .set({ active: true })
      .where(eq(pipelineDefinitions.id, id));
    return { kind: "activated" as const, name: row.name, version: row.version };
  }
}

// --- Runs ---

// Derived from the pgEnum so the enum stays the single source of truth — no
// hand-maintained union to drift from the DB type (architecture-rules: pgEnum
// → TypeScript union).
export type PipelineRunStatus = (typeof pipelineRunStatus.enumValues)[number];

const TERMINAL_RUN_STATUSES: ReadonlyArray<PipelineRunStatus> = [
  "completed",
  "failed",
  "cancelled",
] as const;

/** True when a run is in a state it will not transition out of. */
export function isTerminalPipelineRunStatus(status: PipelineRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export interface PipelineRunRow {
  id: string;
  definitionId: string;
  conversationId: string;
  status: PipelineRunStatus;
  currentStage: string;
  iteration: number;
  stageOutputs: StageOutputs;
  failureReason: string | null;
  createdAt: Date;
}

/** Conditional-transition result shared by the run store's status mutations. */
type RunTransition =
  | { kind: "transitioned" }
  | { kind: "stale"; status: PipelineRunStatus }
  | { kind: "not_found" };

/** Result of recording a stage output and moving the run forward. */
type RunAdvance =
  | { kind: "advanced" }
  | { kind: "stale"; currentStage: string; iteration: number }
  | { kind: "not_found" };

/**
 * Run-state access for the pipeline run engine. Separate interface from
 * {@link PipelineStore} (definitions) so the stage runner mocks a tight
 * surface — definitions and runs have different consumers (compiler/tools
 * vs. the orchestrator).
 */
export interface PipelineRunStore {
  /** Open a new run at `running`, iteration 0, no outputs, on `currentStage`. */
  createRun(
    tx: Transaction,
    params: { definitionId: string; conversationId: string; currentStage: string },
  ): Promise<PipelineRunRow>;

  getRun(tx: Transaction, id: string): Promise<PipelineRunRow | undefined>;

  /**
   * The live run supervising a conversation, if any. `handle-message` calls
   * this once per turn to decide whether the turn belongs to a pipeline
   * stage, so it reads through the partial unique index that also enforces
   * "at most one live run per conversation".
   */
  findActiveRunByConversation(
    tx: Transaction,
    conversationId: string,
  ): Promise<PipelineRunRow | undefined>;

  /**
   * Flip status conditionally (e.g. `running` → `waiting_gate` when a gate
   * parks). Conditional on `from` so a duplicate delivery is a no-op
   * `stale`.
   */
  transitionStatus(
    tx: Transaction,
    id: string,
    from: PipelineRunStatus,
    to: PipelineRunStatus,
  ): Promise<RunTransition>;

  /**
   * Record `output` for `fromStage` (when the stage declares one) and move
   * `current_stage` to `toStage` at `toIteration`, status back to `running`.
   * Conditional on the row sitting at `fromStage` — a retried persist that
   * already advanced returns `stale`.
   *
   * `toIteration` is the target stage's pass number. A forward move carries
   * the run's current pass unchanged; a backward move (a gate's `revise`,
   * and slice 3's loop back-edges) increments it, which keeps each entry's
   * idempotency keys — the synthetic inbound's above all — distinct from
   * the previous visit to that stage.
   */
  advanceStage(
    tx: Transaction,
    params: {
      runId: string;
      fromStage: string;
      fromIteration: number;
      output: StageArtifact | null;
      toStage: string;
      toIteration: number;
    },
  ): Promise<RunAdvance>;

  /** Record the final stage's `output` and mark the run `completed`. */
  completeRun(
    tx: Transaction,
    params: {
      runId: string;
      fromStage: string;
      fromIteration: number;
      output: StageArtifact | null;
    },
  ): Promise<RunAdvance>;

  /** Terminal failure from any non-terminal state. */
  failRun(
    tx: Transaction,
    id: string,
    reason: string,
  ): Promise<
    | { kind: "failed"; conversationId: string }
    | { kind: "already_terminal"; status: PipelineRunStatus }
    | { kind: "not_found" }
  >;

  /** Cancel if not already terminal (user/abort path). */
  cancelRunIfActive(
    tx: Transaction,
    id: string,
    reason: string,
  ): Promise<
    | { kind: "cancelled"; conversationId: string }
    | { kind: "already_terminal"; status: PipelineRunStatus }
    | { kind: "not_found" }
  >;
}

export class DrizzlePipelineRunStore implements PipelineRunStore {
  async createRun(
    tx: Transaction,
    params: { definitionId: string; conversationId: string; currentStage: string },
  ): Promise<PipelineRunRow> {
    return single(
      await tx
        .insert(pipelineRuns)
        .values({
          definitionId: params.definitionId,
          conversationId: params.conversationId,
          status: "running",
          currentStage: params.currentStage,
          iteration: 0,
          stageOutputs: {},
        })
        .returning(),
    );
  }

  async getRun(tx: Transaction, id: string): Promise<PipelineRunRow | undefined> {
    const rows = await tx.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)).limit(1);
    return rows[0];
  }

  async findActiveRunByConversation(
    tx: Transaction,
    conversationId: string,
  ): Promise<PipelineRunRow | undefined> {
    const rows = await tx
      .select()
      .from(pipelineRuns)
      .where(
        and(
          eq(pipelineRuns.conversationId, conversationId),
          notInArray(pipelineRuns.status, [...TERMINAL_RUN_STATUSES]),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async transitionStatus(
    tx: Transaction,
    id: string,
    from: PipelineRunStatus,
    to: PipelineRunStatus,
  ): Promise<RunTransition> {
    // `.for("update")` row-locks, and the terminal guard makes "terminal is
    // final" hold store-wide: a flip out of completed/failed/cancelled is
    // refused even if a caller passes a terminal `from`.
    const rows = await tx
      .select({ status: pipelineRuns.status })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, id))
      .limit(1)
      .for("update");
    const row = rows[0];
    if (!row) return { kind: "not_found" as const };
    if (isTerminalPipelineRunStatus(row.status) || row.status !== from) {
      return { kind: "stale" as const, status: row.status };
    }
    await tx.update(pipelineRuns).set({ status: to }).where(eq(pipelineRuns.id, id));
    return { kind: "transitioned" as const };
  }

  async advanceStage(
    tx: Transaction,
    params: {
      runId: string;
      fromStage: string;
      fromIteration: number;
      output: StageArtifact | null;
      toStage: string;
      toIteration: number;
    },
  ): Promise<RunAdvance> {
    return this.#recordAndMove(tx, params, () => ({
      currentStage: params.toStage,
      iteration: params.toIteration,
      status: "running" as const,
    }));
  }

  async completeRun(
    tx: Transaction,
    params: {
      runId: string;
      fromStage: string;
      fromIteration: number;
      output: StageArtifact | null;
    },
  ): Promise<RunAdvance> {
    // `current_stage` stays on the final stage — the run is terminal, so the
    // cursor's only remaining job is to point at what produced the result.
    return this.#recordAndMove(tx, params, (row) => ({
      currentStage: params.fromStage,
      iteration: row.iteration,
      status: "completed" as const,
    }));
  }

  /**
   * Shared read-merge-write for `advanceStage` / `completeRun`. `.for("update")`
   * row-locks so a duplicate delivery for the same run serializes; the
   * terminal-status and cursor guards make a retried persist idempotent. The
   * terminal guard matters because the terminal paths leave `current_stage`
   * untouched — without it, a stage.due replay that arrives after a
   * cancel/fail would match `fromStage` and resurrect the run.
   *
   * The cursor is `(current_stage, iteration)`, not the stage alone: a gate's
   * `revise` sends the run back to an earlier stage at the next iteration, so
   * a redelivered completion for that stage's previous pass must read as
   * stale rather than advancing the run a second time.
   */
  async #recordAndMove(
    tx: Transaction,
    at: { runId: string; fromStage: string; fromIteration: number; output: StageArtifact | null },
    move: (row: { iteration: number }) => {
      currentStage: string;
      iteration: number;
      status: PipelineRunStatus;
    },
  ): Promise<RunAdvance> {
    const rows = await tx
      .select({
        status: pipelineRuns.status,
        currentStage: pipelineRuns.currentStage,
        iteration: pipelineRuns.iteration,
        stageOutputs: pipelineRuns.stageOutputs,
      })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, at.runId))
      .limit(1)
      .for("update");
    const row = rows[0];
    if (!row) return { kind: "not_found" as const };
    if (
      isTerminalPipelineRunStatus(row.status) ||
      row.currentStage !== at.fromStage ||
      row.iteration !== at.fromIteration
    ) {
      return { kind: "stale" as const, currentStage: row.currentStage, iteration: row.iteration };
    }
    const stageOutputs =
      at.output === null ? row.stageOutputs : { ...row.stageOutputs, [at.fromStage]: at.output };
    const target = move(row);
    await tx
      .update(pipelineRuns)
      .set({
        stageOutputs,
        currentStage: target.currentStage,
        iteration: target.iteration,
        status: target.status,
      })
      .where(eq(pipelineRuns.id, at.runId));
    return { kind: "advanced" as const };
  }

  async failRun(
    tx: Transaction,
    id: string,
    reason: string,
  ): Promise<
    | { kind: "failed"; conversationId: string }
    | { kind: "already_terminal"; status: PipelineRunStatus }
    | { kind: "not_found" }
  > {
    return this.#terminate(tx, id, "failed", reason);
  }

  async cancelRunIfActive(
    tx: Transaction,
    id: string,
    reason: string,
  ): Promise<
    | { kind: "cancelled"; conversationId: string }
    | { kind: "already_terminal"; status: PipelineRunStatus }
    | { kind: "not_found" }
  > {
    const result = await this.#terminate(tx, id, "cancelled", reason);
    if (result.kind === "failed") {
      return { kind: "cancelled" as const, conversationId: result.conversationId };
    }
    return result;
  }

  /**
   * Move a non-terminal run to a terminal status with a reason. The race
   * between two concurrent terminations (cancel vs. abort) resolves through
   * the store's isolation contract: `.for("update")` blocks the second tx on
   * the row lock, then REPEATABLE READ raises a 40001 on it when the first
   * commits, and the transactor's one-shot retry re-reads the now-terminal
   * row and returns `already_terminal`. Returns `kind: "failed"` on success
   * regardless of target status — the public methods relabel.
   */
  async #terminate(
    tx: Transaction,
    id: string,
    status: "failed" | "cancelled",
    reason: string,
  ): Promise<
    | { kind: "failed"; conversationId: string }
    | { kind: "already_terminal"; status: PipelineRunStatus }
    | { kind: "not_found" }
  > {
    const rows = await tx
      .select({ status: pipelineRuns.status, conversationId: pipelineRuns.conversationId })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, id))
      .limit(1)
      .for("update");
    const row = rows[0];
    if (!row) return { kind: "not_found" as const };
    if (isTerminalPipelineRunStatus(row.status)) {
      return { kind: "already_terminal" as const, status: row.status };
    }
    await tx
      .update(pipelineRuns)
      .set({ status, failureReason: reason })
      .where(eq(pipelineRuns.id, id));
    return { kind: "failed" as const, conversationId: row.conversationId };
  }
}
