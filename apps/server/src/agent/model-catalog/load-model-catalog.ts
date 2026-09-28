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
}

/**
 * A stored catalog that no longer parses (`LitellmCatalogSchema` changed
 * since it was written) is skipped with a warning: the bundled snapshot
 * answers until the next refresh replaces the row, and the catalog is not
 * worth refusing to boot over.
 */
export async function loadModelCatalog(deps: LoadModelCatalogDeps): Promise<void> {
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
