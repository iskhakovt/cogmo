import type { ChatHistoryMessage, ConversationSummary } from "@cogmo/contracts";
import { type Client, createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

/**
 * Hand-authored client contract — the reads the SPA renders. A fully typed
 * client over every Transport namespace waits on a type-only router export from
 * packages/contracts (a Phase 3 refactor). Each leaf is an oRPC
 * `Client<Context, Input, Output, Error>`.
 *
 * A `type` (not `interface`): oRPC's `NestedClient` is keyed by a string index
 * signature, which only type aliases satisfy.
 */
export type WebApi = {
  models: {
    list: Client<Record<never, never>, void, string[], Error>;
  };
  conversations: {
    list: Client<Record<never, never>, void, ConversationSummary[], Error>;
    getMessages: Client<
      Record<never, never>,
      { conversationId: string },
      ChatHistoryMessage[],
      Error
    >;
  };
};

const link = new RPCLink({
  url: `${window.location.origin}/rpc`,
  // The session is an httpOnly cookie the JS can't read; ask fetch to attach it.
  fetch: (request, init) => fetch(request, { ...init, credentials: "include" }),
});

export const api: WebApi = createORPCClient(link);
