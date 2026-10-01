/**
 * LLM providers and the model catalog: the per-turn provider resolver, the
 * live catalog loaded at boot, and the Inngest function that refreshes it.
 */

import { loadModelCatalog } from "../agent/model-catalog/load-model-catalog.js";
import { createModelCatalogRefresh } from "../agent/model-catalog/refresh-function.js";
import { refreshModelCatalog } from "../agent/model-catalog/refresh-model-catalog.js";
import type { DrizzleAgentStore } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import { env } from "../env.js";
import { inngest } from "../inngest/index.js";
import { bundledSnapshot, installLiveCatalog } from "../llm/litellm-data.js";
import {
  constantResolver,
  createDbProviderResolver,
  type LlmProviderResolver,
} from "../llm/resolver.js";
import type { DrizzleSecretsStore } from "../secrets/store/index.js";
import type { BootstrapOptions, CoreDeps } from "./stages.js";

/**
 * Per-turn provider dispatch: handle-message and observer call this
 * resolver with the snapshot's model on every fire. The DB-backed
 * implementation memoizes by model so each (process, model) pair pays
 * one DB read + one AES decrypt total, then a Map lookup. Tests pass a
 * `providerOverride` to short-circuit to a single provider for every
 * model. See design/providers.md → Provider dispatch.
 */
export function createProviderResolver(
  deps: { runInTx: Transactor; agentStore: DrizzleAgentStore; secretsStore: DrizzleSecretsStore },
  opts: BootstrapOptions,
): LlmProviderResolver {
  return opts.providerOverride
    ? constantResolver(opts.providerOverride)
    : createDbProviderResolver(deps);
}

/** Before the channels start, so their first turns resolve limits from it. */
export async function loadLiveModelCatalog(core: CoreDeps): Promise<void> {
  await loadModelCatalog({
    runInTx: core.runInTx,
    modelCatalogStore: core.modelCatalogStore,
    installCatalog: installLiveCatalog,
    catalogUrl: env.MODEL_CATALOG_URL,
  });
}

/** The scheduled catalog refresh; none when `MODEL_CATALOG_URL=off`. */
export function createModelCatalogFunctions(core: CoreDeps) {
  const catalogUrl = env.MODEL_CATALOG_URL;
  return catalogUrl === "off"
    ? []
    : [
        createModelCatalogRefresh(
          () =>
            refreshModelCatalog({
              runInTx: core.runInTx,
              modelCatalogStore: core.modelCatalogStore,
              url: catalogUrl,
              fetch: globalThis.fetch,
              installCatalog: installLiveCatalog,
              bundled: bundledSnapshot(),
            }),
          inngest,
        ),
      ];
}
