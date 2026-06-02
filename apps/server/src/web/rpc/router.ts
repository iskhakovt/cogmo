import { os } from "@orpc/server";
import type { Result } from "neverthrow";
import { z } from "zod";
import type { TransportError } from "../../transport/transport.js";
import { TransportErrorSchema } from "../transport-error-schema.js";
import type { WebRpcContext } from "./context.js";

/**
 * oRPC admin API over the channel-scoped `Transport`. Thin: each procedure
 * resolves the owner handle from the context (never the request body), calls the
 * matching Transport method, and surfaces failures as one generic typed error.
 *
 * Failures cross the wire as `TRANSPORT_ERROR` carrying the `TransportError`
 * union as `data`; the client re-narrows on `data.code`. One generic error
 * (not 48 per-code) keeps the layer mechanical while preserving typed-error
 * semantics + OpenAPI docs.
 *
 * PR1 wires the READ surface only — the `list`/`get` methods that take just the
 * owner handle. Tab-address-scoped reads (conversations.getCurrent/summary,
 * chats.getDefaultProfile) arrive with the chat path; mutations append as their
 * editing screens land. Incremental delivery, not a temporary shim.
 */
const base = os.$context<WebRpcContext>().errors({
  TRANSPORT_ERROR: { data: TransportErrorSchema },
});

/** Build a no-input procedure from a `Result`-returning Transport accessor. */
function resultProcedure<T>(fn: (ctx: WebRpcContext) => Promise<Result<T, TransportError>>) {
  return base.handler(async ({ context, errors }) => {
    const result = await fn(context);
    if (result.isErr()) throw errors.TRANSPORT_ERROR({ data: result.error });
    return result.value;
  });
}

export const webRouter = {
  conversations: {
    list: resultProcedure((c) => c.transport.conversations.list(c.platformUserHandle)),
  },
  profiles: {
    list: resultProcedure((c) => c.transport.profiles.list(c.platformUserHandle)),
  },
  profileClasses: {
    list: resultProcedure((c) => c.transport.profileClasses.list(c.platformUserHandle)),
  },
  compartments: {
    list: resultProcedure((c) => c.transport.compartments.list(c.platformUserHandle)),
  },
  models: {
    // No identity, no Result — returns the model list directly.
    list: base.handler(({ context }) => context.transport.models.list()),
  },
  repos: {
    // No identity; returns a Result (e.g. sandbox_disabled).
    list: resultProcedure((c) => c.transport.repos.list()),
  },
  skills: {
    list: resultProcedure((c) => c.transport.skills.list(c.platformUserHandle)),
  },
  scheduling: {
    list: resultProcedure((c) => c.transport.scheduling.list(c.platformUserHandle)),
  },
  mcp: {
    listServers: resultProcedure((c) => c.transport.mcp.listServers(c.platformUserHandle)),
    // Sync, no identity, no Result.
    toolBudget: base.handler(({ context }) => context.transport.mcp.toolBudget()),
  },
  evolution: {
    listEvents: resultProcedure((c) => c.transport.evolution.listEvents(c.platformUserHandle)),
    getEvent: base
      .input(z.object({ id: z.string() }))
      .handler(async ({ input, context, errors }) => {
        const result = await context.transport.evolution.getEvent(
          context.platformUserHandle,
          input.id,
        );
        if (result.isErr()) throw errors.TRANSPORT_ERROR({ data: result.error });
        return result.value;
      }),
  },
};
