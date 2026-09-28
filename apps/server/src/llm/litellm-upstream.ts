/**
 * LiteLLM's upstream registry (`model_prices_and_context_window.json`) and
 * the pruning that reduces it to the two fields the resolver consumes.
 * Shared by the bundled snapshot's refresh script and the live catalog
 * refresh, so both layers carry the same values for the same upstream bytes.
 *
 * We keep `max_input_tokens` over `max_tokens` whenever present — LiteLLM's
 * own docs (`sample_spec`) call out `max_tokens` as a fallback that elides
 * the input/output split.
 */
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { LitellmEntry } from "./litellm-data.js";
import { DEFAULT_SAFETY_BUFFER } from "./models.js";

export const LITELLM_REGISTRY_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

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
  /** Entries whose context budget would be zero or less after the output cap. */
  skippedNonPositiveBudget: number;
}

/** Fails only when `raw` is not a JSON object; a malformed entry is skipped. */
export function pruneLitellmRegistry(raw: unknown): Result<PrunedRegistry, string> {
  const registry = UpstreamObjectSchema.safeParse(raw);
  if (!registry.success) return err("the LiteLLM registry is not a JSON object");

  const entries: Record<string, LitellmEntry> = {};
  let skippedNoTokenData = 0;
  let skippedNonPositiveBudget = 0;
  for (const [key, value] of Object.entries(registry.data)) {
    const entry = UpstreamObjectSchema.safeParse(value);
    const fields = entry.success ? entry.data : {};
    const contextWindow = fields.max_input_tokens ?? fields.max_tokens;
    const rawOutput = fields.max_output_tokens ?? fields.max_tokens;
    if (typeof contextWindow !== "number" || typeof rawOutput !== "number") {
      skippedNoTokenData++;
      continue;
    }
    // Cap output at 64k AND at one-quarter of the context window. The
    // quarter-of-context cap keeps small models (16k context, where 64k
    // would still produce a negative budget) sane; the 64k cap keeps
    // huge-context models from over-reserving output.
    const maxOutputTokens = Math.min(
      Math.trunc(rawOutput),
      Math.trunc(contextWindow / 4),
      MAX_OUTPUT_BUDGET_CAP,
    );
    // Skip entries whose effective budget would be ≤ 0 — typically tiny
    // models (4k–8k context) and embedding/rerank rows that we never
    // talk to via the chat path anyway. The resolver falls through to
    // its conservative default (128k / 4k) for any model dropped here.
    if (Math.trunc(contextWindow) - maxOutputTokens - DEFAULT_SAFETY_BUFFER <= 0) {
      skippedNonPositiveBudget++;
      continue;
    }
    entries[key] = { contextWindow: Math.trunc(contextWindow), maxOutputTokens };
  }
  return ok({ entries, skippedNoTokenData, skippedNonPositiveBudget });
}
