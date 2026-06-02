import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../../agent/store/schema.js";
import { pk, ts } from "../../db/helpers.js";

/**
 * Web UI browser sessions. A successful `POST /api/session` mints a row; the
 * cookie carries the raw opaque token and only its SHA-256 hash lands here, so
 * a DB read never yields a usable session credential. Logout deletes the row
 * (server-side revocation); "log out everywhere" deletes all rows for the
 * user. See design/web-ui.md -> Auth and bind.
 */
export const webSessions = pgTable(
  "web_sessions",
  {
    id: pk(),
    // SHA-256 hex of the raw 32-byte session token (the cookie value). Unique
    // because one cookie maps to at most one row.
    tokenHash: text("token_hash").notNull().unique(),
    // Cascade: a session is ephemeral, owned data — deleting the owner deletes
    // its sessions (and never lets them block the delete).
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Bumped on each authenticated request — idle bookkeeping + the future
    // "active sessions" view.
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    // Absolute expiry (created_at + WEB_SESSION_TTL_DAYS), computed in the
    // create-session use case. NOT NULL: every web session expires (unlike
    // channel_sessions.expires_at, which is nullable for never-expiring rows).
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: ts(),
  },
  (t) => [
    // Backs the `ON DELETE CASCADE` cleanup (deleting a user scans by user_id)
    // and the future "log out everywhere" / active-sessions reads.
    index("idx_web_sessions_user").on(t.userId),
    // `deleteExpired` (login-time purge) range-filters on expires_at.
    index("idx_web_sessions_expires").on(t.expiresAt),
  ],
);
