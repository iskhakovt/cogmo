/**
 * Install the newest stored model catalog at boot, so a restarted process
 * resolves limits from what the last refresh fetched rather than from the
 * bundled snapshot alone.
 */
import type { Transactor } from "../../db/index.js";
import type { LiveCatalog } from "../../llm/litellm-data.js";
import { logger } from "../../logger.js";
import type { ModelCatalogStore } from "./store/index.js";

export interface LoadModelCatalogDeps {
  runInTx: Transactor;
  modelCatalogStore: ModelCatalogStore;
  installCatalog: (catalog: LiveCatalog) => void;
  /**
   * `MODEL_CATALOG_URL`. At `off` nothing loads, so limits come from the
   * bundled snapshot alone and a row stored before the refresh was turned off
   * stays unread.
   */
  catalogUrl: string;
}

/**
 * A stored catalog that no longer parses (`LitellmCatalogSchema` changed
 * since it was written) is skipped with a warning: the bundled snapshot
 * answers until the next refresh replaces the row, and the catalog is not
 * worth refusing to boot over.
 */
export async function loadModelCatalog(deps: LoadModelCatalogDeps): Promise<void> {
  if (deps.catalogUrl === "off") return;
  const stored = await deps.runInTx((tx) => deps.modelCatalogStore.latest(tx));
  if (stored.isErr()) {
    logger.warn(
      { err: stored.error.message },
      "stored model catalog unreadable — resolving limits from the bundled snapshot until the next refresh",
    );
    return;
  }
  if (stored.value) {
    deps.installCatalog({ entries: stored.value.entries, fetchedAt: stored.value.createdAt });
  }
}
