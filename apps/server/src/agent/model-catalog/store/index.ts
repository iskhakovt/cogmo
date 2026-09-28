import { desc, ne } from "drizzle-orm";
import { single } from "../../../db/helpers.js";
import type { Transaction } from "../../../db/index.js";
import type { LitellmCatalog } from "../../../llm/litellm-data.js";
import { modelCatalogs } from "./schema.js";

// --- Interface ---

export interface StoredModelCatalog {
  id: string;
  entries: LitellmCatalog;
  createdAt: Date;
}

export interface ModelCatalogStore {
  /** The newest catalog, or `null` before the first refresh. */
  latest(tx: Transaction): Promise<StoredModelCatalog | null>;

  /** Store `entries` as the newest catalog and delete every older one. */
  replace(tx: Transaction, entries: LitellmCatalog): Promise<{ id: string; createdAt: Date }>;
}

// --- Implementation ---

export class DrizzleModelCatalogStore implements ModelCatalogStore {
  async latest(tx: Transaction): Promise<StoredModelCatalog | null> {
    const rows = await tx
      .select()
      .from(modelCatalogs)
      .orderBy(desc(modelCatalogs.createdAt), desc(modelCatalogs.id))
      .limit(1);
    return rows[0] ?? null;
  }

  async replace(
    tx: Transaction,
    entries: LitellmCatalog,
  ): Promise<{ id: string; createdAt: Date }> {
    const row = single(
      await tx
        .insert(modelCatalogs)
        .values({ entries })
        .returning({ id: modelCatalogs.id, createdAt: modelCatalogs.createdAt }),
    );
    await tx.delete(modelCatalogs).where(ne(modelCatalogs.id, row.id));
    return row;
  }
}
