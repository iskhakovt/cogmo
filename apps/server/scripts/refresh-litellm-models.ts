#!/usr/bin/env tsx
/**
 * Refresh the bundled LiteLLM model snapshot (`data/litellm-models.json`).
 *
 * Pulls the upstream community-curated registry, prunes each entry down to
 * the two fields the resolver actually consumes (context window + max output
 * tokens), and writes the snapshot back into the repo for `git diff`-able
 * review. A running install keeps its own live copy current
 * (`src/agent/model-catalog/`); this snapshot is the fallback behind it.
 *
 *   pnpm tsx scripts/refresh-litellm-models.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { LITELLM_REGISTRY_URL, pruneLitellmRegistry } from "../src/llm/litellm-upstream.js";

const OUTPUT = resolve(import.meta.dirname, "../data/litellm-models.json");

async function main(): Promise<void> {
  console.log(`Fetching ${LITELLM_REGISTRY_URL}...`);
  const res = await fetch(LITELLM_REGISTRY_URL);
  if (!res.ok) {
    throw new Error(`Upstream returned ${res.status}`);
  }
  const pruned = pruneLitellmRegistry(await res.json());
  if (pruned.isErr()) throw new Error(pruned.error);
  const { entries, skippedNoTokenData, skippedNonPositiveBudget } = pruned.value;

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(entries, null, 2)}\n`);
  console.log(
    `Wrote ${Object.keys(entries).length} entries to ${OUTPUT} (skipped ${skippedNoTokenData} without token data, ${skippedNonPositiveBudget} with non-positive budget)`,
  );
}

main().catch((err) => {
  console.error("Refresh failed:", err);
  process.exit(1);
});
