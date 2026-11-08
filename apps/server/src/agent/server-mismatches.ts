import type { InputTransformation } from "../llm/types.js";
import { promptServerMismatches } from "../metrics.js";

/**
 * Count each transformation the provider reported on one request, under the
 * `site` that sent it: `iteration` for a chat turn's loop, `stage` for a
 * pipeline stage's requests, its summarization included, and `fork` for a
 * chat turn's summarization and degraded-reply synthesis and `/compact`.
 * Callers count once per request: inside the step that sent it, so a replay
 * adds nothing, or as `/compact`, outside Inngest, sends it.
 */
export function countServerMismatches(
  transformations: ReadonlyArray<InputTransformation>,
  site: "iteration" | "stage" | "fork",
): void {
  for (const { type, reason } of transformations) {
    promptServerMismatches.add(1, { type, reason, site });
  }
}
