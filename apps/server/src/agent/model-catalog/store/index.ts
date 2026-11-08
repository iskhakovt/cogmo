import { desc, eq, ne, sql } from "drizzle-orm";
import { err, ok, type Result } from "neverthrow";
import { single } from "../../../db/helpers.js";
import type { Transaction } from "../../../db/index.js";
import { type LitellmCatalog, LitellmCatalogSchema } from "../../../llm/litellm-data.js";
import { modelCatalogs } from "./schema.js";

// --- Interface ---

export interface ModelCatalogUnreadable {
  kind: "unreadable";
  message: string;
}

export interface StoredModelCatalog {
  id: string;
  entries: LitellmCatalog;
  createdAt: Date;
}

export interface ModelCatalogStore {
  /**
   * The newest catalog, or `null` before the first refresh. A row whose
   * `entries` no longer parse (an older `LitellmCatalogSchema` wrote it) is
   * `unreadable`.
   */
  latest(tx: Transaction): Promise<Result<StoredModelCatalog | null, ModelCatalogUnreadable>>;

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
  async latest(
    tx: Transaction,
  ): Promise<Result<StoredModelCatalog | null, ModelCatalogUnreadable>> {
    const [row] = await tx
      .select({
        id: modelCatalogs.id,
        createdAt: modelCatalogs.createdAt,
        // The bare column, past `jsonbZod`'s parse, so a row that no longer
        // parses comes back as a value to check rather than a throw.
        entries: sql<unknown>`${modelCatalogs.entries}`,
      })
      .from(modelCatalogs)
      .orderBy(desc(modelCatalogs.createdAt), desc(modelCatalogs.id))
      .limit(1);
    if (!row) return ok(null);
    const entries = LitellmCatalogSchema.safeParse(row.entries);
    return entries.success
      ? ok({ id: row.id, entries: entries.data, createdAt: row.createdAt })
      : err({ kind: "unreadable", message: entries.error.message });
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
