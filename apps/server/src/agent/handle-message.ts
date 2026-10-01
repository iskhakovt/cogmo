import type { Transactor } from "../db/index.js";
import { inngest } from "../inngest/client.js";
import { conversationTurnConcurrency } from "../inngest/concurrency.js";
import { inboundReady, responseReady } from "../inngest/events.js";
import type { LlmProviderResolver } from "../llm/resolver.js";
import { logger } from "../logger.js";
import type { McpRegistry } from "../mcp/registry.js";
import type { MemoryProvider } from "../memory/provider.js";
import type { SkillRunner } from "../skills/runner.js";
import type { AttachmentStore } from "../transport/attachment-store.js";
import type { DeliveryRouter } from "../transport/delivery-router.js";
import type { TransportStore } from "../transport/store/index.js";
import type { VoiceProviderResolver } from "../voice/resolver.js";
import type { CodingService } from "./coding/service.js";
import type { DebounceConfig } from "./debounce.js";
import { admitTurn } from "./handle-message/admit-turn.js";
import { assembleTurnContext } from "./handle-message/assemble-turn-context.js";
import { buildChatTurnService } from "./handle-message/chat-turn-service.js";
import { compactTurn } from "./handle-message/compact-turn.js";
import { deliverReply } from "./handle-message/deliver-reply.js";
import { finalizeTurnContext } from "./handle-message/finalize-turn-context.js";
import { freezeTurnInputs } from "./handle-message/freeze-turn-inputs.js";
import { batchCursors, routingKindOf } from "./handle-message/inbound-batch.js";
import { loadTurnTranscript } from "./handle-message/load-turn-transcript.js";
import { persistTurn } from "./handle-message/persist-turn.js";
import { recordUserMessage } from "./handle-message/record-user-message.js";
import { reportTurnFailure } from "./handle-message/report-turn-failure.js";
import { resolveInboundAttachments } from "./handle-message/resolve-attachments.js";
import { resolveTurnModel } from "./handle-message/resolve-turn-model.js";
import { runTurnLoop } from "./handle-message/run-turn-loop.js";
import type { ImageToolsLoader } from "./image-tools-loader.js";
import type { AgentLoopResult, StreamingAgentLoopParams } from "./loop.js";
import type { PipelineRunStore, PipelineStore } from "./pipeline/store/index.js";
import type { PromptSource } from "./prompt.js";
import type { Service } from "./service.js";
import type { AgentStore } from "./store/index.js";
import type { ToolRegistry } from "./tools.js";
import { createTurnStepRunner } from "./turn-step-runner.js";
export interface HandleMessageDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  transportStore: TransportStore;
  /**
   * Per-turn provider lookup. Resolved against `snapshot.model` after the
   * `load-turn-snapshot` step so each turn dispatches to whichever
   * provider serves the conversation's currently selected model. The
   * production resolver in `src/llm/resolver.ts` memoizes by model — the
   * decrypted-secret + adapter cost is paid once per (process, model)
   * pair, not per turn.
   */
  resolveProvider: LlmProviderResolver;
  tools: ToolRegistry;
  /**
   * Per-turn loader for the `generate_image` tool set. Re-queries
   * `image_providers` + `image_models` on every call so wizard / CLI
   * mutations surface without a process restart. Optional only because some
   * unit tests bypass image gen entirely; production wiring always populates
   * it. Cached adapter instances live on the loader, so the per-turn cost is
   * two cheap selects on small tables.
   */
  imageToolsLoader?: ImageToolsLoader;
  memory: MemoryProvider;
  promptSource: PromptSource;
  fileService: Service["files"];
  attachments: AttachmentStore;
  debounceConfig: DebounceConfig;
  deliveryRouter: DeliveryRouter;
  runStreamingAgentLoop: (params: StreamingAgentLoopParams) => Promise<AgentLoopResult>;
  /**
   * Optional factory that constructs a coding service scoped to this turn's
   * conversation. Bootstrap supplies it when the sandbox module is
   * initialized; absent when SANDBOX_RUNTIME is unset (dev without
   * coding-delegation).
   */
  codingServiceFactory?: (conversationId: string) => CodingService;
  /**
   * Skills runtime — drives both the per-turn dynamic tool list rebuild
   * (one tool per registered skill) and the `Service.skills` namespace that
   * `register_skill` calls through. Optional only because some unit tests
   * skip skills wiring entirely; production wiring always populates it.
   */
  skillRunner?: SkillRunner;
  /**
   * MCP client registry. Resolves the per-turn MCP tool list against the
   * profile's `toolSet` globs and the configured `toolBudget`. Optional —
   * absent when no MCP servers are configured (or in unit tests that don't
   * exercise MCP). When undefined, no MCP tools are surfaced.
   */
  mcpRegistry?: McpRegistry;
  /**
   * Lazy voice resolver — returns a `VoiceBundle` (TTS + STT providers and
   * their model/voice ids) when `voice_config` is present and both
   * providers can be constructed. Called once per turn at the orchestrator
   * top so a single bundle threads through STT (transcribe-voice step),
   * voice-mode resolution, and TTS (voice-delivery step). Optional only
   * because some unit tests bypass voice entirely; production wiring
   * always populates it. See `src/voice/resolver.ts`.
   */
  voiceResolver?: VoiceProviderResolver;
  /**
   * IANA timezone used as the default when an agent tool (e.g.
   * `schedule_task`) doesn't supply one. Sourced from `env.USER_TIMEZONE`
   * — single-user POSIX-style convention, same value the prompt source
   * already surfaces to the LLM. See design/scheduling.md.
   */
  userTimezone: string;
  /**
   * Store behind the `Service.pipelines` namespace (`define_pipeline` /
   * `activate_pipeline` / `list_pipelines`). Optional only because some
   * unit tests skip pipelines wiring; production wiring always populates
   * it. See design/pipelines.md.
   */
  pipelineStore?: PipelineStore;
  /**
   * Run store behind `start_pipeline`. Optional for the same reason as
   * `pipelineStore`; without it `start` returns `runs_unavailable`.
   */
  pipelineRunStore?: PipelineRunStore;
  /**
   * Channel types whose adapter posts pipeline gate keyboards. A pipeline
   * with checkpoints only starts when one of the user's reachable channels
   * is of such a type.
   */
  pipelineGateChannelTypes?: ReadonlySet<string>;
}

/**
 * Main message pipeline — thin orchestration only.
 *
 * Receives inbound/ready events (debounce router has decided it's time to
 * process) and runs the turn's phases in order: admission, the user message,
 * the transcript, the frozen turn inputs, context assembly and compaction, the
 * agent loop, persistence, delivery, and the post-turn events. Each phase
 * plans its own steps; their ids, order and memoized shapes are the
 * durability map in design/crash-recovery.md.
 */
export function createHandleMessage(deps: HandleMessageDeps) {
  return inngest.createFunction(
    {
      id: "handle-message",
      triggers: [inboundReady],
      retries: 2,
      concurrency: conversationTurnConcurrency,
      onFailure: async ({ event, error, step }) => {
        const { conversationId, triggerInboundId } = event.data.event.data;
        await reportTurnFailure(step, deps.deliveryRouter, {
          conversationId,
          triggerInboundId,
          runId: event.data.run_id,
          error,
        });
      },
    },
    async ({ event, step, runId }) => {
      const { conversationId, triggerInboundId } = event.data;

      // Per-turn child logger — every emission inside the agent loop inherits
      // `runId` + `conversationId` so the evolution failure-reflector can join
      // logs to `conversation/degraded` events. See design/agent-resilience.md.
      const turnLogger = logger.child({ runId, conversationId });

      const admission = await admitTurn(
        step,
        { ...deps, resumePolicy: deps.debounceConfig.resumePolicy },
        { conversationId, triggerInboundId, turnLogger },
      );
      if (admission.kind === "skipped") {
        return { status: "skipped", reason: admission.reason };
      }
      const { conv, lastAssistant, snapshot, inboundMessages } = admission;
      const { userId, profileId } = conv;
      const { maxInboundId, firstInboundId } = batchCursors(inboundMessages);
      const routingKind = routingKindOf(conversationId, inboundMessages);

      // Voice bundle resolved once per turn (one indexed singleton read +
      // two secret lookups; cached by content hash inside the resolver so
      // steady-state cost is negligible). Re-runs on replay — providers
      // aren't durable, but step.run still caches transcript / audio
      // results downstream, so the upstream APIs aren't re-billed. Config
      // edits between attempts surface on the next non-cached step.
      const voiceBundle = await deps.voiceResolver?.();

      const { substitutedMessages, userContentText } = await recordUserMessage(step, deps, {
        conversationId,
        inboundMessages,
        voiceBundle,
        snapshot,
        maxInboundId,
      });

      const transcript = await loadTurnTranscript(step, deps, {
        conversationId,
        turnInboundId: maxInboundId,
      });

      const frozen = await freezeTurnInputs(step, deps, {
        conversationId,
        runId,
        userId,
        profileId,
        conversation: conv,
        routing: {
          maxInboundId,
          prevCursor: lastAssistant?.lastInboundMessageId ?? null,
          kind: routingKind,
        },
        voiceBundle,
        lastInboundContent: inboundMessages.at(-1)?.content ?? "",
      });
      const { profile, coreMemoryScope, delivery, loadedSystemPrompt } = frozen;

      // ──── Streaming section: bare-body glue + in-loop durable steps ────

      const resolvedBlocks = await resolveInboundAttachments(deps.attachments, substitutedMessages);
      const service = await buildChatTurnService(deps, {
        conversationId,
        userId,
        profileId,
        profile,
        coreMemoryScope,
        model: snapshot.model,
        toolDefs: frozen.toolDefs,
      });

      // In-turn durable boundary wrapper — per-step-kind retry policy lives in
      // `createTurnStepRunner`.
      const stepRun = createTurnStepRunner((id, fn) => step.run(id, fn));

      const context = await assembleTurnContext(stepRun, service, {
        userId,
        autoRecallMode: profile?.autoRecall ?? "heuristic",
        substitutedMessages,
        transcript,
        resolvedBlocks,
        loadedSystemPrompt,
        voiceMode: frozen.voiceMode,
        coreMemoryScope,
        timezone: deps.userTimezone,
        turnLogger,
      });

      const turnModel = await resolveTurnModel(stepRun, deps.resolveProvider, snapshot.model);

      const compacted = await compactTurn(stepRun, deps, {
        conversationId,
        turnModel,
        summarizationModel: snapshot.summarizationModel,
        system: context.continuing?.rendered ?? loadedSystemPrompt.rendered,
        messages: context.messages,
        toolDefs: frozen.toolDefs,
        messageIds: transcript.history.messageIds,
        newContentChars: userContentText.length + context.provisionalTurnContext.length,
        delivery,
        turnLogger,
      });

      const finalized = await finalizeTurnContext(step, frozen.systemPromptDeps, {
        messages: compacted.messages,
        provisionalTurnContext: context.provisionalTurnContext,
        transcript,
        continuing: context.continuing,
        storedCutoff: compacted.storedCutoff,
        loadedSystemPrompt,
        systemPromptArgs: frozen.systemPromptArgs,
        recalledMemories: context.recalledMemories,
        handledAt: context.handledAt,
        voiceMode: frozen.voiceMode,
        coreMemoryScope,
        timezone: deps.userTimezone,
      });

      const { result, unstreamed } = await runTurnLoop(step, stepRun, deps.runStreamingAgentLoop, {
        conversationId,
        turnModel,
        systemPrompt: finalized.systemPrompt,
        messages: finalized.messages,
        tools: frozen.turnTools,
        service,
        delivery,
        firstInboundId,
        turnLogger,
      });

      turnLogger.info(
        {
          model: result.model,
          iterations: result.iterations,
          usage: result.usage,
        },
        "agent loop complete",
      );

      const assistantMessageId = await persistTurn(step, deps, {
        conversationId,
        runId,
        triggerInboundId,
        snapshot,
        maxInboundId,
        priorCooldown: conv.cooldownState,
        result,
      });

      await deliverReply(step, deps, {
        conversationId,
        delivery,
        result,
        batchDelivery: frozen.batchDelivery,
        unstreamed,
        voiceMode: frozen.voiceMode,
        voiceBundle,
        turnLogger,
      });

      // ──── DURABLE: notify (Observer, metrics — not delivery) ────

      await step.sendEvent(
        "send-response",
        responseReady.create({
          conversationId,
          messageId: assistantMessageId,
        }),
      );

      // ──── RESUME POLICY ────

      if (deps.debounceConfig.resumePolicy === "flush") {
        // Process any remaining unbatched messages immediately (no debounce wait)
        await step.sendEvent(
          "flush",
          inboundReady.create({ conversationId, triggerInboundId: null }),
        );
      }
      // "debounce": queued inbound/ready events fire naturally when concurrency lock releases
      // "await_input": guard 2 catches all buffered events; new input triggers fresh debounce

      return { status: "processed", conversationId };
    },
  );
}
