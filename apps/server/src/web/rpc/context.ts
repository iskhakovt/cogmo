import type { Transport } from "../../transport/transport.js";

/**
 * Sentinel `platformUserHandle` injected into Transport calls. The web channel
 * uses `fixed` identity with a single wildcard row, and `resolveUser` checks the
 * wildcard first — so any handle resolves to the owner. The value is opaque;
 * only that a request reached here (past the gate) matters.
 */
export const OWNER_HANDLE = "web-owner";

/** Per-request oRPC context: the resolved owner handle + the web-scoped Transport. */
export interface WebRpcContext {
  platformUserHandle: string;
  transport: Transport;
}
