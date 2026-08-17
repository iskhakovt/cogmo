/**
 * Postgres driver-error narrowing.
 *
 * Postgres reports every failure as a five-character SQLSTATE, but the error
 * carrying it rarely reaches callers untouched. Drizzle wraps each statement
 * error in a `DrizzleQueryError` that sets only `query` / `params` / `cause`,
 * so the SQLSTATE sits one (or more) levels down the `cause` chain. The
 * statements postgres-js issues on its own — `begin`, `commit`, `rollback` —
 * skip that wrapper and surface the driver error with `code` at the top level.
 * Both shapes are live, so a SQLSTATE check walks the chain rather than
 * reading `err.code`.
 *
 * Pure infrastructure: this module knows driver and ORM error shapes and
 * nothing about the domain. It imports nothing, so `db/transactor.ts` — which
 * deliberately stays clear of `db/index.ts` and its eager connection — can
 * depend on it as freely as the domain stores do.
 */

/** How far down the `cause` chain the driver error is worth chasing. */
const MAX_CAUSE_DEPTH = 4;

/**
 * A Postgres driver error narrowed to one of the SQLSTATEs the caller asked
 * for. The constraint name arrives under two spellings: postgres-js maps
 * error field 110 to `constraint_name`, PGlite exposes it as `constraint`.
 * Both are optional — only the integrity-violation classes populate them.
 */
export interface PgError<C extends string = string> {
  code: C;
  constraint_name?: string;
  constraint?: string;
}

/**
 * Walk `err` and its `cause` chain looking for a Postgres error whose `code`
 * is one of `codes`. Returns the matched code alongside the constraint fields
 * so callers can discriminate on both; `null` when nothing in the chain
 * matches.
 */
export function findPgErrorByCode<C extends string>(
  err: unknown,
  codes: ReadonlyArray<C>,
): PgError<C> | null {
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cur != null; depth++) {
    if (typeof cur === "object" && "code" in cur) {
      // `find` rather than `includes` so the match carries `C`, not `string` —
      // the callers' literal unions survive without an assertion.
      const matched = codes.find((c) => c === (cur as { code: unknown }).code);
      if (matched !== undefined) {
        return { ...(cur as { constraint?: string; constraint_name?: string }), code: matched };
      }
    }
    if (typeof cur === "object" && "cause" in cur) {
      cur = (cur as { cause: unknown }).cause;
      continue;
    }
    break;
  }
  return null;
}

/**
 * The constraint that rejected the write, whichever spelling the driver used.
 * `"unknown"` when neither field is populated — integrity violations always
 * carry one, so the fallback marks a driver shape we don't recognise.
 */
export function constraintNameOf(pg: PgError): string {
  return pg.constraint_name ?? pg.constraint ?? "unknown";
}
