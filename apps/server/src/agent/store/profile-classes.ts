import { and, asc, count, eq } from "drizzle-orm";
import { err, type Result } from "neverthrow";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import { CANONICAL_NAME_RE } from "./canonical-name.js";
import {
  type CreateProfileClassError,
  inSavepoint,
  type ProfileClassInUse,
  referentialViolationAs,
  uniqueViolationAs,
} from "./errors.js";
import { profileClasses, profiles } from "./schema.js";

/** Per-user registry row for `profiles.profile_class`. */
export interface ProfileClass {
  id: string;
  userId: string;
  name: string;
  description: string;
  /**
   * When true, memories tagged `profile_class:<name>` are hidden from any
   * profile that doesn't explicitly opt the class into its
   * `memory_scope.profileClasses` (and that doesn't speak as the class
   * itself). Recall fail-closed for sensitive classes.
   */
  restricted: boolean;
  createdAt: Date;
}

/**
 * The `profile_classes` rows: the per-user registry of speaker-isolation
 * labels a profile may carry. Assigning one to a profile is
 * `ProfileStore.setProfileClass`.
 */
export interface ProfileClassStore {
  /** List the user's registered profile classes, ordered by name. */
  listProfileClasses(tx: Transaction, userId: string): Promise<ReadonlyArray<ProfileClass>>;

  /** Create a new profile class. The name must have the canonical shape (`CANONICAL_NAME_RE`). */
  createProfileClass(
    tx: Transaction,
    params: { userId: string; name: string; description: string },
  ): Promise<Result<ProfileClass, CreateProfileClassError>>;

  /**
   * Delete a profile class by name. `profile_class_in_use` if any of the
   * user's profiles still reference it via `profile_class`; `{ deleted: false }`
   * if no row matches.
   */
  deleteProfileClass(
    tx: Transaction,
    userId: string,
    name: string,
  ): Promise<Result<{ deleted: boolean }, ProfileClassInUse>>;

  /**
   * Flip the `restricted` flag on a profile class. Returns
   * `{ updated: false }` when no row matches the name (idempotent absence).
   * Independent of whether any profile currently references the class:
   * marking restricted while in use is the common case (an existing
   * `intimate` class becoming sensitive after the fact).
   */
  setProfileClassRestricted(
    tx: Transaction,
    userId: string,
    name: string,
    restricted: boolean,
  ): Promise<{ updated: boolean }>;
}

export class DrizzleProfileClassStore implements ProfileClassStore {
  async listProfileClasses(tx: Transaction, userId: string): Promise<ReadonlyArray<ProfileClass>> {
    const rows = await tx
      .select({
        id: profileClasses.id,
        userId: profileClasses.userId,
        name: profileClasses.name,
        description: profileClasses.description,
        restricted: profileClasses.restricted,
        createdAt: profileClasses.createdAt,
      })
      .from(profileClasses)
      .where(eq(profileClasses.userId, userId))
      .orderBy(asc(profileClasses.name));
    return rows;
  }

  async createProfileClass(
    tx: Transaction,
    params: { userId: string; name: string; description: string },
  ): Promise<Result<ProfileClass, CreateProfileClassError>> {
    if (!CANONICAL_NAME_RE.test(params.name)) {
      return err({ kind: "invalid_name", name: params.name, subject: "profile_class" });
    }
    return inSavepoint(tx, (sp) =>
      uniqueViolationAs(
        "uq_profile_classes_user_name",
        { kind: "profile_class_name_taken", name: params.name } as const,
        async () =>
          single(
            await sp.insert(profileClasses).values(params).returning({
              id: profileClasses.id,
              userId: profileClasses.userId,
              name: profileClasses.name,
              description: profileClasses.description,
              restricted: profileClasses.restricted,
              createdAt: profileClasses.createdAt,
            }),
          ),
      ),
    );
  }

  async setProfileClassRestricted(
    tx: Transaction,
    userId: string,
    name: string,
    restricted: boolean,
  ): Promise<{ updated: boolean }> {
    const updated = await tx
      .update(profileClasses)
      .set({ restricted })
      .where(and(eq(profileClasses.userId, userId), eq(profileClasses.name, name)))
      .returning({ id: profileClasses.id });
    return { updated: updated.length > 0 };
  }

  async deleteProfileClass(
    tx: Transaction,
    userId: string,
    name: string,
  ): Promise<Result<{ deleted: boolean }, ProfileClassInUse>> {
    // Atomicity comes from the composite FK on `profiles(user_id, profile_class)`
    // with ON DELETE RESTRICT — the DELETE fails at the DB level if any
    // profile still references this class, even when a concurrent
    // setProfileClass slipped its UPDATE in after our count. The count
    // below is informational only; a stale value is harmless because the
    // FK is the authoritative check.
    const refRows = await tx
      .select({ value: count() })
      .from(profiles)
      .where(and(eq(profiles.userId, userId), eq(profiles.profileClass, name)));
    const refCount = refRows[0]?.value ?? 0;
    // Defensive: under REPEATABLE READ a reference committed after this
    // snapshot fails the DELETE with 40001 rather than the FK, so when the FK
    // fires the count already saw the reference. The clamp keeps the report
    // consistent with the FK if that ever stops holding.
    const inUse = { kind: "profile_class_in_use", profileRefs: Math.max(refCount, 1) } as const;
    return inSavepoint(tx, (sp) =>
      referentialViolationAs("fk_profiles_profile_class", inUse, async () => {
        const deleted = await sp
          .delete(profileClasses)
          .where(and(eq(profileClasses.userId, userId), eq(profileClasses.name, name)))
          .returning({ id: profileClasses.id });
        return { deleted: deleted.length > 0 };
      }),
    );
  }
}
