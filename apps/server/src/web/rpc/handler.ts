import type { IncomingMessage, ServerResponse } from "node:http";
import { RPCHandler } from "@orpc/server/node";
import type { WebRpcContext } from "./context.js";
import { webRouter } from "./router.js";

const handler = new RPCHandler(webRouter);

/**
 * Dispatch an `/rpc/*` request through the oRPC handler with the authenticated
 * context. `matched: false` means no procedure matched the path — the caller
 * 404s. The handler writes the response itself on a match.
 */
export function handleRpc(
  req: IncomingMessage,
  res: ServerResponse,
  context: WebRpcContext,
): Promise<{ matched: boolean }> {
  return handler.handle(req, res, { prefix: "/rpc", context });
}
