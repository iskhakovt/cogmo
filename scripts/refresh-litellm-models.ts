#!/usr/bin/env tsx
/**
 * Refresh the bundled LiteLLM model snapshot (`data/litellm-models.json`).
 *
 * Pulls the upstream community-curated registry, prunes each entry down to
 * the two fields the resolver actually consumes (context window + max output
 * tokens), and writes the snapshot back into the repo for `git diff`-able
 * review.
 *
 * Run manually when adding support for a model that LiteLLM has shipped
 * since the last refresh:
 *
 *   pnpm tsx scripts/refresh-litellm-models.ts
 *
 * Pruning a single representative entry (e.g. `xai/grok-4.3`) cuts size from
 * ~1.4 MB raw to ~300 KB pruned (and ~30 KB gzipped on the wire). We keep
 * `max_input_tokens` over `max_tokens` whenever present — LiteLLM's own docs
 * (`sample_spec`) call out `max_tokens` as a fallback that elides the
 * input/output split.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const UPSTREAM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OUTPUT = resolve(import.meta.dirname, "../data/litellm-models.json");

interface UpstreamEntry {
  max_input_tokens?: number;
  max_tokens?: number;
  max_output_tokens?: number;
  litellm_provider?: string;
}

interface PrunedEntry {
  contextWindow: number;
  maxOutputTokens: number;
}

/**
 * Cap for `maxOutputTokens` in the pruned snapshot.
 *
 * LiteLLM reports `max_output_tokens` as the **model API's documented
 * limit** — for many flagship models that's the full context window
 * (xAI's Grok 4.3 reports input=1M and output=1M; Anthropic reports input=
 * 1M and output=64k). Our resolver treats `maxOutputTokens` as a **budget
 * setpoint**: `computeBudget = contextWindow - maxOutputTokens - 10_000`.
 *
 * Without a cap, models with `max_output == max_input` produce a negative
 * budget and compaction either misbehaves or fires every turn. 64k is the
 * upper end of what chat workloads actually emit (Claude Sonnet 4.6
 * already reports 64k in LiteLLM, and that's the largest output cap we
 * shipped in the pre-resolver `MODEL_REGISTRY`). Operators who want a
 * tighter or looser cap pin explicit limits via `cogmo model add
 * --max-output N`.
 */
const MAX_OUTPUT_BUDGET_CAP = 64_000;

/** Mirrors `DEFAULT_SAFETY_BUFFER` in `src/llm/models.ts`. */
const SAFETY_BUFFER = 10_000;

async function main(): Promise<void> {
  console.log(`Fetching ${UPSTREAM_URL}...`);
  const res = await fetch(UPSTREAM_URL);
  if (!res.ok) {
    throw new Error(`Upstream returned ${res.status}`);
  }
  const raw = (await res.json()) as Record<string, UpstreamEntry>;

  const pruned: Record<string, PrunedEntry> = {};
  let kept = 0;
  let skippedNoCtx = 0;
  let skippedNegativeBudget = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (key === "sample_spec") continue;
    const contextWindow = value.max_input_tokens ?? value.max_tokens;
    const rawOutput = value.max_output_tokens ?? value.max_tokens;
    if (typeof contextWindow !== "number" || typeof rawOutput !== "number") {
      skippedNoCtx++;
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
    if (Math.trunc(contextWindow) - maxOutputTokens - SAFETY_BUFFER <= 0) {
      skippedNegativeBudget++;
      continue;
    }
    pruned[key] = {
      contextWindow: Math.trunc(contextWindow),
      maxOutputTokens,
    };
    kept++;
  }

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(pruned, null, 2)}\n`);
  console.log(
    `Wrote ${kept} entries to ${OUTPUT} (skipped ${skippedNoCtx} without token data, ${skippedNegativeBudget} with non-positive budget)`,
  );
}

main().catch((err) => {
  console.error("Refresh failed:", err);
  process.exit(1);
});
