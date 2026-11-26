import { DrizzleQueryError } from "drizzle-orm";
import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import type { DockerFacade } from "./docker-facade.js";
import { killAndRemoveContainer } from "./kill-and-remove-container.js";
import type { ChildRecord, ChildRecordFailed } from "./proxy/index.js";
import type { ContainerRow, SandboxStore } from "./store/index.js";

const log = logger.child({ component: "sandbox" });

interface InsertChildContainerDeps {
  store: SandboxStore;
  runInTx: Transactor;
  docker: DockerFacade;
}

/**
 * Insert the `containers` row of a child the daemon created through the
 * proxy, in `starting` (design/sandbox.md → Container state machine), before
 * the proxy answers the task, and within the create's `deadline`.
 *
 * An insert the store or its driver fails leaves the daemon holding a
 * container no row records, so it is removed here, with its anonymous
 * volumes; so is one the deadline passes first, since the orphan pass
 * would otherwise remove the rowless container under a create about to
 * answer 201. A removal the daemon refuses is logged, and the orphan pass
 * removes the rowless container once its grace window has passed. An
 * insert that commits after its deadline leaves a `starting` row over a
 * removed container, which the stale pass marks `exited`. Any other throw,
 * a column's schema refusing the row among them, is a bug and is rethrown.
 */
export async function insertChildContainer(
  deps: InsertChildContainerDeps,
  child: ChildRecord,
  deadline: AbortSignal,
): Promise<Result<ContainerRow, ChildRecordFailed>> {
  const inserting = deps.runInTx((tx) =>
    deps.store.insertContainer(tx, { ...child, labels: { ...child.labels } }),
  );
  const outcome = await raceDeadline(inserting, deadline);
  return match(outcome)
    .with(
      { kind: "inserted" },
      async ({ row }): Promise<Result<ContainerRow, ChildRecordFailed>> => {
        log.debug({ dockerId: child.dockerId, rowId: row.id }, "child container recorded");
        return ok(row);
      },
    )
    .with({ kind: "failed" }, async ({ cause }) => {
      if (!isStoreFailure(cause)) throw cause;
      log.error(
        { err: cause, dockerId: child.dockerId },
        "child container row insert failed, removing",
      );
      await removeRowless(deps.docker, child.dockerId);
      return err<ContainerRow, ChildRecordFailed>({ kind: "record_failed" });
    })
    .with({ kind: "deadline_passed" }, async () => {
      log.warn({ dockerId: child.dockerId }, "child container row not written in time, removing");
      // The insert may still commit, over the container removed here.
      inserting.then(
        () =>
          log.warn(
            { dockerId: child.dockerId },
            "a child row committed after its create's deadline; the stale pass marks it exited",
          ),
        (cause: unknown) =>
          log.debug({ err: cause, dockerId: child.dockerId }, "a late child row insert failed"),
      );
      await removeRowless(deps.docker, child.dockerId);
      return err<ContainerRow, ChildRecordFailed>({ kind: "deadline_passed" });
    })
    .exhaustive();
}

type InsertOutcome =
  | { kind: "inserted"; row: ContainerRow }
  | { kind: "failed"; cause: unknown }
  | { kind: "deadline_passed" };

/** The insert's outcome, or the deadline's, whichever comes first. */
function raceDeadline(
  inserting: Promise<ContainerRow>,
  deadline: AbortSignal,
): Promise<InsertOutcome> {
  const settled = inserting.then(
    (row): InsertOutcome => ({ kind: "inserted", row }),
    (cause: unknown): InsertOutcome => ({ kind: "failed", cause }),
  );
  if (deadline.aborted) return Promise.resolve({ kind: "deadline_passed" });
  const passed = new Promise<InsertOutcome>((resolve) => {
    deadline.addEventListener("abort", () => resolve({ kind: "deadline_passed" }), { once: true });
  });
  return Promise.race([settled, passed]);
}

/** Remove a container no row records; a removal the daemon refuses is logged for the orphan pass. */
async function removeRowless(docker: DockerFacade, dockerId: string): Promise<void> {
  const removed = await killAndRemoveContainer(docker, dockerId);
  removed.match(
    () => undefined,
    (e) =>
      log.warn(
        { err: e.error, op: e.op, dockerId },
        "removing the rowless child failed; the orphan pass removes it",
      ),
  );
}

/** How far down the `cause` chain a driver's error is worth looking for. */
const MAX_CAUSE_DEPTH = 4;

/** A five-character SQLSTATE, which every Postgres error carries. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/** The connection failures postgres-js and Node's sockets raise under these codes. */
const CONNECTION_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
]);

/**
 * Whether the store or its driver raised `cause`: a statement Drizzle sent
 * (`DrizzleQueryError`), or, on it or down its `cause` chain, an error
 * carrying a SQLSTATE or a connection failure's code, as a transaction's
 * own `begin` or `commit` raises it. A Node `ERR_*` code marks a
 * programmer error, never the store's.
 */
function isStoreFailure(cause: unknown): boolean {
  let current: unknown = cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current instanceof DrizzleQueryError) return true;
    if (typeof current !== "object" || current === null) return false;
    if ("code" in current && typeof current.code === "string" && isStoreCode(current.code)) {
      return true;
    }
    if (!("cause" in current)) return false;
    current = current.cause;
  }
  return false;
}

function isStoreCode(code: string): boolean {
  return SQLSTATE.test(code) || CONNECTION_CODES.has(code) || code.startsWith("CONNECTION_");
}
