import { err, type Result } from "neverthrow";
import type { Transactor } from "../db/index.js";
import type { ConnectorKind, ConnectorStore } from "./store/index.js";
import { newConnectorToken } from "./token.js";

/** A connector name: lowercase ASCII letters, digits, `-` and `_`, letter-led, at most 32 chars. */
export const CONNECTOR_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export interface AddConnectorDeps {
  runInTx: Transactor;
  connectorStore: ConnectorStore;
}

export type AddConnectorError = { kind: "invalid_name" } | { kind: "name_taken" };

/**
 * Register a connector and mint its bearer token. The raw token is returned
 * once, here; only its SHA-256 is stored. `name_taken` when an active
 * connector holds the name.
 */
export async function addConnector(
  deps: AddConnectorDeps,
  args: { name: string; kind: ConnectorKind },
): Promise<Result<{ id: string; token: string }, AddConnectorError>> {
  if (!CONNECTOR_NAME_RE.test(args.name)) return err({ kind: "invalid_name" });
  const { rawToken, tokenHash } = newConnectorToken();
  const inserted = await deps.runInTx((tx) =>
    deps.connectorStore.insert(tx, { name: args.name, kind: args.kind, tokenHash }),
  );
  return inserted.map(({ id }) => ({ id, token: rawToken }));
}
