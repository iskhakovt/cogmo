/**
 * Per-turn loader for the `generate_image` tool. Refreshes the `image_providers`
 * + `image_models` catalog from the DB on each `getTools()` call so CRUD via
 * the wizard / `cogmo image-{provider,model}` CLI takes effect without a
 * `cogmo serve` restart.
 *
 * Caching policy:
 *   - Adapter instances (`buildImageProvider` output) are cached by provider
 *     row id. Decryption + SDK construction happens once per provider per
 *     process; subsequent turns reuse the cached instance.
 *   - The catalog rows themselves are re-queried every turn (~2 cheap selects
 *     on tiny tables). Tool specs (Zod enum + description) are rebuilt every
 *     turn from those rows — the rebuild is microseconds.
 *   - Cache entries whose provider row no longer exists are evicted before
 *     the rebuild, so deletions are reflected immediately.
 *   - Cache entries whose row mutated in place (rotated `secretId`, swapped
 *     `baseUrl`, changed `type`, edited `attrs.headers`, renamed) are rebuilt
 *     too. We fingerprint each row's adapter-relevant fields and compare on
 *     every turn; mismatch → re-decrypt + re-construct the SDK client. No
 *     such mutation path ships today (CLI is add+remove only), but the
 *     fingerprint is cheap and removes a footgun for any future
 *     `image-provider update` flow that would otherwise serve stale
 *     credentials until restart.
 *
 * Why not version-stamp the catalog instead: a per-turn select on two small
 * tables is cheaper to reason about than a version column + invalidation
 * protocol, and at single-user scale the latency is invisible. If the catalog
 * ever grows large enough for the per-turn select to matter, swap this for a
 * version-stamped cache without touching consumers.
 *
 * Hot-reload symmetry: the LLM resolver and voice provider have the same
 * restart-only posture today and share the same eventual fix. This loader is
 * the first piece of that pattern landing for image gen.
 */

import type { AgentStore, ImageProviderRow } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import {
  buildImageProvider,
  type ImageProvider,
  type ImageProviderFetchOverrides,
} from "../llm/image-providers.js";
import type { SecretsStore } from "../secrets/store/index.js";
import type { AttachmentStore } from "../transport/attachment-store.js";
import { createImageTools } from "./image-tools.js";
import type { ToolSpec } from "./tools.js";

export interface ImageToolsLoaderDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  secretsStore: SecretsStore;
  attachments: AttachmentStore;
  fetchOverrides?: ImageProviderFetchOverrides;
}

interface CachedAdapter {
  provider: ImageProvider;
  fingerprint: string;
}

/**
 * Stable string keyed off every `image_providers` field `buildImageProvider`
 * consumes. Mismatch with the cached fingerprint forces a re-decrypt +
 * re-construct. Mutable-but-irrelevant fields (`id` itself, `createdAt`) are
 * deliberately excluded so a row touch-without-change doesn't churn the
 * cache.
 */
function fingerprintProviderRow(row: ImageProviderRow): string {
  return JSON.stringify({
    type: row.type,
    name: row.name,
    baseUrl: row.baseUrl,
    secretId: row.secretId,
    attrs: row.attrs,
  });
}

export class ImageToolsLoader {
  #deps: ImageToolsLoaderDeps;
  #providers = new Map<string, CachedAdapter>();

  constructor(deps: ImageToolsLoaderDeps) {
    this.#deps = deps;
  }

  /**
   * Build the current `generate_image` tool set from the live catalog.
   * Returns `[]` when zero user-selectable models are configured — same
   * contract as the underlying `createImageTools`, so the agent loop
   * simply doesn't surface the tool.
   */
  async getTools(): Promise<ReadonlyArray<ToolSpec>> {
    const providerRows = await this.#deps.runInTx((tx) =>
      this.#deps.agentStore.listImageProviders(tx),
    );

    // Evict adapters whose underlying row was deleted. The cache holds the
    // SDK instance and a closed-over decrypted key — both want to GC promptly
    // after the row disappears so a rotated secret can't accidentally serve
    // the next turn.
    const live = new Set(providerRows.map((r) => r.id));
    for (const id of this.#providers.keys()) {
      if (!live.has(id)) this.#providers.delete(id);
    }

    for (const row of providerRows) {
      const cached = this.#providers.get(row.id);
      const fingerprint = fingerprintProviderRow(row);
      if (cached && cached.fingerprint === fingerprint) continue;
      const provider = await buildImageProvider(row, {
        runInTx: this.#deps.runInTx,
        secretsStore: this.#deps.secretsStore,
        ...(this.#deps.fetchOverrides && { fetchOverrides: this.#deps.fetchOverrides }),
      });
      this.#providers.set(row.id, { provider, fingerprint });
    }

    const modelRows = await this.#deps.runInTx((tx) =>
      this.#deps.agentStore.listImageModelsWithProvider(tx, { userSelectableOnly: true }),
    );

    const providerMap = new Map<string, ImageProvider>();
    for (const [id, entry] of this.#providers) {
      providerMap.set(id, entry.provider);
    }
    return createImageTools({
      models: modelRows,
      providers: providerMap,
      attachments: this.#deps.attachments,
    });
  }

  /**
   * Drop the cached adapter map. Tests use this between runs; production has
   * no caller — eviction-on-delete + fingerprint-driven rebuild in `getTools`
   * is sufficient there.
   */
  clearCache(): void {
    this.#providers.clear();
  }
}
