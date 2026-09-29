/**
 * Pruning LiteLLM's upstream registry (`model_prices_and_context_window.json`)
 * down to the two fields the resolver consumes. Shared by the bundled
 * snapshot's refresh script and the live catalog refresh, so both layers
 * carry the same values for the same upstream bytes.
 *
 * We keep `max_input_tokens` over `max_tokens` whenever present — LiteLLM's
 * own docs (`sample_spec`) call out `max_tokens` as a fallback that elides
 * the input/output split.
 */
import { err, ok, type Result } from "neverthrow";
import * as R from "remeda";
import { z } from "zod";
import { type LitellmEntry, LitellmEntrySchema } from "./litellm-data.js";
import { DEFAULT_SAFETY_BUFFER } from "./models.js";

/**
 * Cap for `maxOutputTokens` in the pruned catalog.
 *
 * LiteLLM reports `max_output_tokens` as the **model API's documented
 * limit** — for many flagship models that's the full context window
 * (xAI's Grok 4.3 reports input=1M and output=1M; Anthropic reports input=
 * 1M and output=128k). Our resolver treats `maxOutputTokens` as a **budget
 * setpoint**: `computeBudget = contextWindow - maxOutputTokens - 10_000`.
 *
 * Without a cap, models with `max_output == max_input` produce a negative
 * budget and compaction either misbehaves or fires every turn. 64k is the
 * upper end of what chat workloads actually emit. Operators who want a
 * tighter or looser cap pin explicit limits via `cogmo model add
 * --max-output N`.
 */
const MAX_OUTPUT_BUDGET_CAP = 64_000;

// The registry and each entry in it. Upstream types the token fields loosely
// (`sample_spec` carries prose in them), so the numbers are checked after the
// `??` picks which field applies.
const UpstreamObjectSchema = z.record(z.string(), z.unknown());

export interface PrunedRegistry {
  entries: Record<string, LitellmEntry>;
  /** Entries without a numeric context window or output limit, `sample_spec` included. */
  skippedNoTokenData: number;
  /**
   * Entries whose limits describe no chat budget: a context window or output
   * limit that isn't a positive integer (moderation endpoints report an output
   * limit of 0), or no room left between them.
   */
  skippedUnusable: number;
}

type PrunedEntry =
  | { kind: "kept"; entry: LitellmEntry }
  | { kind: "no-token-data" }
  | { kind: "unusable" };

/** Fails only when `raw` is not a JSON object; a malformed entry is skipped. */
export function pruneLitellmRegistry(raw: unknown): Result<PrunedRegistry, string> {
  const registry = UpstreamObjectSchema.safeParse(raw);
  if (!registry.success) return err("the LiteLLM registry is not a JSON object");

  const pruned = Object.entries(registry.data).map(
    ([key, value]) => [key, pruneEntry(value)] as const,
  );
  const counts = R.countBy(pruned, ([, p]) => p.kind);
  return ok({
    entries: Object.fromEntries(
      pruned.flatMap(([key, p]) => (p.kind === "kept" ? [[key, p.entry]] : [])),
    ),
    skippedNoTokenData: counts["no-token-data"] ?? 0,
    skippedUnusable: counts.unusable ?? 0,
  });
}

function pruneEntry(value: unknown): PrunedEntry {
  const parsed = UpstreamObjectSchema.safeParse(value);
  const fields = parsed.success ? parsed.data : {};
  const contextWindow = fields.max_input_tokens ?? fields.max_tokens;
  const rawOutput = fields.max_output_tokens ?? fields.max_tokens;
  if (typeof contextWindow !== "number" || typeof rawOutput !== "number") {
    return { kind: "no-token-data" };
  }
  // Cap output at 64k AND at one-quarter of the context window. The
  // quarter-of-context cap keeps small models (16k context, where 64k
  // would still produce a negative budget) sane; the 64k cap keeps
  // huge-context models from over-reserving output.
  const entry = LitellmEntrySchema.safeParse({
    contextWindow: Math.trunc(contextWindow),
    maxOutputTokens: Math.min(
      Math.trunc(rawOutput),
      Math.trunc(contextWindow / 4),
      MAX_OUTPUT_BUDGET_CAP,
    ),
  });
  // Skip entries whose effective budget would be ≤ 0 — typically tiny
  // models (4k–8k context) and embedding/rerank rows that we never
  // talk to via the chat path anyway. The resolver falls through to
  // its conservative default (128k / 4k) for any model dropped here.
  if (
    !entry.success ||
    entry.data.contextWindow - entry.data.maxOutputTokens - DEFAULT_SAFETY_BUFFER <= 0
  ) {
    return { kind: "unusable" };
  }
  return { kind: "kept", entry: entry.data };
}
