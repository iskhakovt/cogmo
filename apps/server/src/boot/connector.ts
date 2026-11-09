/**
 * The connector server `cogmo serve` starts once the bootstrap finishes, when
 * `CONNECTOR_PORT` is set (design/connectors.md → Serving).
 */

import { SessionHub } from "../connector/hub.js";
import { type ConnectorServer, startConnectorServer } from "../connector/server.js";
import { env } from "../env.js";
import type { CoreDeps } from "./stages.js";

export async function startConnectors(
  boot: Pick<CoreDeps, "runInTx" | "connectorStore">,
): Promise<ConnectorServer | null> {
  if (env.CONNECTOR_PORT === undefined) return null;
  const hub = await SessionHub.create(
    { runInTx: boot.runInTx, connectorStore: boot.connectorStore },
    { leaseMs: env.CONNECTOR_LEASE_SECONDS * 1_000 },
  );
  return startConnectorServer({ hub, host: env.CONNECTOR_HOST, port: env.CONNECTOR_PORT });
}
