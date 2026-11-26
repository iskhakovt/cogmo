import { DrizzleQueryError } from "drizzle-orm";
import { err, ok, type Result, ResultAsync } from "neverthrow";
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
 * the proxy answers the task, unless `cutOff` aborts first: the create's
 * deadline, or its socket's teardown.
 *
 * An insert the store or its driver fails leaves the daemon holding a
 * container no row records, so the container is removed, with its
 * anonymous volumes. So is one cut off: a create past its deadline would
 * otherwise answer 201 for a container the orphan pass may remove as
 * rowless, and one cut off by teardown would leave the cascade a row it
 * never listed. Either is answered at once, and the removal finishes in the
 * background, so a wedged daemon holds neither the answer nor the
 * admission. A removal the daemon refuses is logged, and the orphan pass
 * removes the rowless container once its grace window has passed.
 *
 * A cut-off insert that commits later is taken out of the live states: its
 * row moves to `exited` once the container is gone, the removal retried if
 * the daemon refused it, so the row holds no place under the child cap.
 * Any other throw, a column's schema refusing the row among them, is a bug
 * and is rethrown.
 */
export async function insertChildContainer(
  deps: InsertChildContainerDeps,
  child: ChildRecord,
  cutOff: AbortSignal,
): Promise<Result<ContainerRow, ChildRecordFailed>> {
  const inserting = deps.runInTx((tx) =>
    deps.store.insertContainer(tx, { ...child, labels: { ...child.labels } }),
  );
  const outcome = await raceCutOff(inserting, cutOff);
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
      inBackground(child, removeRowless(deps.docker, child.dockerId));
      return err<ContainerRow, ChildRecordFailed>({ kind: "record_failed" });
    })
    .with({ kind: "cut_off" }, async () => {
      log.warn({ dockerId: child.dockerId }, "child container row cut off, removing");
      inBackground(child, settleCutOff(deps, child, inserting));
      return err<ContainerRow, ChildRecordFailed>({ kind: "cut_off" });
    })
    .exhaustive();
}

type InsertOutcome =
  | { kind: "inserted"; row: ContainerRow }
  | { kind: "failed"; cause: unknown }
  | { kind: "cut_off" };

/** The insert's outcome, or the cut-off's, whichever comes first; the abort listener goes with the race. */
async function raceCutOff(
  inserting: Promise<ContainerRow>,
  cutOff: AbortSignal,
): Promise<InsertOutcome> {
  const settled = inserting.then(
    (row): InsertOutcome => ({ kind: "inserted", row }),
    (cause: unknown): InsertOutcome => ({ kind: "failed", cause }),
  );
  if (cutOff.aborted) return { kind: "cut_off" };
  let onAbort = () => {};
  const passed = new Promise<InsertOutcome>((resolve) => {
    onAbort = () => resolve({ kind: "cut_off" });
    cutOff.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([settled, passed]);
  } finally {
    cutOff.removeEventListener("abort", onAbort);
  }
}

/** Work left to finish after the answer; it settles its expected failures itself, so a rejection is a bug. */
function inBackground(child: ChildRecord, work: Promise<unknown>): void {
  work.catch((cause: unknown) =>
    log.error({ err: cause, dockerId: child.dockerId }, "finishing a child's rollback threw"),
  );
}

/**
 * Remove a cut-off create's container, and take a row its insert commits
 * after the cut-off out of the live states: `exited` once the container is
 * gone, the removal retried first if the daemon refused it. A row whose
 * container the daemon still refuses to remove stays `starting`, logged,
 * until the cascade or the TTL pass reaps it.
 */
async function settleCutOff(
  deps: InsertChildContainerDeps,
  child: ChildRecord,
  inserting: Promise<ContainerRow>,
): Promise<void> {
  const [late, removed] = await Promise.all([
    inserting.then(
      (row): LateInsert => ({ kind: "committed", row }),
      (cause: unknown): LateInsert => ({ kind: "failed", cause }),
    ),
    removeRowless(deps.docker, child.dockerId),
  ]);
  await match(late)
    .with({ kind: "failed" }, async ({ cause }) =>
      log.debug({ err: cause, dockerId: child.dockerId }, "a late child row insert failed"),
    )
    .with({ kind: "committed" }, async ({ row }) => {
      log.warn(
        { dockerId: child.dockerId, rowId: row.id },
        "a child row committed after its create was cut off",
      );
      const gone = removed || (await removeRowless(deps.docker, child.dockerId));
      if (!gone) {
        log.error(
          { dockerId: child.dockerId, rowId: row.id },
          "a cut-off child's container could not be removed; its row stays starting until it is reaped",
        );
        return;
      }
      await exitLateRow(deps, row);
    })
    .exhaustive();
}

type LateInsert = { kind: "committed"; row: ContainerRow } | { kind: "failed"; cause: unknown };

/** `starting → exited` for a late row whose container is gone; a failed write leaves it to the stale pass. */
async function exitLateRow(deps: InsertChildContainerDeps, row: ContainerRow): Promise<void> {
  const written = await ResultAsync.fromPromise(
    deps.runInTx((tx) =>
      deps.store.transitionContainerStatus(tx, {
        id: row.id,
        from: "starting",
        to: "exited",
        at: new Date(),
      }),
    ),
    (cause) => cause,
  );
  written.match(
    (result) =>
      match(result)
        .with({ kind: "transitioned" }, () =>
          log.info({ dockerId: row.dockerId }, "a cut-off child's late row marked exited"),
        )
        .with({ kind: "stale" }, ({ status }) =>
          log.debug(
            { dockerId: row.dockerId, status },
            "a cut-off child's late row already finished by another path",
          ),
        )
        .exhaustive(),
    (cause) =>
      log.warn(
        { err: cause, dockerId: row.dockerId },
        "a cut-off child's late row could not be marked exited; the stale pass marks it",
      ),
  );
}

/** Remove a container no row records, answering whether it went; a removal the daemon refuses is logged. */
async function removeRowless(docker: DockerFacade, dockerId: string): Promise<boolean> {
  const removed = await killAndRemoveContainer(docker, dockerId);
  return removed.match(
    () => true,
    (e) => {
      log.warn(
        { err: e.error, op: e.op, dockerId },
        "removing the rowless child failed; the orphan pass removes it",
      );
      return false;
    },
  );
}

/** How far down the `cause` chain a driver's error is worth looking for. */
const MAX_CAUSE_DEPTH = 4;

/**
 * A five-character SQLSTATE, which every Postgres error carries: its class,
 * the first two characters, starts with a digit or is one of the four
 * lettered classes (`F0`, `HV`, `P0`, `XX`), so a five-letter errno code
 * such as `EPERM` is not one.
 */
const SQLSTATE = /^(?:[0-9][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}$/;

/**
 * The connection failures raised under these codes: postgres-js's
 * `CONNECT_TIMEOUT` (its `CONNECTION_*` codes are matched by prefix), and
 * those of Node's sockets and resolver under it.
 */
const CONNECTION_CODES: ReadonlySet<string> = new Set([
  "CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
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
