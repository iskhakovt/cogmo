import { type Client, createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

/**
 * Hand-authored client contract. Phase 1b renders exactly one read, so the
 * surface is typed by hand rather than derived from the server router — a fully
 * typed client (every Transport namespace) needs a type-only router export from
 * packages/contracts, which lands with the Phase 3 screens. Each leaf is an
 * oRPC `Client<Context, Input, Output, Error>`; the empty context + `void` input
 * make `api.models.list()` a no-argument call returning `string[]`.
 *
 * A `type` (not `interface`): oRPC's `NestedClient` is keyed by a string index
 * signature, and only type aliases get an implicit index signature — an
 * interface wouldn't satisfy the `createORPCClient` constraint.
 */
export type WebApi = {
  models: {
    list: Client<Record<never, never>, void, string[], Error>;
  };
};

const link = new RPCLink({
  // Same origin as the served SPA (prod) or the Vite dev proxy (dev).
  url: `${window.location.origin}/rpc`,
  // The session is an httpOnly cookie the JS can't read; ask fetch to attach it.
  fetch: (request, init) => fetch(request, { ...init, credentials: "include" }),
});

export const api: WebApi = createORPCClient(link);
