/**
 * Setup reset scopes — wipe specific state before re-prompting.
 *
 * See design/setup.md → "Re-runnable behavior". Reset never touches
 * migrations, users, profiles, or the direct channel (which is part of
 * the seeded default stack).
 */

import { logger } from "../logger.js";
import type { SecretsStore } from "../secrets/store/index.js";
import type { TransportStore } from "../transport/store/index.js";

export type ResetScope = "secrets" | "channels" | "all";

export const VALID_RESETS: ReadonlySet<ResetScope> = new Set<ResetScope>([
  "secrets",
  "channels",
  "all",
]);

export interface ResetDeps {
  secretsStore: SecretsStore;
  transportStore: TransportStore;
}

/**
 * Apply the given reset scope. Safe to call when nothing exists yet —
 * each branch is a no-op when the underlying rows are absent.
 */
export async function applyReset(scope: ResetScope, deps: ResetDeps): Promise<void> {
  if (scope === "all" || scope === "secrets") {
    await deps.secretsStore.deleteAllSecrets();
    logger.info("all secrets deleted");
  }
  if (scope === "all" || scope === "channels") {
    const all = await deps.transportStore.getAllChannels();
    for (const ch of all) {
      if (ch.type !== "direct") {
        await deps.transportStore.removeChannel(ch.id);
      }
    }
    logger.info("non-direct channels removed");
  }
}
