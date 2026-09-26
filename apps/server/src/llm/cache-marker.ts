/**
 * Anthropic's `cache_control` breakpoint marker for a {@link CacheIntent} —
 * sent by the Anthropic adapter, and passed through to Claude by OpenRouter.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { CacheIntent } from "./types.js";

/** Anthropic's TTL for each {@link CacheIntent} retention. */
const CACHE_TTL = { short: "5m", long: "1h" } as const satisfies Record<
  CacheIntent["retention"],
  Anthropic.CacheControlEphemeral["ttl"]
>;

/**
 * The breakpoint marker for a request. Without an intent, the API default
 * (5 minutes). With one, the intent's TTL — on every marker in the request,
 * because a longer TTL may not follow a shorter one and the automatic tail
 * breakpoint comes last: a 1-hour tail after a 5-minute system marker is a 400.
 */
export function cacheMarker(intent: CacheIntent | undefined): Anthropic.CacheControlEphemeral {
  return intent ? { type: "ephemeral", ttl: CACHE_TTL[intent.retention] } : { type: "ephemeral" };
}
