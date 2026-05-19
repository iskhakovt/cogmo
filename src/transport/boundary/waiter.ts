import type { Inngest } from "inngest";
import type { AgentStore } from "../../agent/store/index.js";
import type { Transactor } from "../../db/index.js";
import { inngest as inngestClient } from "../../inngest/client.js";
import { boundaryPendingEvent, boundaryResolvedEvent } from "../../inngest/events.js";
import { logger } from "../../logger.js";
import type { TransportStore } from "../store/index.js";
import { resolveBoundary } from "./resolve-boundary.js";

export interface BoundaryWaiterDeps {
  runInTx: Transactor;
  transportStore: TransportStore;
  agentStore: AgentStore;
  inngest: Inngest;
  defaultProfileId: string;
}

/**
 * Inngest function: waits out the boundary-hold timeout and falls back to
 * "fresh" resolution. Cancelled by `conversation/boundary/resolved` keyed on
 * the boundary id — the cancel listener fires when the user taps a button or
 * runs `/new`/`/resume` while the hold is open.
 *
 * `idempotency` keyed on `boundaryId` collapses retries of the
 * boundary-creating tx (Inngest at-least-once on `step.sendEvent`) to a
 * single waiter per hold. `cancelOn` is matched on `data.boundaryId`.
 *
 * The waiter calls into the same `resolveBoundary` use case that button
 * callbacks use, with `choice: fresh` + `reason: waiter_timeout`. If the row
 * is already gone (a button tap won the race despite the cancel), the use
 * case returns `boundary_not_found` and we no-op.
 */
export function createBoundaryWaiter(deps: BoundaryWaiterDeps) {
  return inngestClient.createFunction(
    {
      id: "boundary-waiter",
      triggers: [boundaryPendingEvent],
      idempotency: "event.data.boundaryId",
      cancelOn: [{ event: boundaryResolvedEvent, match: "data.boundaryId" }],
    },
    async ({ event, step }) => {
      const { boundaryId, channelId, platformAddress, timeoutMs } = event.data;
      await step.sleep("wait", `${timeoutMs}ms`);

      // `step.run` JSON-serialises the return value for Inngest's durable
      // history — neverthrow `Result` objects don't round-trip through that.
      // Flatten to a plain discriminated record inside the step, then react
      // outside.
      //
      // `resolveBoundary` calls `inngest.send` directly inside this body
      // (not via `step.sendEvent`). A mid-step retry replays those sends —
      // but each carries a bus-dedup id (see resolve-boundary.ts loop +
      // buildBoundaryResolvedEvent), so the duplicates collapse at the bus
      // rather than producing extra router / consumer runs.
      const outcome = await step.run("resolve-as-fresh", async () => {
        const result = await resolveBoundary(
          {
            runInTx: deps.runInTx,
            transportStore: deps.transportStore,
            agentStore: deps.agentStore,
            inngest: deps.inngest,
            channelId,
            defaultProfileId: deps.defaultProfileId,
          },
          {
            boundaryId,
            choice: { kind: "fresh" },
            reason: "waiter_timeout",
          },
        );
        if (result.isErr()) {
          return { ok: false as const, code: result.error.code };
        }
        return {
          ok: true as const,
          conversationId: result.value.conversationId,
          drainedInboundCount: result.value.drainedInboundCount,
        };
      });

      if (!outcome.ok) {
        if (outcome.code === "boundary_not_found") {
          // Button tap or command resolved the hold before the cancel
          // listener kicked in (or the cancel itself raced with the wake).
          // Either way, the user got their resolution — no-op.
          return { boundaryId, resolved: false, reason: "already_resolved" as const };
        }
        logger.error(
          { boundaryId, channelId, platformAddress, code: outcome.code },
          "boundary waiter: fresh fallback failed",
        );
        return { boundaryId, resolved: false, reason: outcome.code };
      }

      return {
        boundaryId,
        resolved: true,
        conversationId: outcome.conversationId,
        drainedInboundCount: outcome.drainedInboundCount,
      };
    },
  );
}
