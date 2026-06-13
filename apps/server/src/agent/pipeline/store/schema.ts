import { sql } from "drizzle-orm";
import { boolean, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { jsonbZod, pk, ts } from "../../../db/helpers.js";
import { users } from "../../store/schema.js";
import { PipelineDefinitionSchema } from "../types.js";

/**
 * Versioned user-defined pipeline definitions (design/pipelines.md → Data
 * Model). Rows are immutable in every column except `active` — activation
 * is a status transition, like `coding_tasks.status`. The user's free text
 * is the editable source; editing recompiles into a new version row.
 */
export const pipelineDefinitions = pgTable(
  "pipeline_definitions",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    sourceText: text("source_text").notNull(),
    compiled: jsonbZod("compiled", PipelineDefinitionSchema).notNull(),
    active: boolean("active").notNull(),
    createdAt: ts(),
  },
  (t) => [
    uniqueIndex("uq_pipeline_definitions_version").on(t.userId, t.name, t.version),
    // At most one active version per (user, name) — activation flips the
    // old version off and the new one on in a single tx, deactivate-then-
    // activate so this index holds throughout.
    uniqueIndex("uq_pipeline_definitions_active").on(t.userId, t.name).where(sql`active = true`),
  ],
);
