/**
 * Expected failures of `AgentStore` writes, returned as the `Err` of a
 * `Result`, and the Postgres-error translation that produces them.
 *
 * A store method that returns one of these has left the caller's transaction
 * as it found it: the write runs in a savepoint (`inSavepoint`), so neither a
 * half-applied change nor an aborted transaction outlives the `Err`.
 */

import { err, ok, type Result } from "neverthrow";
import { constraintNameOf, findPgErrorByCode, type PgError } from "../../db/pg-errors.js";
import { commitIfOk, type Transaction } from "../../db/transactor.js";

/** A name that isn't lowercase ASCII letters/digits/`-`/`_`, letter-led, ≤32 chars. */
export interface InvalidName {
  kind: "invalid_name";
  name: string;
  subject: "compartment" | "profile_class" | "sub_agent";
}

/** `(user_id, name)` is taken on a profile write. */
export interface ProfileNameTaken {
  kind: "profile_name_taken";
}

/**
 * `deleteProfile` found references: conversations, messages (audit stamps
 * that pin the profile for as long as the history exists), schedules that run
 * as it (`scheduled_tasks.profile_id`, `skills.run_as_profile_id`), or steering
 * rules scoped to it.
 */
export interface ProfileInUse {
  kind: "profile_in_use";
  refs: { conversations: number; messages: number; schedules: number; steeringRules: number };
}

export interface ProfileClassNameTaken {
  kind: "profile_class_name_taken";
  name: string;
}

/** At least one of the user's profiles still references the class. */
export interface ProfileClassInUse {
  kind: "profile_class_in_use";
  profileRefs: number;
}

/** The class isn't registered for the profile's user, or the profile is an org profile. */
export interface UnknownProfileClass {
  kind: "unknown_profile_class";
  name: string;
}

/** The name is a core compartment (`personal`, `work`, …), which a custom one can't shadow. */
export interface CompartmentNameReserved {
  kind: "compartment_name_reserved";
  name: string;
}

/**
 * The user already holds `CUSTOM_COMPARTMENT_LIMIT` custom compartments.
 * Beyond ~10 buckets the classifier's choice degrades and its prompt grows.
 */
export interface CompartmentCapExceeded {
  kind: "compartment_cap_exceeded";
  limit: number;
  current: number;
}

export interface CompartmentNameTaken {
  kind: "compartment_name_taken";
  name: string;
}

export interface AliasTaken {
  kind: "alias_taken";
}

/**
 * An image provider's `(type, base_url)` breaks a rule the DB CHECK can't
 * express: `base_url` must parse, be `https://` and carry no trailing slash.
 */
export interface InvalidProviderConfig {
  kind: "invalid_provider_config";
  reason: string;
}

export interface ImageProviderNameTaken {
  kind: "image_provider_name_taken";
  name: string;
}

export interface ImageModelNameTaken {
  kind: "image_model_name_taken";
  name: string;
}

/**
 * The model's slug (the segment after the last `/`, which is all the LLM
 * sees — see `imageModelSlug`) equals an existing model's.
 */
export interface ImageModelSlugCollision {
  kind: "image_model_slug_collision";
  name: string;
  existingName: string;
  slug: string;
}

export interface SubAgentNameTaken {
  kind: "sub_agent_name_taken";
  name: string;
}

/**
 * `replaceRules` matched fewer rules than the group holds: one was retired or
 * merged since consolidation read it, or isn't a learned rule.
 */
export interface RuleGroupChanged {
  kind: "rule_group_changed";
  groupSize: number;
  deleted: number;
}

export type CreateProfileClassError = InvalidName | ProfileClassNameTaken;
export type CreateCustomCompartmentError =
  | InvalidName
  | CompartmentNameReserved
  | CompartmentCapExceeded
  | CompartmentNameTaken;
export type CreateImageProviderError = InvalidProviderConfig | ImageProviderNameTaken;
export type CreateImageModelError = ImageModelNameTaken | ImageModelSlugCollision;

/** One line an operator can act on, for the CLI and setup surfaces. */
export function describeImageCatalogError(
  e: CreateImageProviderError | CreateImageModelError,
): string {
  switch (e.kind) {
    case "invalid_provider_config":
      return `invalid config: ${e.reason}`;
    case "image_provider_name_taken":
      return `an image provider named "${e.name}" already exists`;
    case "image_model_name_taken":
      return `an image model named "${e.name}" already exists`;
    case "image_model_slug_collision":
      return (
        `image model "${e.name}" would collide on slug "${e.slug}" with "${e.existingName}"; ` +
        `rename one so the segment after the last "/" is unique (the LLM sees only that)`
      );
  }
}

/**
 * Run `fn` in a savepoint of `tx`. An `Err` or a throw rolls the savepoint
 * back, so a failed write leaves `tx` unchanged and usable.
 */
export function inSavepoint<T, E>(
  tx: Transaction,
  fn: (sp: Transaction) => Promise<Result<T, E>>,
): Promise<Result<T, E>> {
  return commitIfOk((cb) => tx.transaction(cb), fn);
}

const UNIQUE_VIOLATION_CODES = ["23505"] as const;

type PgUniqueViolation = PgError<(typeof UNIQUE_VIOLATION_CODES)[number]>;

/**
 * Referential-integrity violation SQLSTATEs.
 *
 * Postgres 18 splits these by the referential action that rejected the write:
 * a `RESTRICT` action raises `23001` (restrict_violation, the SQL-standard
 * code), while `NO ACTION` and a plain orphan insert raise `23503`
 * (foreign_key_violation). Verified against the official images — on 17 all
 * five cases raise `23503`, on 18 only the two `RESTRICT` paths move:
 *
 *   action                       pg17     pg18
 *   DELETE + RESTRICT            23503    23001
 *   UPDATE + RESTRICT            23503    23001
 *   DELETE / UPDATE + NO ACTION  23503    23503
 *   INSERT orphan child          23503    23503
 *
 * Dev, prod (`pgvector/pgvector:pg18`) and the PGlite test tier all run 18,
 * so the `23001` arm is the live one for the RESTRICT FK on
 * `profiles(user_id, profile_class)`. Both codes carry the constraint name and
 * callers discriminate on that, so both are treated as one class here.
 */
const REFERENTIAL_VIOLATION_CODES = ["23503", "23001"] as const;

type PgReferentialViolation = PgError<(typeof REFERENTIAL_VIOLATION_CODES)[number]>;

/** Narrow an unknown error to a Postgres unique-violation shape. */
export function findPostgresUniqueViolation(err: unknown): PgUniqueViolation | null {
  return findPgErrorByCode(err, UNIQUE_VIOLATION_CODES);
}

/**
 * Narrow an unknown error to a Postgres referential-integrity violation — a
 * foreign key rejecting a write, under either referential action. See
 * `REFERENTIAL_VIOLATION_CODES`.
 */
export function findPostgresReferentialViolation(err: unknown): PgReferentialViolation | null {
  return findPgErrorByCode(err, REFERENTIAL_VIOLATION_CODES);
}

/**
 * Run `fn`, turning a unique violation on `constraint` into `Err(onViolation)`.
 * Violations on other constraints, and every other error, propagate. The
 * violation aborts the transaction, so call this inside `inSavepoint`.
 */
export async function uniqueViolationAs<T, E>(
  constraint: string,
  onViolation: E,
  fn: () => Promise<T>,
): Promise<Result<T, E>> {
  try {
    return ok(await fn());
  } catch (e) {
    const pg = findPostgresUniqueViolation(e);
    if (pg && constraintNameOf(pg) === constraint) return err(onViolation);
    throw e;
  }
}

/**
 * Run `fn`, turning a referential violation on `constraint` — under either
 * referential action, see `REFERENTIAL_VIOLATION_CODES` — into
 * `Err(onViolation)`. Violations on other constraints, and every other error,
 * propagate. The violation aborts the transaction, so call this inside
 * `inSavepoint`.
 */
export async function referentialViolationAs<T, E>(
  constraint: string,
  onViolation: E,
  fn: () => Promise<T>,
): Promise<Result<T, E>> {
  try {
    return ok(await fn());
  } catch (e) {
    const pg = findPostgresReferentialViolation(e);
    if (pg && constraintNameOf(pg) === constraint) return err(onViolation);
    throw e;
  }
}
