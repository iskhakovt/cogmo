/**
 * One `agentic` stage of a pipeline run, executed as an agent turn in the
 * run's own conversation.
 *
 * Built from the same primitives `handle-message` composes — `loadTurnHistory`,
 * `composeTurnTools`, `buildTurnService`, `compactMessages`,
 * `runStreamingAgentLoop`, `insertMessages` — under stage policy instead of
 * chat policy: no debounce, batching, cooldown or voice; the stage's prose
 * and earlier artifacts as the user message; the stage allowlist narrowing
 * the profile's tools; a degraded loop failing the stage rather than
 * apologising in chat. Service assembly and the in-turn retry policy are the
 * shared `buildTurnService` / `createTurnStepRunner`.
 *
 * Replay contract: every read the turn depends on and every side effect runs
 * in a step keyed on SDK-local state, so a re-invocation plans the same steps
 * and bills nothing twice. The stage's prompt is persisted as a
 * `source='pipeline'` inbound keyed `pipeline:<runId>:<stageId>:<iteration>`;
 * its id is the messages' cursor and the loop's `turnKey`.
 *
 * The stage's rows stay out of the chat pipeline's cursor: chat reads skip
 * `source='pipeline'` inbounds and the assistant rows cursored on them. Known
 * residual: `handle-message` serializes on conversation id within its own
 * function only, so a message the user sends into the run conversation
 * mid-stage runs a chat turn concurrently with this one.
 */

import type { Logger } from "pino";
import type { Transactor } from "../../db/index.js";
import { inngest } from "../../inngest/client.js";
import { isRetriableProviderError } from "../../llm/fallback.js";
import { computeBudget, resolveLimits } from "../../llm/models.js";
import {
  type LlmProviderResolver,
  ProviderConfigError,
  type ResolvedLlm,
} from "../../llm/resolver.js";
import type { CountTokensParams } from "../../llm/types.js";
import type { McpRegistry } from "../../mcp/registry.js";
import type { MemoryProvider } from "../../memory/provider.js";
import type { SkillRunner } from "../../skills/runner.js";
import { buildSkillTools, composeTurnTools } from "../../skills/skill-tool-builder.js";
import { createSkillsService } from "../../skills/skills-service.js";
import type { DeliveryRouter } from "../../transport/delivery-router.js";
import type { TransportStore } from "../../transport/store/index.js";
import type { CodingService } from "../coding/service.js";
import {
  compactMessages,
  extractSummaryText,
  shouldSkipCounting,
  summarizationRequest,
} from "../context.js";
import { loadConversationContext } from "../conversation/load-conversation-context.js";
import { loadTurnHistory, summarizedSpan } from "../conversation/load-turn-history.js";
import type { ImageToolsLoader } from "../image-tools-loader.js";
import type { AgentLoopResult, StepRunner, StreamingAgentLoopParams } from "../loop.js";
import type { PromptSource } from "../prompt.js";
import { createSchedulingService } from "../scheduling/scheduling-service.js";
import type { Service } from "../service.js";
import type { AgentStore } from "../store/index.js";
import { buildSubAgentTools } from "../subagent/sub-agent-tool-builder.js";
import type { ToolRegistry } from "../tools.js";
import { buildTurnService } from "../turn-service.js";
import { asNonRetriable } from "../turn-step-runner.js";
import { extractStageArtifact } from "./extract-artifact.js";
import type { StageArtifact, StageOutputs } from "./run-types.js";
import { buildStagePrompt } from "./stage-prompt.js";
import { restrictToStage } from "./stage-tools.js";
import type { PipelineDefinition, Stage } from "./types.js";

export interface AgenticStageDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  transportStore: TransportStore;
  resolveProvider: LlmProviderResolver;
  tools: ToolRegistry;
  imageToolsLoader?: ImageToolsLoader;
  memory: MemoryProvider;
  promptSource: PromptSource;
  fileService: Service["files"];
  deliveryRouter: DeliveryRouter;
  runStreamingAgentLoop: (params: StreamingAgentLoopParams) => Promise<AgentLoopResult>;
  codingServiceFactory?: (conversationId: string) => CodingService;
  skillRunner?: SkillRunner;
  mcpRegistry?: McpRegistry;
  userTimezone: string;
}

export interface AgenticStageArgs {
  runId: string;
  stageId: string;
  iteration: number;
  conversationId: string;
  definition: PipelineDefinition;
  stage: Stage;
  stageOutputs: StageOutputs;
  /** The Inngest run executing this stage — the delivery handle's run id. */
  inngestRunId: string;
}

/**
 * `run` is a plain durable step; `stepRun` additionally applies the in-turn
 * retry policy (no step retries for tool handlers, fail-fast on deterministic
 * provider errors) that the agent loop's own steps expect.
 */
export interface AgenticStageSteps {
  run: StepRunner;
  stepRun: StepRunner;
}

export type AgenticStageOutcome =
  | { kind: "completed"; artifact: StageArtifact | null }
  | { kind: "failed"; reason: string };

export function stageInboundKey(runId: string, stageId: string, iteration: number): string {
  return `pipeline:${runId}:${stageId}:${iteration}`;
}

async function resolveOrFail(
  resolveProvider: LlmProviderResolver,
  model: string,
): Promise<ResolvedLlm> {
  try {
    return await resolveProvider(model);
  } catch (err) {
    if (err instanceof ProviderConfigError) throw asNonRetriable(err);
    throw err;
  }
}

export async function runAgenticStage(
  deps: AgenticStageDeps,
  args: AgenticStageArgs,
  steps: AgenticStageSteps,
  log: Logger,
): Promise<AgenticStageOutcome> {
  const { runId, stageId, iteration, conversationId, definition, stage, stageOutputs } = args;
  const prompt = buildStagePrompt({ definition, stage, stageOutputs });

  const ctx = await steps.run("load-stage-context", () =>
    deps.runInTx(async (tx) => {
      const conv = await deps.agentStore.getConversation(tx, conversationId);
      if (!conv) throw new Error(`Conversation not found: ${conversationId}`);
      const profile = await deps.agentStore.getProfile(tx, conv.profileId);
      if (!profile) throw new Error(`Profile not found: ${conv.profileId}`);
      return {
        userId: conv.userId,
        profileId: conv.profileId,
        isPrivate: conv.isPrivate,
        model: profile.model,
        summarizationModel: profile.summarizationModel ?? profile.model,
      };
    }),
  );

  // The prompt row and its user message commit together, so a retry that
  // finds the inbound already there also finds the message.
  const { inboundId } = await steps.run("persist-stage-prompt", () =>
    deps.runInTx(async (tx) => {
      const key = stageInboundKey(runId, stageId, iteration);
      const existing = await deps.transportStore.findInboundByIdempotencyKey(tx, key);
      if (existing) return { inboundId: existing.id };
      const inbound = await deps.transportStore.persistInbound(tx, {
        source: "pipeline",
        idempotencyKey: key,
        conversationId,
        content: prompt,
        platformTs: new Date(),
      });
      await deps.agentStore.insertMessage(tx, {
        conversationId,
        role: "user",
        content: prompt,
        profileId: ctx.profileId,
        model: ctx.model,
        lastInboundMessageId: inbound.id,
      });
      return { inboundId: inbound.id };
    }),
  );

  const turnHistory = await steps.run("load-turn-history", () =>
    loadTurnHistory({ runInTx: deps.runInTx, agentStore: deps.agentStore }, { conversationId }),
  );

  const profile = await deps.runInTx((tx) => deps.agentStore.getProfile(tx, ctx.profileId));

  const imageTools = deps.imageToolsLoader ? await deps.imageToolsLoader.getTools() : [];
  const skillTools = deps.skillRunner ? await buildSkillTools(deps.skillRunner) : [];
  const subAgentTools = buildSubAgentTools(
    await deps.runInTx((tx) => deps.agentStore.listSubAgents(tx, ctx.userId)),
    deps.resolveProvider,
  );
  const toolSetGlobs = profile?.toolSet ?? [];
  const mcpTools = deps.mcpRegistry
    ? await deps.mcpRegistry.resolveTools({ toolGlobs: toolSetGlobs })
    : [];
  const stageTools = restrictToStage(
    composeTurnTools({
      builtIns: [...deps.tools.snapshot(), ...imageTools, ...subAgentTools],
      skillTools,
      mcpTools,
      toolSetGlobs,
    }),
    stage.tools,
  );
  const toolDefs = stageTools.definitions();

  const service = await buildTurnService(
    {
      runInTx: deps.runInTx,
      agentStore: deps.agentStore,
      memory: deps.memory,
      fileService: deps.fileService,
    },
    {
      userId: ctx.userId,
      profile,
      coding: deps.codingServiceFactory?.(conversationId),
      skills: deps.skillRunner
        ? createSkillsService({ runner: deps.skillRunner, inngest, conversationId })
        : undefined,
      scheduling: createSchedulingService({
        runInTx: deps.runInTx,
        agentStore: deps.agentStore,
        userId: ctx.userId,
        profileId: ctx.profileId,
        defaultTimezone: deps.userTimezone,
      }),
      // No pipelines namespace: a stage cannot define, activate or start runs.
      pipelines: undefined,
    },
  );

  const systemPrompt = await steps.run("assemble-prompt", async () => {
    const context = await loadConversationContext(
      {
        runInTx: deps.runInTx,
        agentStore: deps.agentStore,
        transportStore: deps.transportStore,
      },
      { conversationId, profile },
    );
    return deps.promptSource.assemble({
      profile,
      rules: context.rules,
      toolDefinitions: toolDefs,
    });
  });

  const { provider, limits: rowLimits } = await resolveOrFail(deps.resolveProvider, ctx.model);
  const limits = resolveLimits(ctx.model, rowLimits);
  const budget = computeBudget(limits);

  // Frozen for the run: the persist step below rewrites the row this reads.
  const lastTokens = await steps.stepRun("load-last-tokens", () =>
    deps.runInTx((tx) => deps.agentStore.getLastTokens(tx, conversationId)),
  );
  const skipBudgetStrategies = shouldSkipCounting(
    lastTokens?.inputTokens ?? null,
    lastTokens?.outputTokens ?? null,
    prompt.length,
    budget,
  );

  let summaryText: string | null = null;
  let summaryTruncated = false;
  let countCall = 0;
  const compacted = await compactMessages(
    systemPrompt,
    turnHistory.messages,
    toolDefs,
    {
      countTokens: (params: CountTokensParams) => {
        countCall += 1;
        return steps.stepRun(`count-tokens-${countCall}`, () =>
          provider.countTokens({ ...params, model: ctx.model }),
        );
      },
      budget,
      canSummarizePrefix: (candidate) => summarizedSpan(turnHistory.messageIds, candidate) !== null,
      summarize: async (system, msgs) => {
        const resolved =
          ctx.summarizationModel === ctx.model
            ? null
            : await resolveOrFail(deps.resolveProvider, ctx.summarizationModel);
        const summarizationProvider = resolved?.provider ?? provider;
        const summarizationLimits = resolved
          ? resolveLimits(ctx.summarizationModel, resolved.limits)
          : limits;
        // `compactMessages` calls `summarize` at most once per invocation.
        const summarized = await steps.stepRun("summarize-prefix-outcome", async () => {
          const response = await summarizationProvider.chat(
            summarizationRequest({
              model: ctx.summarizationModel,
              system,
              messages: msgs,
              maxOutputTokens: summarizationLimits.maxOutputTokens,
            }),
          );
          return { text: extractSummaryText(response.content), stopReason: response.stopReason };
        });
        summaryText = summarized.text;
        summaryTruncated = summarized.stopReason === "max_tokens";
        return summarized.text;
      },
    },
    skipBudgetStrategies,
  );

  const splitIdx = compacted.event?.messagesSummarized ?? 0;
  const span = splitIdx > 0 ? summarizedSpan(turnHistory.messageIds, splitIdx) : null;
  if (summaryText !== null && span !== null && !summaryTruncated) {
    const text = summaryText;
    // A cached summary is not worth failing the stage over: a permanently
    // failed persist degrades to re-summarizing on the next stage.
    try {
      await steps.stepRun("persist-summary", async () => {
        const { row } = await deps.runInTx((tx) =>
          deps.agentStore.insertOrRecoverSummary(tx, {
            conversationId,
            summary: text,
            throughMessageId: span.cutoff,
            messagesSummarized: span.messageCount,
            model: ctx.summarizationModel,
            source: "turn",
          }),
        );
        return { id: row.id };
      });
    } catch (err) {
      log.warn({ err }, "failed to persist stage conversation summary, continuing the stage");
    }
  }

  // Broadcast, not source routing: a stage answers no inbound a session sent,
  // so it goes to every session on the run's (private) conversation.
  const delivery = await deps.deliveryRouter.prepare({
    conversationId,
    runId: args.inngestRunId,
    isPrivate: ctx.isPrivate,
    maxInboundId: inboundId,
    prevCursor: null,
    kind: "broadcast",
    ...(profile && {
      streamOpts: { chunkChars: profile.streamChunkChars, allowEdits: profile.streamEdits },
    }),
  });

  let result: AgentLoopResult;
  try {
    result = await deps.runStreamingAgentLoop({
      provider,
      model: ctx.model,
      systemPrompt,
      messages: compacted.messages,
      tools: stageTools,
      service,
      maxTokens: limits.maxOutputTokens,
      onEvent: (event) => delivery.push(event),
      stepRun: steps.stepRun,
      turnKey: inboundId,
      turnLogger: log,
    });
    await delivery.finish();
  } catch (err) {
    await delivery.abort(err instanceof Error ? err.message : "Unknown error");
    if (!isRetriableProviderError(err)) throw asNonRetriable(err);
    // Rethrown unwrapped: a permanently failed step surfaces as Inngest's
    // StepError, whose identity the engine's non-retriable detection needs.
    throw err;
  }

  await steps.run("persist-new-messages", async () => {
    const { id } = await deps.runInTx((tx) =>
      deps.agentStore.insertMessages(tx, {
        conversationId,
        messages: result.newMessages,
        profileId: ctx.profileId,
        model: ctx.model,
        lastInboundMessageId: inboundId,
        lastMessageInputTokens: result.usage.inputTokens,
        lastMessageOutputTokens: result.usage.outputTokens,
      }),
    );
    return { id };
  });

  // The target check sits inside the step so the step exists on every replay.
  await steps.run("batch-delivery", async () => {
    // A degraded turn has no reply text to deliver; its failure notice follows.
    if (!result.degraded && delivery.hasBatchTargets()) await delivery.deliverBatch(result.text);
    return null;
  });

  if (result.degraded) {
    return {
      kind: "failed",
      reason: `the stage's agent turn could not finish (${result.degraded.reason})`,
    };
  }

  const extracted = await steps.stepRun("extract-artifact", async () => {
    const artifact = await extractStageArtifact({
      output: stage.output,
      finalText: result.text,
      provider,
      model: ctx.model,
      stageId,
    });
    return artifact.isOk()
      ? { ok: true as const, artifact: artifact.value }
      : { ok: false as const, detail: artifact.error.detail };
  });
  if (!extracted.ok) {
    return {
      kind: "failed",
      reason: `the stage's result did not match its declared output: ${extracted.detail}`,
    };
  }
  return { kind: "completed", artifact: extracted.artifact };
}
