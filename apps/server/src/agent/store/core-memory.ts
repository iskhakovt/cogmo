import { and, asc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Transaction } from "../../db/index.js";
import { IDENTITY_BLOCK_KEY, type ScopedCoreMemoryBlock } from "../core-memory/scope.js";
import { coreMemoryBlocks } from "./schema.js";

/** What `upsertCoreMemoryBlock` did to the block. */
export type CoreMemoryUpsertOutcome = "created" | "updated" | "unchanged";

/** The `core_memory_blocks` rows: a user's always-in-context blocks, per profile-class scope. */
export interface CoreMemoryStore {
  /**
   * The user's core memory blocks visible to one scope. `profileClass: null`
   * reads every NULL-class block in key order. A class reads the shared
   * `identity`, then the class's blocks: its `identity` override first, the
   * rest in key order.
   */
  getCoreMemoryBlocks(
    tx: Transaction,
    userId: string,
    profileClass: string | null,
  ): Promise<ReadonlyArray<ScopedCoreMemoryBlock>>;

  /**
   * Create or replace the block at `(userId, profileClass, key)`. Writing the
   * content it already holds leaves the row, `updated_at` included, as it was.
   */
  upsertCoreMemoryBlock(
    tx: Transaction,
    params: { userId: string; profileClass: string | null; key: string; content: string },
  ): Promise<CoreMemoryUpsertOutcome>;

  /** Delete the block at `(userId, profileClass, key)`, if any; true when one was deleted. */
  deleteCoreMemoryBlock(
    tx: Transaction,
    params: { userId: string; profileClass: string; key: string },
  ): Promise<boolean>;

  /** When each of the user's core memory blocks last changed, in every scope. */
  getCoreMemoryUpdateTimes(
    tx: Transaction,
    userId: string,
  ): Promise<ReadonlyArray<{ profileClass: string | null; key: string; updatedAt: Date }>>;

  /** The keys of one class's own blocks, in key order. */
  listCoreMemoryKeys(
    tx: Transaction,
    userId: string,
    profileClass: string,
  ): Promise<ReadonlyArray<string>>;
}

export class DrizzleCoreMemoryStore implements CoreMemoryStore {
  async getCoreMemoryBlocks(
    tx: Transaction,
    userId: string,
    profileClass: string | null,
  ): Promise<ReadonlyArray<ScopedCoreMemoryBlock>> {
    const columns = {
      profileClass: coreMemoryBlocks.profileClass,
      key: coreMemoryBlocks.key,
      content: coreMemoryBlocks.content,
    };
    if (profileClass === null) {
      return tx
        .select(columns)
        .from(coreMemoryBlocks)
        .where(and(eq(coreMemoryBlocks.userId, userId), isNull(coreMemoryBlocks.profileClass)))
        .orderBy(asc(coreMemoryBlocks.key));
    }
    return tx
      .select(columns)
      .from(coreMemoryBlocks)
      .where(
        and(
          eq(coreMemoryBlocks.userId, userId),
          or(
            and(
              isNull(coreMemoryBlocks.profileClass),
              eq(coreMemoryBlocks.key, IDENTITY_BLOCK_KEY),
            ),
            eq(coreMemoryBlocks.profileClass, profileClass),
          ),
        ),
      )
      .orderBy(
        asc(isNotNull(coreMemoryBlocks.profileClass)),
        asc(ne(coreMemoryBlocks.key, IDENTITY_BLOCK_KEY)),
        asc(coreMemoryBlocks.key),
      );
  }

  async upsertCoreMemoryBlock(
    tx: Transaction,
    params: { userId: string; profileClass: string | null; key: string; content: string },
  ): Promise<CoreMemoryUpsertOutcome> {
    const [row] = await tx
      .insert(coreMemoryBlocks)
      .values(params)
      .onConflictDoUpdate({
        target: [coreMemoryBlocks.userId, coreMemoryBlocks.profileClass, coreMemoryBlocks.key],
        // The database clock, which also times snapshots and turn contexts.
        set: { content: params.content, updatedAt: sql`now()` },
        setWhere: ne(coreMemoryBlocks.content, params.content),
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    if (row === undefined) return "unchanged";
    return row.inserted ? "created" : "updated";
  }

  async deleteCoreMemoryBlock(
    tx: Transaction,
    params: { userId: string; profileClass: string; key: string },
  ): Promise<boolean> {
    const deleted = await tx
      .delete(coreMemoryBlocks)
      .where(
        and(
          eq(coreMemoryBlocks.userId, params.userId),
          eq(coreMemoryBlocks.profileClass, params.profileClass),
          eq(coreMemoryBlocks.key, params.key),
        ),
      )
      .returning({ id: coreMemoryBlocks.id });
    return deleted.length > 0;
  }

  async getCoreMemoryUpdateTimes(
    tx: Transaction,
    userId: string,
  ): Promise<ReadonlyArray<{ profileClass: string | null; key: string; updatedAt: Date }>> {
    return tx
      .select({
        profileClass: coreMemoryBlocks.profileClass,
        key: coreMemoryBlocks.key,
        updatedAt: coreMemoryBlocks.updatedAt,
      })
      .from(coreMemoryBlocks)
      .where(eq(coreMemoryBlocks.userId, userId));
  }

  async listCoreMemoryKeys(
    tx: Transaction,
    userId: string,
    profileClass: string,
  ): Promise<ReadonlyArray<string>> {
    const rows = await tx
      .select({ key: coreMemoryBlocks.key })
      .from(coreMemoryBlocks)
      .where(
        and(eq(coreMemoryBlocks.userId, userId), eq(coreMemoryBlocks.profileClass, profileClass)),
      )
      .orderBy(asc(coreMemoryBlocks.key));
    return rows.map((r) => r.key);
  }
}
