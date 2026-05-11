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

/**
 * Thrown by `createCustomCompartment` when the user already has the maximum
 * number of custom compartments. Cap protects classifier accuracy + prompt
 * size; >~10 compartments degrades the LLM's bucket choice.
 */
export class CustomCompartmentCapExceededError extends Error {
  constructor(
    public readonly limit: number,
    public readonly current: number,
  ) {
    super(`custom compartment cap exceeded: ${current}/${limit}`);
    this.name = "CustomCompartmentCapExceededError";
  }
}

/**
 * Thrown when a profile-scope update / create references a compartment value
 * that's neither a core value nor one of the user's registered custom
 * compartments. Surfaced from Transport when the operator typo's a value or
 * forgets to `/compartments add` first. Carries the offending name so the
 * adapter can emit an actionable message.
 */
export class UnknownCompartmentError extends Error {
  constructor(public readonly compartmentName: string) {
    super(`unknown compartment: "${compartmentName}"`);
    this.name = "UnknownCompartmentError";
  }
}

/**
 * Thrown by `createCustomCompartment` / `createProfileClass` when the
 * proposed name doesn't match the canonical shape (lowercase ASCII +
 * `-`/`_`, ≤32 chars, must start with a letter). The constraint matches
 * the format of `CORE_COMPARTMENTS` values and avoids `Work` / `work`
 * conceptual duplicates, weird Unicode in tag values, or names that
 * render badly when templated into LLM prompts as `**<name>**:`.
 */
export class InvalidNameError extends Error {
  constructor(
    public readonly proposedName: string,
    public readonly kind: "compartment" | "profile_class",
  ) {
    super(
      `invalid ${kind} name "${proposedName}": must be lowercase ASCII letters/digits/hyphen/underscore, start with a letter, ≤32 chars`,
    );
    this.name = "InvalidNameError";
  }
}

/**
 * Thrown by `createCustomCompartment` when the proposed name collides with a
 * core compartment value (`personal`, `work`, …). Reserving the core names
 * keeps the merged classifier set unambiguous and prevents an operator from
 * shadowing a built-in bucket with a different definition.
 */
export class ReservedCompartmentNameError extends Error {
  constructor(public readonly compartmentName: string) {
    super(`compartment name "${compartmentName}" is reserved`);
    this.name = "ReservedCompartmentNameError";
  }
}

/**
 * Thrown by `createImageProvider` when the proposed config violates the
 * store-layer URL hygiene rules that the DB CHECK can't express (e.g.
 * `base_url` must be `https://`, must not have a trailing slash, must be
 * parseable as a URL). The DB CHECK pins the coarser invariant
 * (`openai_compatible` requires `base_url`, `fal` forbids it); this guard
 * adds the wizard-friendly details on top.
 *
 * Distinct from `UniqueViolationError` (name collision) and the raw
 * CHECK rejection that surfaces if a caller bypasses the store guard.
 */
export class InvalidProviderConfigError extends Error {
  constructor(public readonly reason: string) {
    super(`invalid provider config: ${reason}`);
    this.name = "InvalidProviderConfigError";
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
