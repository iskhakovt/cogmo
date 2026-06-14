import { and, count, desc, eq, max, sql } from "drizzle-orm";
import { single } from "../../../db/helpers.js";
import type { Transaction } from "../../../db/index.js";
import type { StageArtifact, StageOutputs } from "../run-types.js";
import type { PipelineDefinition } from "../types.js";
import { pipelineDefinitions, pipelineRuns } from "./schema.js";

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

export type PipelineRunStatus =
  | "queued"
  | "running"
  | "waiting_gate"
  | "waiting_event"
  | "completed"
  | "failed"
  | "cancelled";

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
  | { kind: "stale"; currentStage: string }
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
   * Flip status conditionally (e.g. `running` → `waiting_gate` before a
   * gate's `step.waitForEvent`, then back on resume). Conditional on `from`
   * so a duplicate delivery is a no-op `stale`.
   */
  transitionStatus(
    tx: Transaction,
    id: string,
    from: PipelineRunStatus,
    to: PipelineRunStatus,
  ): Promise<RunTransition>;

  /**
   * Record `output` for `fromStage` (when the stage declares one) and move
   * `current_stage` to `toStage`, status back to `running`. Conditional on
   * the row sitting at `fromStage` — a retried persist that already advanced
   * returns `stale`.
   */
  advanceStage(
    tx: Transaction,
    params: {
      runId: string;
      fromStage: string;
      output: StageArtifact | null;
      toStage: string;
    },
  ): Promise<RunAdvance>;

  /** Record the final stage's `output` and mark the run `completed`. */
  completeRun(
    tx: Transaction,
    params: { runId: string; fromStage: string; output: StageArtifact | null },
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

  async transitionStatus(
    tx: Transaction,
    id: string,
    from: PipelineRunStatus,
    to: PipelineRunStatus,
  ): Promise<RunTransition> {
    const updated = await tx
      .update(pipelineRuns)
      .set({ status: to })
      .where(and(eq(pipelineRuns.id, id), eq(pipelineRuns.status, from)))
      .returning({ id: pipelineRuns.id });
    if (updated.length > 0) return { kind: "transitioned" as const };

    const rows = await tx
      .select({ status: pipelineRuns.status })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return { kind: "not_found" as const };
    return { kind: "stale" as const, status: row.status };
  }

  async advanceStage(
    tx: Transaction,
    params: {
      runId: string;
      fromStage: string;
      output: StageArtifact | null;
      toStage: string;
    },
  ): Promise<RunAdvance> {
    return this.#recordAndMove(tx, params.runId, params.fromStage, params.output, {
      currentStage: params.toStage,
      status: "running",
    });
  }

  async completeRun(
    tx: Transaction,
    params: { runId: string; fromStage: string; output: StageArtifact | null },
  ): Promise<RunAdvance> {
    // `current_stage` stays on the final stage — the run is terminal, so the
    // cursor's only remaining job is to point at what produced the result.
    return this.#recordAndMove(tx, params.runId, params.fromStage, params.output, {
      currentStage: params.fromStage,
      status: "completed",
    });
  }

  /**
   * Shared read-merge-write for `advanceStage` / `completeRun`. `.for("update")`
   * row-locks so a duplicate delivery for the same run serializes; the
   * `current_stage === fromStage` guard makes a retried persist idempotent.
   */
  async #recordAndMove(
    tx: Transaction,
    runId: string,
    fromStage: string,
    output: StageArtifact | null,
    move: { currentStage: string; status: PipelineRunStatus },
  ): Promise<RunAdvance> {
    const rows = await tx
      .select({ currentStage: pipelineRuns.currentStage, stageOutputs: pipelineRuns.stageOutputs })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId))
      .limit(1)
      .for("update");
    const row = rows[0];
    if (!row) return { kind: "not_found" as const };
    if (row.currentStage !== fromStage) {
      return { kind: "stale" as const, currentStage: row.currentStage };
    }
    const stageOutputs =
      output === null ? row.stageOutputs : { ...row.stageOutputs, [fromStage]: output };
    await tx
      .update(pipelineRuns)
      .set({ stageOutputs, currentStage: move.currentStage, status: move.status })
      .where(eq(pipelineRuns.id, runId));
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
   * Move a non-terminal run to a terminal status with a reason. `.for("update")`
   * so two concurrent terminations (cancel racing an abort) can't both win.
   * Returns `kind: "failed"` on success regardless of target status — the
   * public methods relabel.
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
