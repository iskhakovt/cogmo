import { and, count, desc, eq, max, sql } from "drizzle-orm";
import { single } from "../../../db/helpers.js";
import type { Transaction } from "../../../db/index.js";
import type { PipelineDefinition } from "../types.js";
import { pipelineDefinitions } from "./schema.js";

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
