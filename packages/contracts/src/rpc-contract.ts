import { oc, type } from "@orpc/contract";
import { z } from "zod";
import type {
  ChatHistoryMessage,
  ConversationSummary,
  CustomCompartment,
  Profile,
  ProfileClass,
  ScheduledTaskSummary,
} from "./domain.js";
import type {
  EvolutionEventEntry,
  McpServerSummary,
  RepoSummary,
  SkillListEntry,
} from "./transport.js";
import { TransportErrorSchema } from "./transport-error-schema.js";

/**
 * Contract-first definition of the web admin API. The server `implement`s it
 * (`apps/server/src/web/rpc/router.ts`) and the SPA derives a fully-typed client
 * from it (`apps/web/src/orpc.ts`) — no hand-authored client.
 *
 * Read surface only for now: the `list`/`get` reads the screens render.
 * Mutations append here (and in the server implementation + screens) as their
 * editing UIs land. Outputs reuse the shared DTOs via the type-only `type<T>()`
 * schema — the success value of each Transport `Result`; `Result` errors surface
 * as the single generic `TRANSPORT_ERROR` carrying the `TransportError` union.
 */
const base = oc.errors({ TRANSPORT_ERROR: { data: TransportErrorSchema } });

export const webContract = {
  conversations: {
    list: base.output(type<readonly ConversationSummary[]>()),
    getMessages: base
      .input(z.object({ conversationId: z.string() }))
      .output(type<readonly ChatHistoryMessage[]>()),
  },
  profiles: {
    list: base.output(type<readonly Profile[]>()),
  },
  profileClasses: {
    list: base.output(type<readonly ProfileClass[]>()),
  },
  compartments: {
    list: base.output(type<readonly CustomCompartment[]>()),
  },
  models: {
    // No identity, no Result — the model list directly.
    list: oc.output(type<readonly string[]>()),
  },
  repos: {
    list: base.output(type<readonly RepoSummary[]>()),
  },
  skills: {
    list: base.output(type<readonly SkillListEntry[]>()),
  },
  scheduling: {
    list: base.output(type<readonly ScheduledTaskSummary[]>()),
  },
  mcp: {
    listServers: base.output(type<readonly McpServerSummary[]>()),
    // Sync, no identity, no Result.
    toolBudget: oc.output(type<number>()),
  },
  evolution: {
    listEvents: base.output(type<readonly EvolutionEventEntry[]>()),
    getEvent: base.input(z.object({ id: z.string() })).output(type<EvolutionEventEntry | null>()),
  },
};

/** The contract's type — the SPA derives its fully-typed client from this. */
export type WebContract = typeof webContract;
