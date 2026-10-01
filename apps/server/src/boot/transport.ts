/**
 * Transport: the session timing every channel shares, the channel adapters,
 * the delivery router, the web UI's Transport, and the session functions
 * (idle timer, debounce, conversation-boundary prompt).
 */

import type { CodingStreamingRegistry } from "../agent/coding/streaming-registry.js";
import type { CompactConversationResult } from "../agent/conversation/compact-conversation.js";
import { createDebounceFunctions, type DebounceConfig } from "../agent/debounce.js";
import type { TriggerReflectionResult } from "../agent/evolution/index.js";
import { createIdleTimer } from "../agent/idle-timer.js";
import { env } from "../env.js";
import { inboundArrived, inngest } from "../inngest/index.js";
import type { McpRegistryImpl } from "../mcp/registry.js";
import type { SkillRunnerImpl } from "../skills/runner.js";
import { WebStreamRegistry } from "../transport/adapters/web/stream-registry.js";
import { createBoundaryJanitor } from "../transport/boundary/janitor.js";
import { createBoundaryWaiter } from "../transport/boundary/waiter.js";
import { createDeliveryRouter } from "../transport/delivery-router.js";
import { startChannels } from "../transport/registry.js";
import { createTransport, type Transport } from "../transport/transport.js";
import type { CoreDeps } from "./stages.js";

export interface SessionTiming {
  idleTimeoutMs: number;
  debounceConfig: DebounceConfig;
}

export function sessionTiming(): SessionTiming {
  return {
    idleTimeoutMs: env.SESSION_IDLE_TIMEOUT_MINUTES * 60 * 1000,
    debounceConfig: {
      idleTimeoutMs: env.DEBOUNCE_IDLE_SECONDS * 1000,
      maxWaitMs: env.DEBOUNCE_MAXWAIT_SECONDS * 1000,
      resumePolicy: env.DEBOUNCE_RESUME_POLICY,
    },
  };
}

/** What every Transport drives besides the stores. */
export interface TransportWiring {
  idleTimeoutMs: number;
  skillRunner: SkillRunnerImpl;
  mcpRegistry: McpRegistryImpl;
  codingStreamingRegistry: CodingStreamingRegistry;
  triggerReflection: (conversationId: string) => Promise<TriggerReflectionResult>;
  compactConversation: (conversationId: string) => Promise<CompactConversationResult>;
}

/** Start the channel adapters, then the delivery router and web Transport over them. */
export async function startTransport(core: CoreDeps, wiring: TransportWiring) {
  // Bridge between the WebUiAdapter (streamed turns) and the UI server's SSE
  // routes (open tab connections) — one shared instance, both sides below.
  const webStreamRegistry = new WebStreamRegistry();

  // What every channel's Transport and the web UI's share.
  const transportDeps = {
    defaultUserId: core.user.id,
    defaultProfileId: core.profile.id,
    runInTx: core.runInTx,
    transportStore: core.transportStore,
    agentStore: core.agentStore,
    codingStore: core.codingStore,
    secretsStore: core.secretsStore,
    reposDir: env.COGMO_REPOS_DIR,
    skillRunner: wiring.skillRunner,
    skillStore: core.skillStore,
    mcpRegistry: wiring.mcpRegistry,
    triggerReflection: wiring.triggerReflection,
    compactConversation: wiring.compactConversation,
    inngest,
    inboundArrived,
    attachments: core.attachmentStore,
    idleTimeoutMs: wiring.idleTimeoutMs,
  };

  const {
    functions: channelFunctions,
    adapters,
    adapterMap,
  } = await startChannels({
    ...transportDeps,
    webStream: webStreamRegistry,
    codingStreamingRegistry: wiring.codingStreamingRegistry,
    pipelineRunStore: core.pipelineRunStore,
    boundary: {
      promptTimeoutMs: env.BOUNDARY_PROMPT_TIMEOUT_SECONDS * 1000,
      minUserTurns: env.BOUNDARY_PROMPT_MIN_USER_TURNS,
    },
  });

  const deliveryRouter = createDeliveryRouter({
    runInTx: core.runInTx,
    adapters: adapterMap,
    transportStore: core.transportStore,
  });

  // Web-scoped Transport the UI server's oRPC layer drives directly — distinct
  // from the inert Transport startChannels builds for the placeholder web
  // adapter. Scoped to the web channel's fixed/wildcard identity -> the owner.
  const webChannel = await core.runInTx((tx) => core.transportStore.getChannelByType(tx, "web"));
  const webTransport: Transport | null = webChannel
    ? createTransport({
        ...transportDeps,
        channelId: webChannel.id,
        // Tabs watch the whole conversation, not just turns they sent.
        sessionReceive: "all",
      })
    : null;

  return { webStreamRegistry, channelFunctions, adapters, deliveryRouter, webTransport };
}

export function createSessionFunctions(core: CoreDeps, timing: SessionTiming) {
  const idleTimer = createIdleTimer({ idleTimeoutMs: timing.idleTimeoutMs });
  const debounceFunctions = createDebounceFunctions(timing.debounceConfig);
  const boundaryDeps = {
    runInTx: core.runInTx,
    transportStore: core.transportStore,
    agentStore: core.agentStore,
    inngest,
    defaultProfileId: core.profile.id,
  };
  const boundaryWaiter = createBoundaryWaiter(boundaryDeps);
  const boundaryJanitor = createBoundaryJanitor({
    ...boundaryDeps,
    gracePeriodMs: env.BOUNDARY_PROMPT_TIMEOUT_SECONDS * 2 * 1000,
  });
  return { idleTimer, debounceFunctions, boundaryWaiter, boundaryJanitor };
}
