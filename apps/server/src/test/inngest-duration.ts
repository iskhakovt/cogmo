import * as R from "remeda";
import { expectDefined } from "./assertions.js";

/**
 * Milliseconds per suffix in the duration strings Inngest emits for a sleep op.
 * Mirrors the SDK's own unit table, which is the whole vocabulary a sleep name
 * can be written in — note the absence of a millisecond unit.
 */
const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  w: 7 * 24 * 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  m: 60 * 1000,
  s: 1000,
};

/**
 * Decode an Inngest duration string (`"3s"`, `"1m30s"`) back to milliseconds.
 *
 * Reads the engine's own output rather than re-deriving it, so an assertion
 * built on this measures the wait the executor was actually asked for instead
 * of restating the mapping the code under test just applied.
 */
export function inngestDurationToMs(duration: string): number {
  const parts = [...duration.matchAll(/(\d+)([wdhms])/g)];
  if (R.pipe(parts, R.map(R.prop(0)), R.join("")) !== duration) {
    throw new Error(`unexpected sleep duration string: ${duration}`);
  }
  return R.sumBy(
    parts,
    (part) =>
      Number(expectDefined(part[1], "duration count")) *
      expectDefined(DURATION_UNIT_MS[expectDefined(part[2], "duration unit")], "duration unit ms"),
  );
}
