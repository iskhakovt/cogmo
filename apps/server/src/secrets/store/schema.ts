import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { pk, ts } from "../../db/helpers.js";

/**
 * Encrypted credential storage. Each row holds one named secret
 * (API key, bot token, etc.) encrypted with AES-256-GCM.
 *
 * Ciphertext and nonce are stored as base64-encoded text — Drizzle
 * has no built-in bytea type, and these are small values (API keys
 * under 200 bytes). The auth tag is appended to ciphertext by
 * @noble/ciphers (standard GCM convention).
 */
export const secrets = pgTable("secrets", {
  id: pk(),
  name: text("name").notNull().unique(),
  ciphertext: text("ciphertext").notNull(),
  nonce: text("nonce").notNull(),
  description: text("description"),
  validatedAt: timestamp("validated_at", { withTimezone: true }),
  createdAt: ts(),
});
