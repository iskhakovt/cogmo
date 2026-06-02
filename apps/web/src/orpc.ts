import type { WebContract } from "@cogmo/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";

/**
 * Fully-typed client derived from the shared `webContract` (`@cogmo/contracts`).
 * Every leaf's input/output/error types come straight from the contract the
 * server implements — no hand-authoring, no drift.
 */
export type WebApi = ContractRouterClient<WebContract>;

const link = new RPCLink({
  url: `${window.location.origin}/rpc`,
  // The session is an httpOnly cookie the JS can't read; ask fetch to attach it.
  fetch: (request, init) => fetch(request, { ...init, credentials: "include" }),
});

export const api: WebApi = createORPCClient(link);
