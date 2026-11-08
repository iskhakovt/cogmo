#!/usr/bin/env tsx
/**
 * Refresh the bundled model snapshot (`data/litellm-models.json`).
 *
 * Pulls LiteLLM's community-curated registry and OpenRouter's model list,
 * prunes each entry down to the two fields the resolver actually consumes
 * (context window + max output tokens), and writes their union back into the
 * repo for `git diff`-able review: OpenRouter's list supplies the
 * `openrouter/*` namespace and LiteLLM's registry everything else, as in the
 * live refresh. A running install keeps its own live copy current
 * (`src/agent/model-catalog/`); this snapshot is the fallback behind it.
 *
 *   pnpm tsx scripts/refresh-litellm-models.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Result } from "neverthrow";
import { LITELLM_REGISTRY_URL, OPENROUTER_MODELS_URL } from "../src/llm/catalog-urls.js";
import { type PrunedRegistry, pruneLitellmRegistry } from "../src/llm/litellm-upstream.js";
import { pruneOpenRouterModels, withOpenRouterNamespace } from "../src/llm/openrouter-models.js";

const OUTPUT = resolve(import.meta.dirname, "../data/litellm-models.json");

async function fetchPruned(
  url: string,
  prune: (raw: unknown) => Result<PrunedRegistry, string>,
): Promise<PrunedRegistry> {
  console.log(`Fetching ${url}...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}`);
  }
  const pruned = prune(await res.json());
  if (pruned.isErr()) throw new Error(pruned.error);
  const { entries, skippedNoTokenData, skippedUnusable } = pruned.value;
  console.log(
    `  ${Object.keys(entries).length} entries (skipped ${skippedNoTokenData} without token data, ${skippedUnusable} with unusable limits)`,
  );
  return pruned.value;
}

async function main(): Promise<void> {
  const litellm = await fetchPruned(LITELLM_REGISTRY_URL, pruneLitellmRegistry);
  const openRouter = await fetchPruned(OPENROUTER_MODELS_URL, pruneOpenRouterModels);
  const entries = withOpenRouterNamespace(litellm.entries, openRouter.entries);

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(entries).length} entries to ${OUTPUT}`);
}

main().catch((err) => {
  console.error("Refresh failed:", err);
  process.exit(1);
});
