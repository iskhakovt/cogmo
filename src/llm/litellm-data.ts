/**
 * LiteLLM model snapshot loader.
 *
 * Reads the bundled `data/litellm-models.json` snapshot (refreshed by
 * `scripts/refresh-litellm-models.ts`) and exposes a normalized lookup. The
 * resolver consults this layer when no explicit DB override exists for a
 * model id; the snapshot covers ~2,200 models across all major providers.
 *
 * The snapshot lives in `data/` (outside `src/rootDir`) so it stays a
 * data artefact rather than a TS module. We load it lazily via `fs` on
 * first lookup and cache for the process lifetime — ~20 ms one-shot cost
 * the first time `resolveLimits` runs, zero on every call after.
 *
 * ## Key normalization
 *
 * LiteLLM's keys are heterogeneous because the same upstream model id can
 * appear under multiple provider routings:
 *
 *  - `xai/grok-4.3` (xAI direct, what LiteLLM calls "xai")
 *  - `openrouter/x-ai/grok-4` (OpenRouter routing the same family)
 *  - `vertex_ai/xai/grok-4.20-reasoning` (Google Vertex hosting)
 *
 * Cogmo's model ids follow OpenRouter's `<org>/<model>` convention (`x-ai/`
 * with a hyphen, not `xai/`), so we try a small ladder of candidate keys
 * against the snapshot and return the first match. Order matters — the
 * exact key wins, then prefixed forms, then aliased forms.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface LitellmEntry {
  contextWindow: number;
  maxOutputTokens: number;
}

const SNAPSHOT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  // src/llm/litellm-data.ts → repo-root/data/litellm-models.json
  "../../data/litellm-models.json",
);

let cache: Record<string, LitellmEntry> | null = null;

function loadSnapshot(): Record<string, LitellmEntry> {
  if (cache) return cache;
  const body = readFileSync(SNAPSHOT_PATH, "utf-8");
  cache = JSON.parse(body) as Record<string, LitellmEntry>;
  return cache;
}

/**
 * Look up a model id in the bundled snapshot, returning its limits or
 * `undefined`. Tries a ladder of normalizations to bridge slug differences
 * between cogmo's OpenRouter-style ids and LiteLLM's per-provider keys.
 */
export function lookupLitellm(modelId: string): LitellmEntry | undefined {
  const data = loadSnapshot();
  for (const candidate of candidateKeys(modelId)) {
    const hit = data[candidate];
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Generate the candidate lookup keys for a model id, in priority order.
 * Exported for tests; production callers go through {@link lookupLitellm}.
 *
 * Examples (input → candidates):
 *
 *  - `claude-sonnet-4-6` → [`claude-sonnet-4-6`]
 *  - `x-ai/grok-4.3` → [`x-ai/grok-4.3`, `openrouter/x-ai/grok-4.3`,
 *                       `xai/grok-4.3`, `grok-4.3`]
 *  - `openrouter/x-ai/grok-4.3` → [`openrouter/x-ai/grok-4.3`,
 *                                  `x-ai/grok-4.3`, `xai/grok-4.3`,
 *                                  `grok-4.3`]
 */
export function candidateKeys(modelId: string): string[] {
  const out: string[] = [modelId];

  // Strip a leading `openrouter/` if present, so `openrouter/x-ai/grok-4.3`
  // also tries `x-ai/grok-4.3`.
  if (modelId.startsWith("openrouter/")) {
    const stripped = modelId.slice("openrouter/".length);
    if (stripped) out.push(stripped);
  } else {
    // Otherwise, try with `openrouter/` prepended — LiteLLM publishes a
    // dedicated namespace for OpenRouter routings of the same family.
    out.push(`openrouter/${modelId}`);
  }

  // Cogmo uses OpenRouter's `x-ai/` (hyphen); LiteLLM (and the upstream
  // xAI direct API) use `xai/`. Bridge both directions.
  const aliased = aliasOrgPrefix(modelId);
  if (aliased && aliased !== modelId) {
    out.push(aliased);
    if (aliased.startsWith("openrouter/")) {
      const stripped = aliased.slice("openrouter/".length);
      if (stripped) out.push(stripped);
    } else {
      out.push(`openrouter/${aliased}`);
    }
  }

  // Last resort: keep only the last path segment and try the bare model
  // name. Catches the common case where LiteLLM keys the model under its
  // canonical (usually OpenAI/direct-vendor) namespace, regardless of how
  // many `<provider>/<org>/` layers cogmo's id wraps it in.
  const lastSlash = modelId.lastIndexOf("/");
  if (lastSlash >= 0) {
    const bare = modelId.slice(lastSlash + 1);
    if (bare) out.push(bare);
  }

  return [...new Set(out)];
}

/**
 * Map cogmo's `<org>/` prefix to LiteLLM's preferred form when they
 * differ. Returns null when no alias applies, so the caller can skip the
 * extra round of candidates.
 */
function aliasOrgPrefix(modelId: string): string | null {
  const aliases: ReadonlyArray<readonly [string, string]> = [
    ["x-ai/", "xai/"],
    ["openrouter/x-ai/", "openrouter/xai/"],
  ];
  for (const [from, to] of aliases) {
    if (modelId.startsWith(from)) {
      return to + modelId.slice(from.length);
    }
  }
  return null;
}

/** Number of entries in the bundled snapshot. Exposed for diagnostics. */
export function snapshotSize(): number {
  return Object.keys(loadSnapshot()).length;
}
