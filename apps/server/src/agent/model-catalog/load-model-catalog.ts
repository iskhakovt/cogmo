/**
 * Install the newest stored model catalog at boot, so a restarted process
 * resolves limits from what the last refresh fetched rather than from the
 * bundled snapshot alone.
 */
import { z } from "zod";
import type { Transactor } from "../../db/index.js";
import type { LiveCatalog } from "../../llm/litellm-data.js";
import { logger } from "../../logger.js";
import { describeError } from "../../util/describe-error.js";
import type { ModelCatalogStore, StoredModelCatalog } from "./store/index.js";

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
  let stored: StoredModelCatalog | null;
  try {
    stored = await deps.runInTx((tx) => deps.modelCatalogStore.latest(tx));
  } catch (e) {
    if (!(e instanceof z.ZodError)) throw e;
    logger.warn(
      { err: describeError(e) },
      "stored model catalog unreadable — resolving limits from the bundled snapshot until the next refresh",
    );
    return;
  }
  if (stored) deps.installCatalog({ entries: stored.entries, fetchedAt: stored.createdAt });
}
