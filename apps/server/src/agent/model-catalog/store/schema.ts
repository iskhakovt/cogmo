import { pgTable } from "drizzle-orm/pg-core";
import { jsonbZod, pk, ts } from "../../../db/helpers.js";
import { LitellmCatalogSchema } from "../../../llm/litellm-data.js";

/**
 * Live copy of LiteLLM's model registry, pruned to the limits the resolver
 * reads (design/providers.md → Limits resolution). Each refresh inserts a row
 * and deletes the older ones in the same transaction, so between refreshes the
 * table holds one row and its `created_at` is when that catalog was fetched.
 */
export const modelCatalogs = pgTable("model_catalogs", {
  id: pk(),
  entries: jsonbZod("entries", LitellmCatalogSchema).notNull(),
  createdAt: ts(),
});
