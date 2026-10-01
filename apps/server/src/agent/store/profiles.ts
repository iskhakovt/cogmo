import { asc, count, eq, isNull, or, sql } from "drizzle-orm";
import { err, ok, type Result } from "neverthrow";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import { skills } from "../../skills/store/schema.js";
import type { AutoRecallMode } from "../recall-gate.js";
import {
  inSavepoint,
  type ProfileInUse,
  type ProfileNameTaken,
  referentialViolationAs,
  type UnknownProfileClass,
  uniqueViolationAs,
} from "./errors.js";
import {
  conversations,
  messages,
  type ProfileMemoryScope,
  profiles,
  scheduledTasks,
  steeringRules,
  type ToolSet,
} from "./schema.js";

/** Voice mode preference. Mirrors the `voice_mode` pgEnum exactly. */
export type VoiceMode = "auto" | "always" | "never";

export interface Profile {
  id: string;
  userId: string | null; // null = org profile (read-only via Transport)
  name: string;
  basePrompt: string;
  model: string;
  summarizationModel: string | null;
  extractionModel: string | null;
  autoRecall: AutoRecallMode;
  /** Profile-level voice mode default; overridden per-conversation. */
  voiceMode: VoiceMode;
  toolSet: ToolSet;
  memoryScope: ProfileMemoryScope | null; // null = no compartment/trust/class restriction
  /** Speaker-isolation label; null = unclassed (Observer emits no class tag). */
  profileClass: string | null;
  /**
   * Soft cap on a single outbound message's source-text length before the
   * streaming adapter rotates to a new message. Lower for short-burst UX.
   */
  streamChunkChars: number;
  /**
   * When false, the streaming adapter never edits a message mid-stream — it
   * only emits whole chunks on boundary / finish, drops tool/status banners,
   * and falls back to a native typing indicator while in flight.
   */
  streamEdits: boolean;
  /**
   * When `on`, the plan orchestrator auto-stamps `plan_approved_at` and
   * emits `coding/task/plan-approved` once the plan text is persisted,
   * skipping the Telegram approve/revise/cancel round trip. The plan
   * still streams to Telegram for visibility. Default `off`. Toggled via
   * `/profile autoapprove`.
   */
  codingAutoapproveMode: CodingAutoapproveMode;
}

export type CodingAutoapproveMode = "off" | "on";

export interface ProfileUpdates {
  name?: string;
  basePrompt?: string;
  model?: string;
  summarizationModel?: string | null;
  extractionModel?: string | null;
  autoRecall?: AutoRecallMode;
  voiceMode?: VoiceMode;
  toolSet?: ToolSet;
  memoryScope?: ProfileMemoryScope | null;
  streamChunkChars?: number;
  streamEdits?: boolean;
  codingAutoapproveMode?: CodingAutoapproveMode;
}

/**
 * The `profiles` rows: a persona's prompt, model, tools, memory scope and
 * presentation knobs, owned by a user or by the org.
 */
export interface ProfileStore {
  /** Load a profile by ID. */
  getProfile(tx: Transaction, profileId: string): Promise<Profile | undefined>;

  /** The oldest profile by `id`: the org profile setup seeds. */
  getDefaultProfile(tx: Transaction): Promise<{ id: string } | undefined>;

  /** Create a profile and return the full row. `userId: null` = org profile (read-only via Transport); `userId: <id>` = user profile (owned by that user). */
  createProfile(
    tx: Transaction,
    params: {
      userId: string | null;
      name: string;
      basePrompt: string;
      model: string;
      toolSet: ToolSet;
      memoryScope?: ProfileMemoryScope | null;
    },
  ): Promise<Result<Profile, ProfileNameTaken>>;

  /**
   * Keyed insert on `uq_profiles_user_name` (`.claude/rules/inngest.md`): a
   * repeated `(userId, name)`, including `userId: null`, returns the stored
   * profile's id as `recovered`, leaving the row as it was.
   */
  insertOrRecoverProfile(
    tx: Transaction,
    params: {
      userId: string | null;
      name: string;
      basePrompt: string;
      model: string;
      toolSet: ToolSet;
    },
  ): Promise<{ kind: "new" | "recovered"; id: string }>;

  /** List profiles visible to `userId`: org profiles (user_id IS NULL) + the user's own profiles. */
  listProfiles(tx: Transaction, userId: string): Promise<ReadonlyArray<Profile>>;

  /** Return ownership info for a profile, or `undefined` if the profile doesn't exist. The inner `userId: null` means "org profile" — that's a real value stored in the row, distinct from "row not found". */
  getProfileOwner(
    tx: Transaction,
    profileId: string,
  ): Promise<{ userId: string | null } | undefined>;

  /** Update a profile in place. Caller must verify ownership. */
  updateProfile(
    tx: Transaction,
    profileId: string,
    changes: ProfileUpdates,
  ): Promise<Result<Profile, ProfileNameTaken>>;

  /**
   * Count live references to a profile — active conversations + stamped message history.
   * Useful for UX (warn before delete). `deleteProfile` performs the authoritative check-in-tx.
   */
  countProfileReferences(
    tx: Transaction,
    profileId: string,
  ): Promise<{ conversations: number; messages: number }>;

  /**
   * Delete a profile atomically: checks `conversations`, `messages`, the schedules that run as
   * it (`scheduled_tasks`, `skills.run_as_profile_id`) and the steering rules scoped to it inside
   * the same transaction and deletes nothing if any exist. Historical messages pin the profile as audit data — a
   * profile that has ever been used in a turn stays undeletable.
   */
  deleteProfile(tx: Transaction, profileId: string): Promise<Result<void, ProfileInUse>>;

  /**
   * Set or clear a profile's `profile_class`. `className: null` clears it.
   * A non-null `className` must be registered for the profile's user, and
   * org profiles (`user_id IS NULL`) can't be classed: either way the result
   * is `unknown_profile_class`.
   */
  setProfileClass(
    tx: Transaction,
    profileId: string,
    className: string | null,
  ): Promise<Result<void, UnknownProfileClass>>;
}

/** The `profiles` columns a `Profile` carries. */
const PROFILE_COLUMNS = {
  id: profiles.id,
  userId: profiles.userId,
  name: profiles.name,
  basePrompt: profiles.basePrompt,
  model: profiles.model,
  summarizationModel: profiles.summarizationModel,
  extractionModel: profiles.extractionModel,
  autoRecall: profiles.autoRecall,
  voiceMode: profiles.voiceMode,
  toolSet: profiles.toolSet,
  memoryScope: profiles.memoryScope,
  profileClass: profiles.profileClass,
  streamChunkChars: profiles.streamChunkChars,
  streamEdits: profiles.streamEdits,
  codingAutoapproveMode: profiles.codingAutoapproveMode,
};

export class DrizzleProfileStore implements ProfileStore {
  async getProfile(tx: Transaction, profileId: string): Promise<Profile | undefined> {
    const rows = await tx
      .select(PROFILE_COLUMNS)
      .from(profiles)
      .where(eq(profiles.id, profileId))
      .limit(1);
    return rows[0];
  }

  async getDefaultProfile(tx: Transaction): Promise<{ id: string } | undefined> {
    const rows = await tx
      .select({ id: profiles.id })
      .from(profiles)
      .orderBy(asc(profiles.id))
      .limit(1);
    return rows[0];
  }

  async createProfile(
    tx: Transaction,
    params: {
      userId: string | null;
      name: string;
      basePrompt: string;
      model: string;
      toolSet: ToolSet;
      memoryScope?: ProfileMemoryScope | null;
    },
  ): Promise<Result<Profile, ProfileNameTaken>> {
    return inSavepoint(tx, (sp) =>
      uniqueViolationAs(
        "uq_profiles_user_name",
        { kind: "profile_name_taken" } as const,
        async () => single(await sp.insert(profiles).values(params).returning(PROFILE_COLUMNS)),
      ),
    );
  }

  async insertOrRecoverProfile(
    tx: Transaction,
    params: {
      userId: string | null;
      name: string;
      basePrompt: string;
      model: string;
      toolSet: ToolSet;
    },
  ): Promise<{ kind: "new" | "recovered"; id: string }> {
    // Keyed insert: see `.claude/rules/inngest.md`.
    const rows = await tx
      .insert(profiles)
      .values(params)
      .onConflictDoUpdate({ target: [profiles.userId, profiles.name], set: { name: params.name } })
      .returning({ id: profiles.id, inserted: sql<boolean>`(xmax = 0)` });
    const { id, inserted } = single(rows);
    return { kind: inserted ? "new" : "recovered", id };
  }

  async listProfiles(tx: Transaction, userId: string): Promise<ReadonlyArray<Profile>> {
    const rows = await tx
      .select(PROFILE_COLUMNS)
      .from(profiles)
      .where(or(isNull(profiles.userId), eq(profiles.userId, userId)))
      .orderBy(asc(profiles.name));
    return rows;
  }

  async getProfileOwner(
    tx: Transaction,
    profileId: string,
  ): Promise<{ userId: string | null } | undefined> {
    const rows = await tx
      .select({ userId: profiles.userId })
      .from(profiles)
      .where(eq(profiles.id, profileId))
      .limit(1);
    return rows[0];
  }

  async updateProfile(
    tx: Transaction,
    profileId: string,
    changes: ProfileUpdates,
  ): Promise<Result<Profile, ProfileNameTaken>> {
    return inSavepoint(tx, (sp) =>
      uniqueViolationAs(
        "uq_profiles_user_name",
        { kind: "profile_name_taken" } as const,
        async () =>
          single(
            await sp
              .update(profiles)
              .set(changes)
              .where(eq(profiles.id, profileId))
              .returning(PROFILE_COLUMNS),
          ),
      ),
    );
  }

  async countProfileReferences(
    tx: Transaction,
    profileId: string,
  ): Promise<{ conversations: number; messages: number }> {
    const [convRows, msgRows] = await Promise.all([
      tx
        .select({ value: count() })
        .from(conversations)
        .where(eq(conversations.profileId, profileId)),
      tx.select({ value: count() }).from(messages).where(eq(messages.profileId, profileId)),
    ]);
    return {
      conversations: convRows[0]?.value ?? 0,
      messages: msgRows[0]?.value ?? 0,
    };
  }

  async deleteProfile(tx: Transaction, profileId: string): Promise<Result<void, ProfileInUse>> {
    // Refs are counted in the caller's transaction, so the count and the delete
    // read one snapshot.
    const [convRows, msgRows, taskRows, skillRows, ruleRows] = await Promise.all([
      tx
        .select({ value: count() })
        .from(conversations)
        .where(eq(conversations.profileId, profileId)),
      tx.select({ value: count() }).from(messages).where(eq(messages.profileId, profileId)),
      tx
        .select({ value: count() })
        .from(scheduledTasks)
        .where(eq(scheduledTasks.profileId, profileId)),
      tx.select({ value: count() }).from(skills).where(eq(skills.runAsProfileId, profileId)),
      tx
        .select({ value: count() })
        .from(steeringRules)
        .where(eq(steeringRules.profileId, profileId)),
    ]);
    const refRows = [convRows, msgRows, taskRows, skillRows, ruleRows];
    if (refRows.some((rows) => (rows[0]?.value ?? 0) > 0)) return err({ kind: "profile_in_use" });
    await tx.delete(profiles).where(eq(profiles.id, profileId));
    return ok(undefined);
  }

  async setProfileClass(
    tx: Transaction,
    profileId: string,
    className: string | null,
  ): Promise<Result<void, UnknownProfileClass>> {
    if (className === null) {
      await tx.update(profiles).set({ profileClass: null }).where(eq(profiles.id, profileId));
      return ok(undefined);
    }
    const unknown = { kind: "unknown_profile_class", name: className } as const;
    // Composite FK with MATCH SIMPLE skips its check when either column is
    // NULL — so for org profiles (user_id IS NULL) the FK would silently
    // allow any class name. Reject org-profile classing here so the
    // contract holds for that path too.
    const owner = await tx
      .select({ userId: profiles.userId })
      .from(profiles)
      .where(eq(profiles.id, profileId))
      .limit(1);
    const found = owner[0];
    if (!found || found.userId === null) return err(unknown);
    // For non-org profiles, the FK is the authoritative check: an unknown
    // class name surfaces as a 23503 on `fk_profiles_profile_class`.
    // Concurrent deleteProfileClass landing between this UPDATE and
    // commit fails the same way, so stale-snapshot races can't leave a
    // dangling pointer.
    return inSavepoint(tx, (sp) =>
      referentialViolationAs("fk_profiles_profile_class", unknown, async () => {
        await sp
          .update(profiles)
          .set({ profileClass: className })
          .where(eq(profiles.id, profileId));
      }),
    );
  }
}
