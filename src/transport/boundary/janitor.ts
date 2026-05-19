import type { Inngest } from "inngest";
import type { AgentStore } from "../../agent/store/index.js";
import type { Transactor } from "../../db/index.js";
import { inngest as inngestClient } from "../../inngest/client.js";
import { logger } from "../../logger.js";
import type { TransportStore } from "../store/index.js";
import { resolveBoundary } from "./resolve-boundary.js";

export interface BoundaryJanitorDeps {
  runInTx: Transactor;
  transportStore: TransportStore;
  agentStore: AgentStore;
  inngest: Inngest;
  defaultProfileId: string;
  /**
   * How long past `expires_at` to wait before the janitor claims a row.
   * Should be > the in-flight waiter's own resolution window so the cron
   * doesn't race the waiter on normal timeouts. Default: 60s.
   */
  gracePeriodMs?: number;
}

/**
 * Recovers orphan `boundary_pending` rows. Three failure modes the
 * waiter alone can't cover:
 *
 *   1. `inngest.send(boundary/pending)` failed after the holding row was
 *      inserted — no waiter ever started, so the row sits forever.
 *   2. The bot process crashed between `runInTx` commit and the for-loop
 *      that emits `inbound/arrived` per drained buffered row — the buffer
 *      is durable but the agent never woke up.
 *   3. Waiter ran but its own resolve failed past the retry budget.
 *
 * For each expired row the janitor calls `resolveBoundary({kind:"fresh",
 * reason:"waiter_timeout"})` — same path the waiter takes on timeout,
 * idempotent against rows already drained, and emits `inbound/arrived`
 * with the dedup id `inbound-arrived-${inboundMessageId}` so a waiter +
 * janitor double-resolution collapses at the bus.
 *
 * `retries: 0` matches the `skill-cron-ticker` / `scheduled-task-ticker`
 * posture: a DB blip burns no retry budget, the next tick re-scans. The
 * concurrency cap keeps two janitor bodies from running concurrently.
 */
export function createBoundaryJanitor(deps: BoundaryJanitorDeps) {
  const gracePeriodMs = deps.gracePeriodMs ?? 60_000;
  return inngestClient.createFunction(
    {
      id: "boundary-janitor",
      retries: 0,
      concurrency: { limit: 1 },
      triggers: [{ cron: "* * * * *" }],
    },
    async ({ step }) => {
      const cutoff = new Date(Date.now() - gracePeriodMs);
      const expired = await step.run("list-expired", () =>
        deps.runInTx((tx) => deps.transportStore.listExpiredBoundaryPending(tx, cutoff)),
      );

      if (expired.length === 0) return { resolved: 0 };

      let resolved = 0;
      for (const row of expired) {
        // Per-row `step.run` makes each row's resolution independently
        // retriable. `resolveBoundary` emits `inbound/arrived` per drained
        // buffer entry + a single `boundary/resolved`; both carry bus-
        // dedup ids so a step replay after a partial-emit crash doesn't
        // produce duplicate router or downstream runs.
        const outcome = await step.run(`resolve-${row.id}`, async () => {
          const res = await resolveBoundary(
            {
              runInTx: deps.runInTx,
              transportStore: deps.transportStore,
              agentStore: deps.agentStore,
              inngest: deps.inngest,
              channelId: row.channelId,
              defaultProfileId: deps.defaultProfileId,
            },
            {
              boundaryId: row.id,
              choice: { kind: "fresh" },
              reason: "waiter_timeout",
            },
          );
          if (res.isErr()) {
            // `boundary_not_found` is benign — waiter or button tap
            // already drained the row between the list-and-resolve gap.
            if (res.error.code !== "boundary_not_found") {
              logger.warn(
                { boundaryId: row.id, code: res.error.code },
                "boundary-janitor: resolve failed",
              );
            }
            return { ok: false as const, code: res.error.code };
          }
          return { ok: true as const };
        });
        if (outcome.ok) resolved += 1;
      }

      if (resolved > 0) {
        logger.info(
          { resolved, scanned: expired.length },
          "boundary-janitor: cleaned up orphan holds",
        );
      }
      return { resolved, scanned: expired.length };
    },
  );
}
