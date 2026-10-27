import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { logger } from "../../logger.js";
import type { SkillDeployStatus } from "../store/index.js";
import type { DeployDeps } from "./deploy-deps.js";

const log = logger.child({ component: "skills.runner" });

/**
 * Why a deny resolved nothing. `not_pending` carries the status the row
 * holds, so a second tap or a late CLI call reads as "already resolved".
 */
export type DenyDeployError =
  | { kind: "not_found"; pendingId: string }
  | { kind: "not_pending"; pendingId: string; status: SkillDeployStatus };

/** One line naming the miss, for the CLI. */
export function describeDenyDeployError(error: DenyDeployError): string {
  return match(error)
    .with({ kind: "not_found" }, ({ pendingId }) => `deploy not found: ${pendingId}`)
    .with(
      { kind: "not_pending" },
      ({ pendingId, status }) => `deploy ${pendingId} is not pending: status is '${status}'`,
    )
    .exhaustive();
}

/**
 * Resolve a pending deploy as denied; main does not move. The reason has no
 * column on the row, so the log line of the transition is its record.
 */
export async function denyDeploy(
  deps: Pick<DeployDeps, "store" | "runInTx">,
  opts: { pendingId: string; reason?: string },
): Promise<Result<void, DenyDeployError>> {
  const transition = await deps.runInTx((tx) =>
    deps.store.denyPendingDeploy(tx, { pendingId: opts.pendingId }),
  );
  return match(transition)
    .returnType<Result<void, DenyDeployError>>()
    .with({ kind: "transitioned" }, () => {
      log.info({ pendingId: opts.pendingId, reason: opts.reason ?? null }, "skill deploy denied");
      return ok(undefined);
    })
    .with({ kind: "not_found" }, () => err({ kind: "not_found", pendingId: opts.pendingId }))
    .with({ kind: "not_pending" }, ({ status }) =>
      err({ kind: "not_pending", pendingId: opts.pendingId, status }),
    )
    .exhaustive();
}
