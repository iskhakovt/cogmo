/**
 * Background warm of the sandbox images at boot, so the first coding task or
 * tier-2 skill doesn't pay the snapshot build in its own request budget.
 */

import { logger } from "../logger.js";
import type { ResourceLimits, SandboxClient } from "../sandbox/index.js";

/**
 * Background prewarm at boot. Owns retries (`coding-task-start` pins
 * `retries: 0`); on exhaustion the per-task `ensureImagePresent`
 * triggers a fresh cycle via cache eviction.
 */
export interface SandboxImageWarmSpec {
  image: string;
  /** Baked into the snapshot at warm time; the snapshot path inherits these forever. */
  resourceLimits: ResourceLimits;
}

export function scheduleSandboxImageWarm(
  sandbox: SandboxClient,
  specs: ReadonlyArray<SandboxImageWarmSpec>,
): void {
  for (const spec of specs) {
    void retryBootWarm(sandbox, spec.image, spec.resourceLimits);
  }
}

/** ~20 attempts × ~60s cap ≈ 20 min ceiling. Exported for tests only. */
export const BOOT_WARM_MAX_ATTEMPTS = 20;
const BOOT_WARM_MIN_DELAY_MS = 5_000;
const BOOT_WARM_MAX_DELAY_MS = 60_000;
const BOOT_WARM_JITTER_MS = 1_000;

/** Not `withRetry` — p-retry's internal setTimeout isn't unrefed and would block SIGTERM. */
async function retryBootWarm(
  sandbox: SandboxClient,
  image: string,
  resourceLimits: ResourceLimits,
): Promise<void> {
  for (let attempt = 1; attempt <= BOOT_WARM_MAX_ATTEMPTS; attempt++) {
    try {
      await sandbox.ensureImagePresent(image, resourceLimits);
      logger.info({ image, attempt }, "sandbox image warm complete");
      return;
    } catch (err) {
      const isLastAttempt = attempt === BOOT_WARM_MAX_ATTEMPTS;
      if (isLastAttempt) {
        logger.warn(
          { err, image, attemptsTaken: BOOT_WARM_MAX_ATTEMPTS },
          "background sandbox image warm exhausted retries — task path will retry on first use",
        );
        return;
      }
      // 5s, 10s, 20s, 40s, 60s (capped); + up to 1s jitter.
      const exp = Math.min(BOOT_WARM_MAX_DELAY_MS, BOOT_WARM_MIN_DELAY_MS * 2 ** (attempt - 1));
      const delay = exp + Math.floor(Math.random() * BOOT_WARM_JITTER_MS);
      logger.warn(
        { err, image, attempt, retryInMs: delay },
        "background sandbox image warm failed — scheduling retry",
      );
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay);
        t.unref();
      });
    }
  }
}
