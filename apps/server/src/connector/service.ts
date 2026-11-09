/**
 * `ConnectorService` over the session hub: authenticates each call and maps
 * the hub's results onto gRPC status codes (design/connectors.md → Wire
 * contract).
 */

import { constants, type Http2Stream } from "node:http2";
import { ConnectorService } from "@cogmo/connector-proto";
import {
  Code,
  ConnectError,
  type ConnectRouter,
  createContextKey,
  type HandlerContext,
  type ServiceImpl,
} from "@connectrpc/connect";
import type { Result } from "neverthrow";
import { match } from "ts-pattern";
import type { ConnectorHub, JobCallError } from "./hub.js";
import type { SessionEnd } from "./session.js";
import type { ActiveConnector } from "./store/index.js";

/** The request's HTTP/2 stream, which the server puts in each call's context. */
export const HTTP2_STREAM = createContextKey<Http2Stream | undefined>(undefined, {
  description: "the request's HTTP/2 stream",
});

/** How long a session the hub ended may take to close its stream before it is reset. */
const ENDED_STREAM_GRACE_MS = 2_000;

export function connectorRoutes(hub: ConnectorHub): (router: ConnectRouter) => void {
  return (router) => router.service(ConnectorService, connectorService(hub));
}

function connectorService(hub: ConnectorHub): ServiceImpl<typeof ConnectorService> {
  return {
    async *connect(request, context) {
      const connector = await authenticate(hub, context);
      const session = hub.openSession(connector, request.heldJobIds);
      // A peer that stops reading leaves the stream stuck behind data it never
      // takes, the status that ends it queued after; reset it unless it closes
      // within a grace.
      const stream = context.values.get(HTTP2_STREAM);
      const onEnded = () => {
        if (stream === undefined) return;
        const reset = setTimeout(
          () => stream.close(constants.NGHTTP2_CANCEL),
          ENDED_STREAM_GRACE_MS,
        );
        stream.once("close", () => clearTimeout(reset));
      };
      session.ended.addEventListener("abort", onEnded, { once: true });
      try {
        yield* session.messages(context.signal);
      } finally {
        session.ended.removeEventListener("abort", onEnded);
        session.close();
      }
      if (session.endReason !== null) throw sessionEnded(session.endReason);
    },
    async acceptJob(request, context) {
      const connector = await authenticate(hub, context);
      unwrap(hub.acceptJob(connector, request.jobId));
      return {};
    },
    async reportEvents(request, context) {
      const connector = await authenticate(hub, context);
      unwrap(hub.reportEvents(connector, request.jobId, request.events));
      return {};
    },
    async finishJob(request, context) {
      const connector = await authenticate(hub, context);
      unwrap(hub.finishJob(connector, request));
      return {};
    },
  };
}

async function authenticate(hub: ConnectorHub, context: HandlerContext): Promise<ActiveConnector> {
  const header = context.requestHeader.get("authorization") ?? "";
  const token = /^Bearer (\S+)$/.exec(header)?.[1];
  if (token === undefined) {
    throw new ConnectError("expected `authorization: Bearer <token>`", Code.Unauthenticated);
  }
  const connector = await hub.authenticate(token);
  if (connector.isOk()) return connector.value;
  throw match(connector.error)
    .with(
      { kind: "unauthenticated" },
      () => new ConnectError("unknown token", Code.Unauthenticated),
    )
    .with(
      { kind: "unavailable" },
      () => new ConnectError("cogmo could not check the token", Code.Unavailable),
    )
    .exhaustive();
}

function unwrap(result: Result<void, JobCallError>): void {
  if (result.isOk()) return;
  throw match(result.error)
    .with({ kind: "not_found" }, () => new ConnectError("no such job", Code.NotFound))
    .with(
      { kind: "permission_denied" },
      () => new ConnectError("the job belongs to another connector", Code.PermissionDenied),
    )
    .with(
      { kind: "invalid_argument" },
      ({ message }) => new ConnectError(message, Code.InvalidArgument),
    )
    .exhaustive();
}

function sessionEnded(reason: SessionEnd): ConnectError {
  return match(reason)
    .with(
      "replaced",
      () => new ConnectError("a newer session for this connector replaced this one", Code.Aborted),
    )
    .with(
      "unauthenticated",
      () => new ConnectError("the connector's token was rotated or revoked", Code.Unauthenticated),
    )
    .with(
      "auth_unavailable",
      () => new ConnectError("cogmo cannot check connector tokens", Code.Unavailable),
    )
    .with("shutdown", () => new ConnectError("cogmo is shutting down", Code.Unavailable))
    .exhaustive();
}
