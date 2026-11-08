import type { Logger } from "pino";
import { promptPrefixViolations } from "../metrics.js";
import type { LoopRequests } from "./transcript-head.js";

/**
 * Count and log the loop's in-turn head check failure, if it had one: the
 * first iteration whose rebuilt request differed from its memoized head. Its
 * callers count once, in the persist step that wrote the turn's diverged
 * heads, so the count matches what is stored.
 */
export function reportInTurnViolation(
  requests: LoopRequests,
  site: "iteration" | "stage",
  log: Logger,
): void {
  if (requests.violatedAt === null) return;
  promptPrefixViolations.add(1, { site });
  log.warn(
    { site, iteration: requests.violatedAt },
    "a replay rebuilt a request other than the one its iteration sent; heads stored as diverged",
  );
}
