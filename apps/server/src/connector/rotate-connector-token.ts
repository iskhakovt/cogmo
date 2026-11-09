import type { Result } from "neverthrow";
import type { Transactor } from "../db/index.js";
import type { ConnectorStore } from "./store/index.js";
import { newConnectorToken } from "./token.js";

export interface RotateConnectorTokenDeps {
  runInTx: Transactor;
  connectorStore: ConnectorStore;
}

/**
 * Replace an active connector's bearer token. The raw token is returned once,
 * here; only its SHA-256 is stored. `not_found` when no active connector has
 * the name.
 */
export async function rotateConnectorToken(
  deps: RotateConnectorTokenDeps,
  args: { name: string },
): Promise<Result<{ token: string }, { kind: "not_found" }>> {
  const { rawToken, tokenHash } = newConnectorToken();
  const rotated = await deps.runInTx((tx) =>
    deps.connectorStore.rotateToken(tx, { name: args.name, tokenHash }),
  );
  return rotated.map(() => ({ token: rawToken }));
}
