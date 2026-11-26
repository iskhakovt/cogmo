/**
 * The writes a child's create, start and removal bring, as the plans in
 * `child-plan.ts` call them, over the boot stage's `ChildContainers`
 * (design/sandbox.md → Proxy Design → Child containers). A failed insert is
 * `record_failed`, since its container is gone; a failed transition is
 * logged and the daemon's own answer stands, since every reap covers the
 * state the row is left in.
 */

import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { logger } from "../../logger.js";
import type { ChildContext } from "./child-plan.js";
import { notFound, type ProxyRejection, recordFailed } from "./rejection.js";
import type { ChildContainers } from "./types.js";

const log = logger.child({ component: "sandbox.proxy" });

export function childWrites(
  children: ChildContainers,
  taskId: string,
): Pick<ChildContext, "recordChild" | "childStarted" | "childRemoved"> {
  return {
    recordChild: async (child) =>
      children
        .record(child)
        .mapErr(() => recordFailed("the created container's row could not be recorded")),
    childStarted: async (child, ref) =>
      (await children.started(child)).match(
        (outcome): Result<void, ProxyRejection> =>
          match(outcome)
            .with({ kind: "running" }, (): Result<void, ProxyRejection> => ok(undefined))
            .with({ kind: "finished" }, () => err(notFound(`No such container: ${ref}`)))
            .exhaustive(),
        ({ cause }) => {
          // The row under-reports `running`, which every reap covers.
          log.warn({ err: cause, taskId, dockerId: child.dockerId }, "child running write failed");
          return ok(undefined);
        },
      ),
    childRemoved: async (child) =>
      (await children.removed(child)).match(
        () => undefined,
        ({ cause }) => {
          // The stale pass marks the row `exited` on its next tick.
          log.warn({ err: cause, taskId, dockerId: child.dockerId }, "child exited write failed");
        },
      ),
  };
}
