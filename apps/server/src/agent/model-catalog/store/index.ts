import { desc, eq, ne, sql } from "drizzle-orm";
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

  /**
   * The model ids in the newest catalog, or `null` before the first refresh
   * and when that row's `entries` isn't a JSON object. Reads the keys through
   * SQL rather than the column's `LitellmCatalogSchema`, so a row an older
   * schema wrote still answers and the refresh that replaces it can run.
   */
  latestModelIds(tx: Transaction): Promise<string[] | null>;

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

  async latestModelIds(tx: Transaction): Promise<string[] | null> {
    const [newest] = await tx
      .select({
        id: modelCatalogs.id,
        type: sql<string>`jsonb_typeof(${modelCatalogs.entries})`,
      })
      .from(modelCatalogs)
      .orderBy(desc(modelCatalogs.createdAt), desc(modelCatalogs.id))
      .limit(1);
    // `jsonb_object_keys` raises on anything but an object.
    if (newest?.type !== "object") return null;
    const rows = await tx
      .select({ modelId: sql<string>`jsonb_object_keys(${modelCatalogs.entries})` })
      .from(modelCatalogs)
      .where(eq(modelCatalogs.id, newest.id));
    return rows.map((row) => row.modelId);
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
