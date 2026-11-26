/**
 * The writes a child's create, start and removal bring, as the plans in
 * `child-plan.ts` call them, over the boot stage's `ChildContainers`
 * (design/sandbox.md → Proxy Design → Child containers). A failed insert is
 * `record_failed`, since its container is being removed; a failed transition is
 * logged and the daemon's own answer stands, since every reap covers the
 * state the row is left in; a failed reconcile is `unavailable`, since the
 * cap cannot be decided.
 */

import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { logger } from "../../logger.js";
import type { ChildContext } from "./child-plan.js";
import {
  daemonFailed,
  notFound,
  type ProxyRejection,
  recordFailed,
  unavailable,
} from "./rejection.js";
import type { ChildContainers } from "./types.js";

const log = logger.child({ component: "sandbox.proxy" });

/** The child writes of one task socket's requests; `signal` cuts off its cap reconciles. */
export function childWrites(
  children: ChildContainers,
  taskId: string,
  signal: AbortSignal,
): Pick<ChildContext, "recordChild" | "childStarted" | "childRemoved" | "reconcileChildren"> {
  return {
    recordChild: async (child, cutOff) =>
      children.record(child, cutOff).mapErr((failed) =>
        match(failed)
          .with({ kind: "record_failed" }, () =>
            recordFailed("the created container's row could not be recorded"),
          )
          .with({ kind: "cut_off" }, () =>
            daemonFailed("Cogmo proxy: the create was cut off before its row was written"),
          )
          .exhaustive(),
      ),
    childStarted: async (child, ref) =>
      (await children.started(child)).match(
        (outcome): Result<void, ProxyRejection> =>
          match(outcome)
            .with({ kind: "started" }, (): Result<void, ProxyRejection> => ok(undefined))
            .with({ kind: "reaped" }, () => err(notFound(`No such container: ${ref}`)))
            .exhaustive(),
        ({ cause }) => {
          // The row under-reports `running`, which every reap covers.
          log.warn({ err: cause, taskId, dockerId: child.dockerId }, "child running write failed");
          return ok(undefined);
        },
      ),
    reconcileChildren: async (live) =>
      children.reconcile(live, signal).mapErr(({ cause }): ProxyRejection => {
        log.warn({ err: cause, taskId }, "child reconcile write failed");
        return unavailable("the child reconcile failed");
      }),
    childRemoved: async (child, cause) =>
      (await children.removed(child, cause)).match(
        () => undefined,
        ({ cause }) => {
          // The stale pass marks the row `exited` on its next tick.
          log.warn({ err: cause, taskId, dockerId: child.dockerId }, "child exited write failed");
        },
      ),
  };
}
