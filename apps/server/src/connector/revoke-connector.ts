import type { Result } from "neverthrow";
import type { Transactor } from "../db/index.js";
import type { ConnectorStore } from "./store/index.js";

export interface RevokeConnectorDeps {
  runInTx: Transactor;
  connectorStore: ConnectorStore;
}

/**
 * Move an active connector to `revoked`, stamping `revoked_at` with `now`.
 * The row stays, and its name can be added again. `not_found` when no active
 * connector has the name.
 */
export async function revokeConnector(
  deps: RevokeConnectorDeps,
  args: { name: string; now: Date },
): Promise<Result<void, { kind: "not_found" }>> {
  const revoked = await deps.runInTx((tx) =>
    deps.connectorStore.revoke(tx, { name: args.name, now: args.now }),
  );
  return revoked.map(() => undefined);
}
