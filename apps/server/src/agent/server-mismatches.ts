import type { InputTransformation } from "../llm/types.js";
import { promptServerMismatches } from "../metrics.js";

/**
 * Count each transformation the provider reported on one request, under the
 * `site` that sent it ({@link promptServerMismatches}). Call it once per
 * request: inside the step that sends it, so a replay adds nothing, or, outside
 * Inngest, as `/compact` sends it.
 */
export function countServerMismatches(
  transformations: ReadonlyArray<InputTransformation>,
  site: "iteration" | "stage" | "fork",
): void {
  for (const { type, reason } of transformations) {
    promptServerMismatches.add(1, { type, reason, site });
  }
}
