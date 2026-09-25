import type { Usage } from "./types.js";

/**
 * Add one call's usage to a running total — for callers that make several
 * calls and report them as one (the agent loop's turn, `chatTyped`'s
 * feedback retries). Cache reads and writes stay subsets of the summed
 * input; a cache field is kept once either side reports it.
 */
export function sumUsage(total: Usage, next: Usage): Usage {
  const cacheRead = sumReported(total.cacheReadTokens, next.cacheReadTokens);
  const cacheCreation = sumReported(total.cacheCreationTokens, next.cacheCreationTokens);
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    ...(cacheRead !== undefined && { cacheReadTokens: cacheRead }),
    ...(cacheCreation !== undefined && { cacheCreationTokens: cacheCreation }),
  };
}

function sumReported(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}
