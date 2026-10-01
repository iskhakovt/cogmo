import { and, asc, count, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as R from "remeda";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import { pendingMemories, profiles } from "./schema.js";

/** Mirrors the `pending_memory_source` PG enum. */
export type PendingMemorySource = "live_retain" | "migration" | "skill";

/** The sources that name no skill. */
export type UnnamedMemorySource = Exclude<PendingMemorySource, "skill">;

/** A skill's write: a `skill` row names its skill. */
export interface SkillMemoryOrigin {
  source: "skill";
  skillName: string;
}

/**
 * Who staged a pending row. Only a `skill` row names a skill
 * (`chk_pending_memories_skill_name`).
 */
export type PendingMemoryOrigin = { source: UnnamedMemorySource } | SkillMemoryOrigin;

/**
 * A memory write awaiting Observer classification before retention to
 * Hindsight. `profileClass` is denormalised onto the row at read time via
 * a JOIN on `profiles` so the drain can stamp the correct
 * `profile_class:<class>` tag without having to look up the profile per
 * row (or worse, per-row group). `null` when either the staging profile
 * was unclassed or the lineage isn't available — pre-feature live
 * retains, migration backfill, or rows whose staging profile was deleted
 * (`profile_id` SET NULL). `profileId` is the staging profile, whose
 * `memory`-category rules the drain applies; null where it has none or it
 * belongs to another user.
 * `skillName` names the staging skill on a `skill` row and is null otherwise.
 */
export interface PendingMemory {
  id: string;
  content: string;
  context: string | null;
  source: PendingMemorySource;
  profileId: string | null;
  profileClass: string | null;
  skillName: string | null;
  createdAt: Date;
}

/** Which of a user's pending rows a read takes. */
export interface PendingMemoryFilter {
  /** Only rows staged by this profile. */
  stagedBy?: string;
  /** Only rows of these sources. */
  sources?: ReadonlyArray<PendingMemorySource>;
  /** Only these rows. */
  ids?: ReadonlyArray<string>;
}

/** A user's pending rows, narrowed by `filter`. */
function pendingRowsOf(userId: string, filter: PendingMemoryFilter | undefined): SQL | undefined {
  return and(
    eq(pendingMemories.userId, userId),
    filter?.stagedBy === undefined ? undefined : eq(pendingMemories.profileId, filter.stagedBy),
    filter?.sources === undefined
      ? undefined
      : inArray(pendingMemories.source, [...filter.sources]),
    filter?.ids === undefined ? undefined : inArray(pendingMemories.id, [...filter.ids]),
  );
}

/** The `pending_memories` rows: memory writes staged for Observer classification. */
export interface PendingMemoryStore {
  /**
   * Insert a single row into the staging table. Returns the new row id.
   *
   * `profileId` snapshots which profile staged the row so the Observer
   * drain stamps the correct `profile_class:<class>` tag at retain
   * time. Pass `null` for non-conversational stages (the migration
   * backfill loop) where there's no staging profile. A `skill` row names
   * its skill in `skillName`, and no other source carries one
   * (`chk_pending_memories_skill_name`).
   */
  stagePendingMemory(
    tx: Transaction,
    params: {
      userId: string;
      profileId: string | null;
      content: string;
      context?: string;
    } & PendingMemoryOrigin,
  ): Promise<{ id: string }>;

  /**
   * Bulk insert via a single statement. Used by the migration script to
   * stage thousands of rows in one round-trip. `profileId` is null on
   * every row — the migration script has no per-row profile lineage.
   */
  bulkStagePendingMemories(
    tx: Transaction,
    rows: ReadonlyArray<{
      userId: string;
      content: string;
      context?: string;
      source: UnnamedMemorySource;
    }>,
  ): Promise<void>;

  /**
   * Read pending rows for a user, oldest first (FIFO drain order).
   *
   * `limit` caps the result size — callers running inside an Inngest step
   * pass a bounded value so the row payload never exceeds the run-state
   * size limit. Omit to read every pending row (tests, ad-hoc tooling).
   * `filter` narrows the rows before the limit applies.
   */
  getPendingMemories(
    tx: Transaction,
    userId: string,
    limit?: number,
    filter?: PendingMemoryFilter,
  ): Promise<ReadonlyArray<PendingMemory>>;

  /** Count a user's pending rows, `filter` narrowing them as `getPendingMemories` does. */
  countPendingMemories(
    tx: Transaction,
    userId: string,
    filter?: PendingMemoryFilter,
  ): Promise<number>;

  /** Delete pending rows by id. Used by the Observer drain step after successful retain. */
  deletePendingMemories(tx: Transaction, ids: ReadonlyArray<string>): Promise<void>;
}

export class DrizzlePendingMemoryStore implements PendingMemoryStore {
  async stagePendingMemory(
    tx: Transaction,
    params: {
      userId: string;
      profileId: string | null;
      content: string;
      context?: string;
    } & PendingMemoryOrigin,
  ): Promise<{ id: string }> {
    return single(
      await tx
        .insert(pendingMemories)
        .values({
          userId: params.userId,
          profileId: params.profileId,
          content: params.content,
          context: params.context ?? null,
          source: params.source,
          skillName: params.source === "skill" ? params.skillName : null,
        })
        .returning({ id: pendingMemories.id }),
    );
  }

  async bulkStagePendingMemories(
    tx: Transaction,
    rows: ReadonlyArray<{
      userId: string;
      content: string;
      context?: string;
      source: UnnamedMemorySource;
    }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    // Postgres caps a single statement at 65,535 placeholders. Each row
    // binds 5 columns (profile_id is always null on this path — the
    // migration script has no per-row profile lineage); chunking at 5,000
    // stays well under the cap (and atomicity is preserved by the
    // surrounding transaction).
    for (const chunk of R.chunk([...rows], 5000)) {
      await tx.insert(pendingMemories).values(
        chunk.map((r) => ({
          userId: r.userId,
          profileId: null,
          content: r.content,
          context: r.context ?? null,
          source: r.source,
        })),
      );
    }
  }

  async countPendingMemories(
    tx: Transaction,
    userId: string,
    filter?: PendingMemoryFilter,
  ): Promise<number> {
    const rows = await tx
      .select({ value: count() })
      .from(pendingMemories)
      .where(pendingRowsOf(userId, filter));
    return rows[0]?.value ?? 0;
  }

  async getPendingMemories(
    tx: Transaction,
    userId: string,
    limit?: number,
    filter?: PendingMemoryFilter,
  ): Promise<ReadonlyArray<PendingMemory>> {
    const stagingProfiles = alias(profiles, "staging_profiles");
    // LEFT JOIN onto profiles so we surface the staging profile's CURRENT
    // class on each row at drain time. LEFT (not INNER) so rows whose
    // profile was deleted (`profile_id` SET NULL) or never had one
    // (migration backfill) still drain — they just stamp untagged on the
    // class dimension. Reading the profile's current class (rather than
    // a staging-time snapshot) means renaming a class re-flows all of
    // the user's pending rows under the new name without a backfill.
    const base = tx
      .select({
        id: pendingMemories.id,
        content: pendingMemories.content,
        context: pendingMemories.context,
        source: pendingMemories.source,
        profileId: stagingProfiles.id,
        profileClass: profiles.profileClass,
        skillName: pendingMemories.skillName,
        createdAt: pendingMemories.createdAt,
      })
      .from(pendingMemories)
      // The staging profile whose memory rules the drain applies: the user's
      // own or an org profile (`user_id` NULL), never another user's. An org
      // profile has no class, so the class join below keeps to the user's own.
      .leftJoin(
        stagingProfiles,
        and(
          eq(stagingProfiles.id, pendingMemories.profileId),
          or(isNull(stagingProfiles.userId), eq(stagingProfiles.userId, pendingMemories.userId)),
        ),
      )
      // Defence in depth on the join: require the joined profile to
      // belong to the SAME user as the pending row. The FK on
      // `pending_memories.profile_id → profiles.id` doesn't enforce
      // user ownership (profiles.user_id is independent), so if a row
      // ever drifts (manual SQL, future bug, data corruption) and
      // points to another user's profile, we'd otherwise surface that
      // user's `profile_class` here and leak across the speaker
      // boundary at retain time. With the second predicate, a
      // mismatched row falls back to NULL on the join and stamps
      // untagged on the class dimension.
      .leftJoin(
        profiles,
        and(
          eq(profiles.id, pendingMemories.profileId),
          eq(profiles.userId, pendingMemories.userId),
        ),
      )
      .where(pendingRowsOf(userId, filter))
      // Secondary sort by id breaks createdAt ties — bulk inserts share a
      // timestamp, but UUIDv7 ids are time-ordered, so the tiebreak preserves
      // insertion order for callers that care (drain FIFO, tests).
      .orderBy(asc(pendingMemories.createdAt), asc(pendingMemories.id));
    return limit !== undefined ? await base.limit(limit) : await base;
  }

  async deletePendingMemories(tx: Transaction, ids: ReadonlyArray<string>): Promise<void> {
    if (ids.length === 0) return;
    await tx.delete(pendingMemories).where(inArray(pendingMemories.id, [...ids]));
  }
}
