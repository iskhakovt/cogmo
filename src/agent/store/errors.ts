/** Typed store errors. Thrown from DrizzleAgentStore; caught + mapped by Transport. */

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
      throw new UniqueViolationError(pg.constraint_name ?? pg.constraint ?? "unknown");
    }
    throw e;
  }
}
