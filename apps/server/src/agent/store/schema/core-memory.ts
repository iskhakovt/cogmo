import { foreignKey, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { pk, ts } from "../../../db/helpers.js";
import { profileClasses } from "./profile-classes.js";
import { users } from "./users.js";

export const coreMemoryBlocks = pgTable(
  "core_memory_blocks",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /**
     * NULL = the unclassed bucket, or the shared block when `key` is
     * `identity`; set = that class's block. See design/memory.md → Core
     * Memory Scope by Profile Class.
     */
    profileClass: text("profile_class"),
    key: text("key").notNull(), // 'identity', 'user_profile', 'active_projects', etc.
    content: text("content").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: ts(),
  },
  (t) => [
    // One block per key in each scope; NULLS NOT DISTINCT makes the NULL
    // class one scope rather than a new one per row.
    unique("uq_core_memory_user_class_key").on(t.userId, t.profileClass, t.key).nullsNotDistinct(),
    // A class's blocks go with the class. MATCH SIMPLE skips NULL-class rows.
    foreignKey({
      columns: [t.userId, t.profileClass],
      foreignColumns: [profileClasses.userId, profileClasses.name],
      name: "fk_core_memory_profile_class",
    }).onDelete("cascade"),
  ],
);
