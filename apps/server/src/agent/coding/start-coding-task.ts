/**
 * Hands a `queued` coding task to the plan orchestrator, releasing it if
 * the hand-off fails.
 */

import type { Inngest } from "inngest";
import type { Transactor } from "../../db/index.js";
import { codingTaskStart } from "../../inngest/events.js";
import { logger } from "../../logger.js";
import { describeError } from "../../util/describe-error.js";
import type { CodingStore } from "./store/index.js";

const log = logger.child({ component: "coding.service" });

/**
 * Emits `coding/task/start` under `task-start-<taskId>`, the bus-level
 * dedup that pairs with the `queued -> planning` claim outside the bus's
 * 24h window.
 *
 * A `queued` row is owned by nobody — no orchestrator run has claimed it —
 * so if the send throws, nothing else would ever move it: it would hold an
 * admission slot (the default cap is 1) with no `inngest/function.failed`
 * for reconcile to see, and the only re-execution that would reuse this
 * idempotency key never happens, because `handle-message` makes every
 * `tool-iter*` throw non-retriable. So the row is marked failed — gated on
 * it still being `queued`, since an orchestrator that already claimed it
 * must not be failed over a transport blip — and the send error rethrown,
 * so the caller tells the user the submission didn't take.
 *
 * The throw is ambiguous: the bus may have accepted the event and failed
 * only on the response. Failing the row is the side chosen to match what
 * the user is told; an accepted event then finds a failed row and its claim
 * skips it. The idempotency key stays on the row, so a retry recovers it and
 * reports it failed rather than minting a second task. Removing the
 * ambiguity wants a transactional outbox (tracked in `todo.md`).
 */
export async function startCodingTask(
  deps: { runInTx: Transactor; codingStore: CodingStore; inngest: Pick<Inngest, "send"> },
  taskId: string,
): Promise<void> {
  try {
    await deps.inngest.send({
      name: codingTaskStart.name,
      data: { taskId },
      id: `task-start-${taskId}`,
    });
  } catch (sendErr) {
    await deps
      .runInTx((tx) =>
        deps.codingStore.failQueuedTask(
          tx,
          taskId,
          `inngest.send failed: ${describeError(sendErr)}`,
        ),
      )
      .then((freed) => {
        if (!freed) {
          log.info(
            { taskId, sendErr },
            "send reported failure but the task had already been claimed — left alone",
          );
        }
      })
      .catch((cleanupErr) => {
        log.error(
          { err: cleanupErr, taskId, sendErr },
          "failed to mark task failed after inngest.send error — task is now orphaned",
        );
      });
    throw sendErr;
  }
}
