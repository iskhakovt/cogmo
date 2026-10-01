import { pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { pk, ts } from "../../../db/helpers.js";
import { users } from "./users.js";

/**
 * Per-user registry of named "custom compartments" — extensions of the
 * curated `MemoryCompartmentSchema` enum. The classifier loads these per
 * Observer fire and templates `description` into the prompt alongside the
 * core `personal/work/health/financial/technical/misc` definitions, then
 * emits `compartment:<name>` tags at retain time. `description` is **not**
 * documentation here — the LLM reads it. Use a 1–2 sentence definition that
 * tells the classifier when to pick this bucket.
 *
 * Forward-only: deleting a row drops the option from future classifications
 * but leaves existing `compartment:<name>` Hindsight tags untouched. Profile
 * scopes that include the deleted compartment continue to recall those
 * historical memories until the operator clears them (manual SQL on
 * Hindsight, or rename via re-create + Hindsight reclassification).
 */
export const customCompartments = pgTable(
  "custom_compartments",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    createdAt: ts(),
  },
  (t) => [unique("uq_custom_compartments_user_name").on(t.userId, t.name)],
);
