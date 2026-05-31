/**
 * Cron expression validation + next-run computation for `scheduled_tasks`.
 *
 * Backed by croner — zero-dep, IANA-tz-aware via `Intl.DateTimeFormat`.
 * DST behaviour (verified empirically and pinned in `cron.test.ts`):
 *
 *   - **Spring forward**: when a cron targets a local hour that doesn't
 *     exist on the DST-start day, croner shifts it to the next valid
 *     instant rather than skipping the day. "Every day at 01:00 local"
 *     fires once that day at 02:00 BST (= 01:00 UTC), then resumes
 *     normal cadence. Preserves "fires daily" semantics.
 *   - **Fall back**: when a cron targets a local hour that occurs twice
 *     on the DST-end day, croner fires once at the FIRST occurrence and
 *     skips the second. "Every day at 01:00 local" fires at 01:00 BST,
 *     not again at 01:00 GMT the same day.
 *
 * We restrict to standard 5-field cron (minute granularity). Croner
 * accepts 6-field with seconds by default, which would let the agent
 * schedule sub-minute fires; reject those upfront so the contract is
 * "minutes are the smallest unit" regardless of expression.
 *
 * See design/scheduling.md → Agent Self-Scheduling.
 */

import { Cron } from "croner";
import { err, ok, type Result } from "neverthrow";

/**
 * Smallest interval between consecutive fires. 5-field cron can't express
 * anything tighter (minute granularity), so this is defense-in-depth
 * against future expression formats and a guard against pathological
 * croner outputs.
 */
export const MIN_CRON_INTERVAL_SECONDS = 60;

/**
 * Structured cron-validation failure. Returned from `validateCron` as the
 * error branch of a `Result` so callers (especially LLM tool handlers)
 * can render a useful message and let the model self-correct.
 *
 * `kind` discriminates the case; sibling fields carry the specifics the
 * LLM needs to fix its input.
 */
export type CronValidationError =
  | { kind: "malformed"; message: string }
  | { kind: "unsupported_field_count"; got: number; expected: 5 }
  | { kind: "invalid_timezone"; timezone: string }
  | { kind: "interval_too_short"; periodSeconds: number; minSeconds: number }
  | { kind: "no_next_occurrence" };

/**
 * Validate a 5-field cron expression in an IANA timezone. Returns
 * `ok(void)` on success or a structured error.
 *
 * Steps (in order, so the first failure picked is the most informative):
 *   1. Field count must be exactly 5.
 *   2. Timezone must be accepted by `Intl.DateTimeFormat`.
 *   3. Expression must parse under croner.
 *   4. Period between the next two fires must be >= `MIN_CRON_INTERVAL_SECONDS`.
 */
export function validateCron(
  expression: string,
  timezone: string,
): Result<void, CronValidationError> {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return err({ kind: "unsupported_field_count", got: fields.length, expected: 5 });
  }

  if (!isValidTimezone(timezone)) {
    return err({ kind: "invalid_timezone", timezone });
  }

  let cron: Cron;
  try {
    // `paused: true` keeps croner from scheduling internally — we only
    // want to compute next-run, not register a callback.
    cron = new Cron(expression, { timezone, paused: true });
  } catch (e) {
    return err({ kind: "malformed", message: e instanceof Error ? e.message : String(e) });
  }

  const first = cron.nextRun();
  if (!first) {
    return err({ kind: "no_next_occurrence" });
  }
  const second = cron.nextRun(first);
  if (second) {
    const periodSeconds = (second.getTime() - first.getTime()) / 1000;
    if (periodSeconds < MIN_CRON_INTERVAL_SECONDS) {
      return err({
        kind: "interval_too_short",
        periodSeconds,
        minSeconds: MIN_CRON_INTERVAL_SECONDS,
      });
    }
  }

  return ok(undefined);
}

/**
 * Compute the next occurrence of a cron expression in an IANA timezone,
 * strictly after `after`. Assumes the expression and timezone have
 * already been validated via `validateCron` — does not re-run the
 * field-count or interval checks, and rethrows croner's parse errors
 * unmodified for the "shouldn't happen" path.
 *
 * Throws `Error` if the expression has no future occurrence (croner
 * returns null) — this is genuinely unreachable for our recurring crons
 * but the type forces us to handle the case.
 */
export function computeNextRun(expression: string, timezone: string, after: Date): Date {
  const cron = new Cron(expression, { timezone, paused: true });
  const next = cron.nextRun(after);
  if (!next) {
    throw new Error(
      `cron expression "${expression}" (${timezone}) has no occurrence after ${after.toISOString()}`,
    );
  }
  return next;
}

/**
 * True if `timezone` is accepted by the runtime's `Intl.DateTimeFormat`
 * (IANA names like `Europe/London`, legacy abbreviations like `EST`,
 * offset strings like `+01:00` — whatever Intl accepts). Exported so
 * non-cron paths (one-off scheduling, wizard tz pre-check) can reuse
 * the same gate without re-parsing a cron expression.
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    // Constructing a formatter with an unknown TZ throws `RangeError:
    // Invalid time zone specified`. This is the cheapest way to validate
    // IANA tz names against the runtime's tzdata.
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
