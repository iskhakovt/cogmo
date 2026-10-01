/**
 * The Hindsight memory client and the checks that it can talk to its server.
 */

import { env } from "../env.js";
import { HINDSIGHT_CLIENT_VERSION, HindsightMemoryProvider } from "../memory/hindsight.js";
import {
  type BootProbeContext,
  checkHindsightAuth,
  checkHindsightClientVersion,
  checkHindsightVersion,
  type HindsightCompat,
  loadHindsightCompat,
  runHindsightChecks,
} from "./checks.js";
import type { CoreDeps } from "./stages.js";

export function createMemory(): {
  memory: HindsightMemoryProvider;
  hindsightCompat: HindsightCompat;
} {
  const memory = new HindsightMemoryProvider(env.HINDSIGHT_URL, {
    apiKey: env.HINDSIGHT_API_KEY,
    maxQueryTokens: env.HINDSIGHT_RECALL_MAX_QUERY_TOKENS,
  });
  // Client↔pin drift needs no server; network probes run in `bootstrap`.
  const hindsightCompat = loadHindsightCompat();
  checkHindsightClientVersion(hindsightCompat, HINDSIGHT_CLIENT_VERSION);
  return { memory, hindsightCompat };
}

/**
 * Verify Hindsight's key enforcement and version. Also run by the memory CLIs
 * (`migrate-memories`, `backfill`), which clear and rewrite banks.
 */
export async function verifyHindsight(core: CoreDeps, context: BootProbeContext): Promise<void> {
  await runHindsightChecks(context, {
    auth: (checkContext) =>
      checkHindsightAuth({ fetch, ...checkContext }, env.HINDSIGHT_URL, env.HINDSIGHT_API_KEY),
    version: (checkContext) =>
      checkHindsightVersion(core.memory, core.hindsightCompat, checkContext),
  });
}
