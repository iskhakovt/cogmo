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
  for (const [key, value] of Object.entries(raw)) {
    if (key === "sample_spec") continue;
    const contextWindow = value.max_input_tokens ?? value.max_tokens;
    const maxOutputTokens = value.max_output_tokens ?? value.max_tokens;
    if (typeof contextWindow !== "number" || typeof maxOutputTokens !== "number") {
      skippedNoCtx++;
      continue;
    }
    pruned[key] = {
      contextWindow: Math.trunc(contextWindow),
      maxOutputTokens: Math.trunc(maxOutputTokens),
    };
    kept++;
  }

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(pruned, null, 2)}\n`);
  console.log(`Wrote ${kept} entries to ${OUTPUT} (skipped ${skippedNoCtx} with no token data)`);
}

main().catch((err) => {
  console.error("Refresh failed:", err);
  process.exit(1);
});
