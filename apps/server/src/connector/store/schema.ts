import { sql } from "drizzle-orm";
import { check, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { pk, ts } from "../../db/helpers.js";

/** The work a connector takes. See design/connectors.md. */
export const connectorKind = pgEnum("connector_kind", ["coding"]);

/** The values `cogmo connector add --kind` accepts. */
export const CONNECTOR_KINDS = Object.freeze([...connectorKind.enumValues]);

export const connectorStatus = pgEnum("connector_status", ["active", "revoked"]);

/**
 * Predicate of `uq_connectors_active_name`, spelled as Postgres stores it. An
 * `ON CONFLICT` inferring that partial index repeats it as its target `where`.
 */
export const ACTIVE_CONNECTOR = sql`status = 'active'::connector_status`;

/**
 * Registered connectors: the registry and the auth table. The bearer token's
 * SHA-256 is all that is stored, so a DB read never yields a usable
 * credential. A revoked row stays, and its name can be added again as a new
 * row. Whether a connector is connected is process memory, not a column. See
 * design/connectors.md → Data model.
 */
export const connectors = pgTable(
  "connectors",
  {
    id: pk(),
    name: text("name").notNull(),
    kind: connectorKind("kind").notNull(),
    status: connectorStatus("status").notNull(),
    // SHA-256 hex of the raw 32-byte bearer token.
    tokenHash: text("token_hash").notNull().unique(),
    // Null exactly while the connector is active (chk_connectors_revoked_at).
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: ts(),
  },
  (t) => [
    // One active connector per name; the conflict target of `insert`.
    uniqueIndex("uq_connectors_active_name").on(t.name).where(ACTIVE_CONNECTOR),
    check(
      "chk_connectors_revoked_at",
      sql`(${t.status} = 'revoked') = (${t.revokedAt} IS NOT NULL)`,
    ),
  ],
);
