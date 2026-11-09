/**
 * The connector server: gRPC over plaintext HTTP/2 (h2c) on
 * `CONNECTOR_HOST`:`CONNECTOR_PORT` (design/connectors.md → Serving).
 */

import { createServer, type Http2Session } from "node:http2";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { logger } from "../logger.js";
import type { ConnectorHub } from "./hub.js";
import { connectorRoutes } from "./service.js";

/** HTTP/2 keepalive: a ping this often, and a connection that misses one this long is closed. */
const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 20_000;
/** How long `close` lets open streams finish before destroying their connections. */
const CLOSE_GRACE_MS = 2_000;

/** The largest message cogmo reads, gRPC's default; a larger one fails `RESOURCE_EXHAUSTED`. */
const READ_MAX_BYTES = 4 * 1024 * 1024;

export interface ConnectorServer {
  /** The bound port; the ephemeral one when started on port 0. */
  readonly port: number;
  /**
   * Ends every session in the hub, then closes every connection, destroying
   * those with streams still open after a 2 s grace.
   */
  close(): Promise<void>;
}

export async function startConnectorServer(params: {
  hub: ConnectorHub;
  host: string;
  port: number;
}): Promise<ConnectorServer> {
  const { hub, host, port } = params;
  const handler = connectNodeAdapter({
    routes: connectorRoutes(hub),
    grpc: true,
    grpcWeb: false,
    connect: false,
    readMaxBytes: READ_MAX_BYTES,
  });
  const server = createServer(handler);
  const sessions = new Set<Http2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    const pings = setInterval(() => ping(session), PING_INTERVAL_MS);
    session.once("close", () => {
      clearInterval(pings);
      sessions.delete(session);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the connector server is not bound to a TCP port");
  }
  const bound = address.port;
  logger.info({ host, port: bound }, "connector server listening");

  return {
    port: bound,
    close: async () => {
      hub.close();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const session of sessions) session.close();
      const force = setTimeout(() => {
        for (const session of sessions) session.destroy();
      }, CLOSE_GRACE_MS);
      await closed;
      clearTimeout(force);
    },
  };
}

function ping(session: Http2Session): void {
  if (session.closed || session.destroyed) return;
  const deadline = setTimeout(() => session.destroy(), PING_TIMEOUT_MS);
  const sent = session.ping((error) => {
    clearTimeout(deadline);
    if (error) session.destroy();
  });
  if (!sent) clearTimeout(deadline);
}
