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

interface PgUniqueViolation {
  code: "23505";
  constraint_name?: string;
  constraint?: string;
}

/**
 * Narrow an unknown error to a Postgres unique-violation shape. Walks `.cause` because Drizzle
 * wraps driver errors in `DrizzleQueryError` (`cause` holds the original postgres.js / PGlite error).
 */
export function findPostgresUniqueViolation(err: unknown): PgUniqueViolation | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur != null; depth++) {
    if (typeof cur === "object" && "code" in cur && (cur as { code: unknown }).code === "23505") {
      return cur as PgUniqueViolation;
    }
    if (typeof cur === "object" && "cause" in cur) {
      cur = (cur as { cause: unknown }).cause;
      continue;
    }
    break;
  }
  return null;
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
