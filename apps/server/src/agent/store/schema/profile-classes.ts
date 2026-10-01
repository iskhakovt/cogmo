import { boolean, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { pk, ts } from "../../../db/helpers.js";
import { users } from "./users.js";

/**
 * Per-user registry of named "profile classes" — labels emitted as
 * `profile_class:<name>` tags by the Observer at retain time, then matched
 * against `profiles.memory_scope.profileClasses` at recall time. Speaker-
 * driven isolation: any number of profiles can share a class, classes
 * outlive the profiles that reference them (so memory tags don't dangle
 * when a profile is deleted and recreated). `description` is human-facing
 * documentation only — the LLM classifier never reads it.
 *
 * `restricted` flips recall to fail-closed for this class: memories tagged
 * with a restricted class are invisible to any profile whose
 * `memory_scope.profileClasses` doesn't explicitly include the class (and
 * which doesn't speak as the class itself). Default `false` preserves
 * today's open-by-default behaviour for unmarked classes.
 */
export const profileClasses = pgTable(
  "profile_classes",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    restricted: boolean("restricted").notNull().default(false),
    createdAt: ts(),
  },
  (t) => [unique("uq_profile_classes_user_name").on(t.userId, t.name)],
);
