import { ok, type Result, ResultAsync } from "neverthrow";
import { match, P } from "ts-pattern";
import type { Transactor } from "../db/index.js";
import { markContainerExited } from "./mark-container-exited.js";
import type { ChildExitCause, StoreFailed, TaskContainerRow } from "./proxy/index.js";
import type { ContainerTransitionResult, SandboxStore } from "./store/index.js";

interface MarkChildExitedDeps {
  store: SandboxStore;
  runInTx: Transactor;
}

/**
 * Mark a child's row `exited` once its container is gone without Cogmo
 * removing it: the task removed it through the proxy, or the daemon no
 * longer has it (design/sandbox.md → Container state machine). The
 * transition is from the status the caller read. A start that moved the
 * row `starting → running` after that read leaves it stale at `running`,
 * so the transition runs once more from there; any other stale status
 * belongs to a path that finished the row first. A row read as `exited`
 * needs nothing.
 */
export async function markChildExited(
  deps: MarkChildExitedDeps,
  args: {
    child: TaskContainerRow;
    cause: ChildExitCause;
    at: Date;
  },
): Promise<Result<void, StoreFailed>> {
  const { child, cause, at } = args;
  const exit = (from: "starting" | "running") =>
    ResultAsync.fromPromise(
      markContainerExited(deps, { id: child.id, dockerId: child.dockerId, from, at, cause }),
      (failure): StoreFailed => ({ kind: "store_failed", cause: failure }),
    );
  return match(child.status)
    .with("exited", async (): Promise<Result<void, StoreFailed>> => ok(undefined))
    .with(
      "running",
      async (): Promise<Result<void, StoreFailed>> => (await exit("running")).map(() => undefined),
    )
    .with("starting", async (): Promise<Result<void, StoreFailed>> => {
      const first = await exit("starting");
      if (first.isErr() || !movedToRunning(first.value)) return first.map(() => undefined);
      return (await exit("running")).map(() => undefined);
    })
    .exhaustive();
}

function movedToRunning(result: ContainerTransitionResult): boolean {
  return match(result)
    .with({ kind: "stale", status: "running" }, () => true)
    .with({ kind: "stale", status: P.union("starting", "exited", "reaped") }, () => false)
    .with({ kind: "transitioned" }, () => false)
    .exhaustive();
}
