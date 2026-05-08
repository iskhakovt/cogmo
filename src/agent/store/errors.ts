/** Typed store errors. Thrown from DrizzleAgentStore; caught + mapped by Transport. */

import { logger } from "../../logger.js";

/**
 * Postgres unique constraint violation (SQLSTATE 23505).
 * The constraint name lets callers distinguish between e.g. `uq_profiles_user_name` vs `uq_aliases_user_alias`.
 */
export class UniqueViolationError extends Error {
  readonly constraint: string;
  constructor(constraint: string) {
    super(`unique violation on constraint "${constraint}"`);
    this.name = "UniqueViolationError";
    this.constraint = constraint;
  }
}

/**
 * Thrown by `deleteProfile` when the profile is still referenced by at least one conversation
 * or message. Messages reference profiles via `messages.profile_id` for audit stamping —
 * once a profile has ever been used in a turn, it stays pinned until that history is deleted.
 * Transport catches this and surfaces `profile_in_use`.
 */
export class ProfileInUseError extends Error {
  constructor(
    public readonly conversationRefs: number,
    public readonly messageRefs: number,
  ) {
    super(
      `profile in use: ${conversationRefs} conversation(s), ${messageRefs} message(s) reference it`,
    );
    this.name = "ProfileInUseError";
  }
}

/**
 * Thrown by `deleteProfileClass` when at least one profile still references
 * the class via `profiles.profile_class`. The caller must clear the
 * references (or reassign the profiles to a different class) before the
 * class can be deleted. Transport surfaces this as `profile_class_in_use`.
 */
export class ProfileClassInUseError extends Error {
  constructor(public readonly profileRefs: number) {
    super(`profile class in use: ${profileRefs} profile(s) reference it`);
    this.name = "ProfileClassInUseError";
  }
}

/**
 * Thrown by `setProfileClass` and any other call that assigns a class name
 * to a profile (or scopes a profile against a list of class names) when the
 * referenced class is not registered for the profile's user. Transport
 * surfaces this as `unknown_profile_class`.
 */
export class UnknownProfileClassError extends Error {
  constructor(public readonly className: string) {
    super(`unknown profile class: "${className}"`);
    this.name = "UnknownProfileClassError";
  }
}

interface PgUniqueViolation {
  code: "23505";
  constraint_name?: string;
  constraint?: string;
}

interface PgForeignKeyViolation {
  code: "23503";
  constraint_name?: string;
  constraint?: string;
}

/**
 * Walk `err.cause` looking for a Postgres error matching `code`. Drizzle
 * wraps driver errors in `DrizzleQueryError` whose `cause` holds the
 * original postgres.js / PGlite error; we walk a few levels to reach it.
 */
function findPgErrorByCode(
  err: unknown,
  code: string,
): { constraint?: string; constraint_name?: string } | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur != null; depth++) {
    if (typeof cur === "object" && "code" in cur && (cur as { code: unknown }).code === code) {
      return cur as { constraint?: string; constraint_name?: string };
    }
    if (typeof cur === "object" && "cause" in cur) {
      cur = (cur as { cause: unknown }).cause;
      continue;
    }
    break;
  }
  return null;
}

/** Narrow an unknown error to a Postgres unique-violation shape. */
export function findPostgresUniqueViolation(err: unknown): PgUniqueViolation | null {
  const found = findPgErrorByCode(err, "23505");
  return found ? ({ code: "23505", ...found } as PgUniqueViolation) : null;
}

/** Narrow an unknown error to a Postgres foreign-key-violation shape. */
export function findPostgresForeignKeyViolation(err: unknown): PgForeignKeyViolation | null {
  const found = findPgErrorByCode(err, "23503");
  return found ? ({ code: "23503", ...found } as PgForeignKeyViolation) : null;
}

function constraintNameOf(pg: { constraint_name?: string; constraint?: string }): string {
  return pg.constraint_name ?? pg.constraint ?? "unknown";
}

/** Wrap a block and convert Postgres unique violations to `UniqueViolationError`. */
export async function translateUniqueViolation<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const pg = findPostgresUniqueViolation(e);
    if (pg) {
      const constraint = pg.constraint_name ?? pg.constraint;
      if (!constraint) {
        // Shouldn't normally fire — postgres-js + PGlite both populate `constraint` on 23505.
        // If this warns in prod, our driver-error walker is missing a new wrapper shape and
        // downstream Transport mapping silently degrades to generic errors. Investigate.
        logger.warn(
          { err: e },
          "translateUniqueViolation: 23505 without constraint name — update findPostgresUniqueViolation",
        );
      }
      throw new UniqueViolationError(constraint ?? "unknown");
    }
    throw e;
  }
}

/**
 * Wrap a block and convert Postgres FK violations on `constraintName` to
 * the supplied error. Other FK violations and non-FK errors propagate
 * unchanged. Used to translate composite-FK enforcement on
 * `(profiles.user_id, profiles.profile_class)` into the typed
 * `UnknownProfileClassError` / `ProfileClassInUseError`.
 */
export async function translateForeignKeyViolation<T>(
  fn: () => Promise<T>,
  match: { constraintName: string; rethrow: () => Error },
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const pg = findPostgresForeignKeyViolation(e);
    if (pg && constraintNameOf(pg) === match.constraintName) {
      throw match.rethrow();
    }
    throw e;
  }
}
