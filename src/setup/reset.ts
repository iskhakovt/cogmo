/**
 * Setup reset scopes — wipe specific state before re-prompting.
 *
 * See design/setup.md → "Re-runnable behavior". Reset never touches
 * migrations, users, profiles, or the direct channel (which is part of
 * the seeded default stack).
 */

import { inArray, ne } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { logger } from "../logger.js";
import { secrets } from "../secrets/store/schema.js";
import {
  channels,
  channelSessions,
  inboundMessages,
  userIdentities,
} from "../transport/store/schema.js";

export type ResetScope = "secrets" | "channels" | "all";

export const VALID_RESETS: ReadonlySet<ResetScope> = new Set<ResetScope>([
  "secrets",
  "channels",
  "all",
]);

export interface ResetDeps {
  db: Database;
}

/**
 * Apply the given reset scope atomically. Safe to call when nothing exists
 * yet — each branch is a no-op when the underlying rows are absent.
 *
 * Uses raw drizzle queries inside a single transaction rather than
 * delegating to the secrets/transport stores, because reset spans both
 * store boundaries and the stores don't yet accept an injected tx
 * (see todo.md "Pass transaction function to stores"). Atomicity matters
 * here so a failure mid-wipe leaves either the full prior state or a
 * full reset, never half of each.
 */
export async function applyReset(scope: ResetScope, deps: ResetDeps): Promise<void> {
  await deps.db.transaction(async (tx) => {
    if (scope === "all" || scope === "secrets") {
      await tx.delete(secrets);
      logger.info("all secrets deleted");
    }
    if (scope === "all" || scope === "channels") {
      const targets = await tx
        .select({ id: channels.id })
        .from(channels)
        .where(ne(channels.type, "direct"));
      if (targets.length > 0) {
        const ids = targets.map((c) => c.id);
        // FK order: inbound_messages → channel_sessions → identities → channels
        const sessionRows = await tx
          .select({ id: channelSessions.id })
          .from(channelSessions)
          .where(inArray(channelSessions.channelId, ids));
        const sessionIds = sessionRows.map((s) => s.id);
        if (sessionIds.length > 0) {
          await tx
            .delete(inboundMessages)
            .where(inArray(inboundMessages.channelSessionId, sessionIds));
        }
        await tx.delete(channelSessions).where(inArray(channelSessions.channelId, ids));
        await tx.delete(userIdentities).where(inArray(userIdentities.channelId, ids));
        await tx.delete(channels).where(inArray(channels.id, ids));
      }
      logger.info("non-direct channels removed");
    }
  });
}
