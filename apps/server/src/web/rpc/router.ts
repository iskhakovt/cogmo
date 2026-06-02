import { type McpServerSummary, webContract } from "@cogmo/contracts";
import { implement } from "@orpc/server";
import type { Result } from "neverthrow";
import type { McpServerStatus } from "../../mcp/config.js";
import type { TransportError } from "../../transport/transport.js";
import type { WebRpcContext } from "./context.js";

/**
 * oRPC admin API — the server-side implementation of `webContract`
 * (`@cogmo/contracts`). Thin: each procedure resolves the owner handle from the
 * context (never the request body), calls the matching Transport method, and
 * surfaces a `Result` failure as the single generic `TRANSPORT_ERROR` carrying
 * the `TransportError` union as `data`. The client re-narrows on `data.code`.
 *
 * Read surface only for now; mutations append as their editing screens land.
 */
const os = implement(webContract).$context<WebRpcContext>();

/** Unwrap a Transport `Result`, throwing the generic typed error on failure. */
function unwrap<T>(
  result: Result<T, TransportError>,
  fail: (opts: { data: TransportError }) => Error,
): T {
  if (result.isErr()) throw fail({ data: result.error });
  return result.value;
}

/** Project the server-side MCP status onto the client-safe summary (no config). */
function toMcpServerSummary(s: McpServerStatus): McpServerSummary {
  return {
    id: s.id,
    name: s.name,
    transport: s.config.transport,
    enabled: s.enabled,
    approvalStatus: s.approvalStatus,
    toolCount: s.toolCount,
    approvedToolCount: s.approvedToolCount,
    lastConnectedAt: s.lastConnectedAt,
    lastError: s.lastError,
    createdAt: s.createdAt,
  };
}

export const webRouter = os.router({
  conversations: {
    list: os.conversations.list.handler(async ({ context, errors }) =>
      unwrap(
        await context.transport.conversations.list(context.platformUserHandle),
        errors.TRANSPORT_ERROR,
      ),
    ),
    getMessages: os.conversations.getMessages.handler(async ({ context, input, errors }) =>
      unwrap(
        await context.transport.conversations.getMessages(
          context.platformUserHandle,
          input.conversationId,
        ),
        errors.TRANSPORT_ERROR,
      ),
    ),
  },
  profiles: {
    list: os.profiles.list.handler(async ({ context, errors }) =>
      unwrap(
        await context.transport.profiles.list(context.platformUserHandle),
        errors.TRANSPORT_ERROR,
      ),
    ),
  },
  profileClasses: {
    list: os.profileClasses.list.handler(async ({ context, errors }) =>
      unwrap(
        await context.transport.profileClasses.list(context.platformUserHandle),
        errors.TRANSPORT_ERROR,
      ),
    ),
  },
  compartments: {
    list: os.compartments.list.handler(async ({ context, errors }) =>
      unwrap(
        await context.transport.compartments.list(context.platformUserHandle),
        errors.TRANSPORT_ERROR,
      ),
    ),
  },
  models: {
    list: os.models.list.handler(({ context }) => context.transport.models.list()),
  },
  repos: {
    list: os.repos.list.handler(async ({ context, errors }) =>
      unwrap(await context.transport.repos.list(), errors.TRANSPORT_ERROR),
    ),
  },
  skills: {
    list: os.skills.list.handler(async ({ context, errors }) =>
      unwrap(
        await context.transport.skills.list(context.platformUserHandle),
        errors.TRANSPORT_ERROR,
      ),
    ),
  },
  scheduling: {
    list: os.scheduling.list.handler(async ({ context, errors }) =>
      unwrap(
        await context.transport.scheduling.list(context.platformUserHandle),
        errors.TRANSPORT_ERROR,
      ),
    ),
  },
  mcp: {
    listServers: os.mcp.listServers.handler(async ({ context, errors }) => {
      const result = await context.transport.mcp.listServers(context.platformUserHandle);
      if (result.isErr()) throw errors.TRANSPORT_ERROR({ data: result.error });
      return result.value.map(toMcpServerSummary);
    }),
    toolBudget: os.mcp.toolBudget.handler(({ context }) => context.transport.mcp.toolBudget()),
  },
  evolution: {
    listEvents: os.evolution.listEvents.handler(async ({ context, errors }) =>
      unwrap(
        await context.transport.evolution.listEvents(context.platformUserHandle),
        errors.TRANSPORT_ERROR,
      ),
    ),
    getEvent: os.evolution.getEvent.handler(async ({ context, input, errors }) =>
      unwrap(
        await context.transport.evolution.getEvent(context.platformUserHandle, input.id),
        errors.TRANSPORT_ERROR,
      ),
    ),
  },
});
