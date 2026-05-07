import { NonRetriableError } from "inngest";
import { inngest } from "../inngest/client.js";
import { conversationErrored, inboundReady, responseReady } from "../inngest/events.js";
import { isRetriableProviderError } from "../llm/fallback.js";
import { computeBudget } from "../llm/models.js";
import type { LlmProviderResolver } from "../llm/resolver.js";
import type { ContentBlock, Message, StreamEvent } from "../llm/types.js";
import { logger } from "../logger.js";
import type { McpRegistry } from "../mcp/registry.js";
import type { MemoryProvider } from "../memory/provider.js";
import type { SkillRunner } from "../skills/runner.js";
import { buildSkillTools, composeTurnTools } from "../skills/skill-tool-builder.js";
import { createSkillsService } from "../skills/skills-service.js";
import type { AttachmentStore } from "../transport/attachment-store.js";
import { contentToBlocks, contentToText } from "../transport/content.js";
import type { DeliveryRouter } from "../transport/delivery-router.js";
import type { TransportStore } from "../transport/store/index.js";
import type { CodingService } from "./coding/service.js";
import { compactMessages, SUMMARIZATION_PROMPT, shouldSkipCounting } from "./context.js";
import type { DebounceConfig } from "./debounce.js";
import { extractGeneratedDocuments, extractGeneratedImages } from "./extract-images.js";
import type { AgentLoopResult, StreamingAgentLoopParams } from "./loop.js";
import type { PromptSource } from "./prompt.js";
import { shouldSkipRecall } from "./recall-gate.js";
import type { Service } from "./service.js";
import { createService } from "./service.js";
import type { AgentStore } from "./store/index.js";
import type { ToolRegistry } from "./tools.js";

export interface HandleMessageDeps {
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
  summarizationModel?: string;
}

/**
 * Main message pipeline — thin orchestration only.
 *
 * Receives inbound/ready events (debounce router has decided it's time to process).
 * Loads context, streams the agent response to streaming adapters, persists,
 * delivers to batch adapters, emits notification, applies resume policy.
 */
export function createHandleMessage(deps: HandleMessageDeps) {
  const {
    agentStore,
    transportStore,
    resolveProvider,
    tools,
    memory,
    promptSource,
    fileService,
    attachments,
    debounceConfig,
    deliveryRouter,
    runStreamingAgentLoop,
  } = deps;

  return inngest.createFunction(
    {
      id: "handle-message",
      triggers: [inboundReady],
      retries: 2,
      concurrency: { limit: 1, key: "event.data.conversationId" },
      // Last-chance handler: retries are exhausted (or the run failed
      // non-retriably). Two responsibilities, ordered durable-first:
      //  1. Emit `conversation/errored` — the durable signal downstream
      //     consumers (recovery, evolution reflector) depend on. Must run
      //     even if user notification fails.
      //  2. Notify the user — best-effort courtesy. Wrapped so a failure
      //     in `notifyConversation` (DB outage on session lookup, etc.)
      //     can't propagate up and prevent step (1) from being recorded.
      // The original turn's `delivery` handle is gone (closure scope of a
      // different run), so we re-resolve sessions via `notifyConversation`.
      onFailure: async ({ event, error, step }) => {
        const { conversationId, triggerInboundId } = event.data.event.data;
        const runId = event.data.run_id;
        // `error` is what Inngest saw — typically NonRetriableError, since
        // we rewrap non-retriable provider errors above. The original
        // class (BadRequestError, RateLimitError, etc.) is on `cause`.
        // Surface both so the evolution failure-reflector can bucket by
        // upstream class rather than every error coalescing to one bucket.
        const cause = error.cause;
        const causeClass = cause instanceof Error ? cause.name : null;
        await step.sendEvent(
          "emit-conversation-errored",
          conversationErrored.create({
            conversationId,
            runId,
            triggerInboundId,
            errorClass: error.name,
            causeClass,
            errorMessage: error.message,
          }),
        );
        await step.run("notify-user", async () => {
          try {
            await deliveryRouter.notifyConversation(
              conversationId,
              "I hit an error processing your last message and won't keep retrying. Please try again.",
            );
          } catch (notifyErr) {
            logger.error(
              { err: notifyErr, conversationId, runId },
              "onFailure: notifyConversation failed, conversation/errored already emitted",
            );
          }
        });
      },
    },
    async ({ event, step, runId }) => {
      const { conversationId, triggerInboundId } = event.data;

      // ──── DURABLE: load context + entry guards ────

      const conv = await step.run("load-conversation", async () => {
        return agentStore.getConversation(conversationId);
      });
      if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

      // Status guard — `recover-conversation` marks a conversation `errored`
      // after retries on this function exhausted (or it failed
      // non-retriably). We refuse to spend more LLM calls on a known-broken
      // conversation until status flips back to `active` (manual psql for
      // now; future `/repair` command). Catches any unrecoverable failure
      // class — model deprecated, credentials revoked, content-moderation
      // block, persistent provider outage, malformed tool schema — that
      // would otherwise produce a retry-storm with every new inbound.
      if (conv.status === "errored") {
        return { status: "skipped", reason: "errored" };
      }

      const { userId, profileId } = conv;

      const lastAssistant = await step.run("last-assistant", async () => {
        return agentStore.getLastAssistantMessage(conversationId);
      });

      // Turn snapshot — read profile + model once at turn-start and stamp them on
      // every message row this turn produces (user batch + intermediate + final
      // assistant). Mid-turn /profile switch updates conversations.profile_id but
      // the running turn keeps its snapshot; next turn picks up the new value.
      // See design/transport/overview.md → Profile and Model Stamping.
      const snapshot = await step.run("load-turn-snapshot", async () => {
        const p = await agentStore.getProfile(profileId);
        if (!p) throw new Error(`Profile not found: ${profileId}`);
        return { profileId, model: p.model };
      });

      // Guard 1 — Staleness: trigger was already batched into a previous turn.
      // null trigger = flush, skip this check.
      if (
        triggerInboundId !== null &&
        lastAssistant?.lastInboundMessageId &&
        triggerInboundId <= lastAssistant.lastInboundMessageId
      ) {
        return { status: "skipped", reason: "stale" };
      }

      // Guard 2 — Await_input: trigger was created before the last response.
      if (
        debounceConfig.resumePolicy === "await_input" &&
        triggerInboundId !== null &&
        lastAssistant &&
        triggerInboundId < lastAssistant.id
      ) {
        return { status: "skipped", reason: "await_input" };
      }

      const inboundMessages = await step.run("load-inbound", async () => {
        return transportStore.getUnbatchedInbound(
          conversationId,
          lastAssistant?.lastInboundMessageId ?? null,
        );
      });

      // No unbatched messages — nothing to process (e.g., flush with no new input)
      if (inboundMessages.length === 0) {
        return { status: "skipped", reason: "no_messages" };
      }

      const inboundBlocks = inboundMessages.flatMap((m) => contentToBlocks(m.content));
      const userContentText = inboundMessages.map((m) => contentToText(m.content)).join("\n");
      // Safe — guarded by length check above
      const maxInboundId = inboundMessages.at(-1)?.id ?? "";

      await step.run("create-user-message", async () => {
        await agentStore.insertMessage({
          conversationId,
          role: "user",
          content: userContentText,
          profileId: snapshot.profileId,
          model: snapshot.model,
          lastInboundMessageId: maxInboundId,
        });
      });

      const history = await step.run("load-history", async () => {
        return agentStore.getHistory(conversationId);
      });

      const channelTypes = await step.run("resolve-channel-types", async () => {
        return transportStore.getActiveChannelTypes(conversationId);
      });

      const systemPrompt = await step.run("assemble-prompt", async () => {
        return promptSource.assemble(agentStore, { profileId, channelTypes });
      });

      // ──── NON-DURABLE: resolve images + auto-recall + stream ────

      // Resolve ImageRefs / DocumentRefs from S3 into actual ImageBlocks /
      // DocumentBlocks (read bytes, base64-encode).
      const resolvedBlocks: ContentBlock[] = await Promise.all(
        inboundBlocks.map(async (block): Promise<ContentBlock> => {
          if (block.type === "image_ref") {
            const bytes = await attachments.download(block.path);
            return {
              type: "image",
              source: "base64",
              data: bytes.toString("base64"),
              mediaType: block.mediaType,
            };
          }
          if (block.type === "document_ref") {
            const bytes = await attachments.download(block.path);
            return {
              type: "document",
              source: "base64",
              data: bytes.toString("base64"),
              mediaType: block.mediaType,
              ...(block.name && { name: block.name }),
            };
          }
          return block;
        }),
      );

      // Profile reload — needed for auto-recall gating and other per-profile settings.
      // `model` comes from the turn snapshot, not this read, to preserve the invariant
      // that one turn = one (profileId, model) stamp even if profile.model changes mid-turn.
      const profile = await agentStore.getProfile(profileId);

      // Auto-recall: search memory for context relevant to this message.
      // Best-effort — a Hindsight failure (server down, malformed query, 4xx
      // from a server-side change we haven't caught up with) must not abort
      // the turn or trigger Inngest re-enqueue. Degrade to "no memories" and
      // let the conversation proceed; the LLM-driven `memory_recall` tool
      // path still surfaces hard failures to the model.
      const autoRecallMode = profile?.autoRecall ?? "heuristic";
      const recallResult = shouldSkipRecall(autoRecallMode, userContentText)
        ? { memories: [] }
        : await memory
            .recall(userId, userContentText, { maxTokens: 2000 })
            .catch((err: unknown) => {
              logger.warn(
                { err, conversationId },
                "auto-recall failed, proceeding without recalled context",
              );
              return { memories: [] };
            });
      const recalledContext =
        recallResult.memories.length > 0
          ? recallResult.memories.map((m) => m.content).join("\n")
          : null;

      // Build scoped service for this turn
      const coreMemoryService: Service["coreMemory"] = {
        get: () => agentStore.getCoreMemoryBlocks(userId),
        update: (key, content) => agentStore.upsertCoreMemoryBlock({ userId, key, content }),
      };

      const codingService = deps.codingServiceFactory?.(conversationId);
      const skillsService = deps.skillRunner
        ? createSkillsService({
            runner: deps.skillRunner,
            inngest,
            conversationId,
          })
        : undefined;
      const service = createService(
        memory,
        userId,
        [],
        fileService,
        coreMemoryService,
        async (content, opts) => {
          await agentStore.stagePendingMemory({
            userId,
            content,
            ...(opts?.context !== undefined && { context: opts.context }),
            source: "live_retain",
          });
        },
        codingService,
        skillsService,
      );
      const delivery = await deliveryRouter.prepare({
        conversationId,
        runId,
        isPrivate: conv.isPrivate,
        maxInboundId,
        prevCursor: lastAssistant?.lastInboundMessageId ?? null,
      });

      // Append recalled context to system prompt
      const fullPrompt = recalledContext
        ? `${systemPrompt}\n\n# Recalled Context\n\n${recalledContext}`
        : systemPrompt;

      // Build message history, replacing the last user message with resolved content.
      // Safe because: getHistory runs after create-user-message (durable step ordering),
      // and concurrency lock on conversationId prevents concurrent writes.
      let historyMessages: Message[] = [...history];
      const hasAttachments = resolvedBlocks.some(
        (b) => b.type === "image" || b.type === "document",
      );
      if (hasAttachments && historyMessages.length > 0) {
        const lastIdx = historyMessages.length - 1;
        if (historyMessages[lastIdx]?.role === "user") {
          historyMessages[lastIdx] = { role: "user", content: resolvedBlocks };
        }
      }

      // ──── Context window compaction ────
      //
      // compactMessages runs on every invocation — token counting and the
      // threshold decision are cheap and depend on `fullPrompt` /
      // `historyMessages`, which are partially built from non-durable reads
      // (memory.recall, image resolution). Only the expensive summarization
      // LLM call is wrapped in a `summarize-prefix` step (inside the
      // `summarize` callback) so it's exactly-once on Inngest retry. The
      // cached value is just the summary string — no large image payloads
      // in step state. See design/crash-recovery.md.

      const model = snapshot.model;
      const budget = computeBudget(model);

      // Per-turn provider dispatch — the snapshot's model determines which
      // adapter (Anthropic, xAI via OpenAI-compat, etc.) handles the chat,
      // streaming, and token-counting calls below. Resolved outside any
      // `step.run` because the resolver returns an `LlmProvider` instance
      // that isn't JSON-serializable; the production resolver caches by
      // model, so this is one DB read + one AES decrypt the first time a
      // model is seen, then a Map lookup for the rest of the process. A
      // missing routing row throws here — Inngest will retry the run, then
      // the `onFailure` handler notifies the user. See design/providers.md
      // → Provider dispatch.
      const provider = await resolveProvider(model);
      const summarizationModel = deps.summarizationModel ?? model;

      // Per-turn tool registry — built-ins from bootstrap + one dynamic tool
      // per live skill + MCP tools resolved against the profile's globs.
      // Rebuilt every turn so registered skills + newly-approved MCP tools
      // appear immediately, and rolled-back / disabled / un-approved ones
      // disappear. The skill-tool builder is fault-tolerant: a single skill
      // with unreadable git source is logged and dropped, the rest of the
      // list still loads. Composition policy (built-ins win on collision;
      // profile.toolSet globs filter every source) lives in `composeTurnTools`.
      const skillTools = deps.skillRunner ? await buildSkillTools(deps.skillRunner) : [];
      const mcpTools = deps.mcpRegistry
        ? await deps.mcpRegistry.resolveTools({ toolGlobs: profile?.toolSet ?? [] })
        : [];
      const turnTools = composeTurnTools({
        builtIns: tools.snapshot(),
        skillTools,
        mcpTools,
        toolSetGlobs: profile?.toolSet ?? [],
      });
      const toolDefs = turnTools.definitions();

      const lastTokens = await agentStore.getLastTokens(conversationId);
      const skip = shouldSkipCounting(
        lastTokens?.inputTokens ?? null,
        lastTokens?.outputTokens ?? null,
        userContentText.length,
        budget,
      );

      if (!skip) {
        const compactResult = await compactMessages(fullPrompt, historyMessages, toolDefs, {
          countTokens: (params) => provider.countTokens({ ...params, model }),
          budget,
          summarize: async (system, msgs) => {
            // Resolve the summarization provider lazily — only when
            // compaction actually picks the SUMMARIZE strategy. Resolving
            // eagerly at turn start would surface a misconfigured
            // `summarizationModel` (missing routing row, missing secret)
            // as a per-turn failure, even on small messages that never
            // trigger summarization. The memoized resolver makes this
            // a `Map` lookup after the first hit per process. Stays
            // outside the `step.run` below because the provider instance
            // isn't JSON-serializable.
            const summarizationProvider =
              summarizationModel === model ? provider : await resolveProvider(summarizationModel);
            // Step ID is hardcoded — relies on `compactMessages` calling
            // `summarize` at most once per invocation (contract on
            // ContextManagerDeps.summarize). If that ever changes, switch to
            // a counter-based ID like `summarize-prefix-${i}` to avoid
            // Inngest's duplicate-step-id error.
            return step.run("summarize-prefix", async () => {
              const response = await summarizationProvider.chat({
                model: summarizationModel,
                system,
                messages: [...msgs, { role: "user", content: SUMMARIZATION_PROMPT }],
                maxTokens: 4096,
              });
              return response.content
                .filter((b) => b.type === "text")
                .map((b) => (b as { text: string }).text)
                .join("");
            });
          },
          onStatus: (message) => {
            delivery.push({ type: "status", message });
          },
        });
        historyMessages = compactResult.messages;
      }

      let result: AgentLoopResult;
      try {
        result = await runStreamingAgentLoop({
          provider,
          model,
          systemPrompt: fullPrompt,
          messages: historyMessages,
          tools: turnTools,
          service,
          onEvent: (event: StreamEvent) => delivery.push(event),
          // Opt-in per-tool durability. The streaming section itself is
          // non-durable (can't stream out of `step.run`), but tool handlers
          // run *between* stream events — wrapping an individual handler in
          // `step.run` preserves event ordering while giving exactly-once
          // semantics for expensive/billable tools (generate_image,
          // web_answer). Step id = `tool-<name>-<toolUseId>`, unique per
          // LLM-issued tool call. See design/crash-recovery.md.
          stepRun: (id, fn) => step.run(id, fn),
        });
        await delivery.finish();
      } catch (err) {
        await delivery.abort(err instanceof Error ? err.message : "Unknown error");
        // Translate provider classification into Inngest's retry decision.
        // 4xx that aren't 408/425/429 are deterministic client errors — the
        // same payload will fail every retry. Wrap in NonRetriableError so
        // Inngest fails the run on the first attempt instead of burning
        // ~6 minutes on retries before the onFailure handler can notify the
        // user. See design/crash-recovery.md.
        if (!isRetriableProviderError(err)) {
          const message = err instanceof Error ? err.message : String(err);
          throw new NonRetriableError(message, { cause: err });
        }
        throw err;
      }

      logger.info(
        {
          conversationId,
          model: result.model,
          iterations: result.iterations,
          usage: result.usage,
        },
        "agent loop complete",
      );

      // ──── DURABLE: persist all new messages (tool turns + final assistant) ────

      const assistantMsg = await step.run("persist-new-messages", async () => {
        return agentStore.insertMessages({
          conversationId,
          messages: result.newMessages,
          profileId: snapshot.profileId,
          model: snapshot.model,
          lastInboundMessageId: maxInboundId,
          lastMessageInputTokens: result.usage.inputTokens,
          lastMessageOutputTokens: result.usage.outputTokens,
        });
      });

      // ──── DURABLE: batch delivery ────
      //
      // Wrapped in step.run so it's exactly-once on Inngest retry — without
      // this, a post-delivery step failure would re-fire sendMessage /
      // sendPhoto to batch adapters. Return value is the delivery summary
      // (small counts), so state stays lean — image bytes flow through the
      // step body in memory but never into Inngest state.
      //
      // Skipped entirely when there are no batch targets (pure-streaming
      // setups like Telegram-only): the stream handle already handled
      // delivery mid-loop, and no S3 downloads are needed.
      if (delivery.hasBatchTargets()) {
        await step.run("batch-delivery", async () => {
          const imageRefs = extractGeneratedImages(result.newMessages);
          const documentRefs = extractGeneratedDocuments(result.newMessages);

          // Per-attachment resilience via allSettled — one S3 miss or
          // corrupted attachment shouldn't block delivery of the others
          // (matches the stream handle's swallow-and-log pattern).
          const imageSettled = await Promise.allSettled(
            imageRefs.map(async (ref) => ({
              data: await attachments.download(ref.path),
              mediaType: ref.mediaType,
            })),
          );

          const fulfilledImages = imageSettled
            .filter(
              (r): r is PromiseFulfilledResult<{ data: Buffer; mediaType: string }> =>
                r.status === "fulfilled",
            )
            .map((r) => r.value);

          for (const [i, r] of imageSettled.entries()) {
            if (r.status === "rejected") {
              logger.error(
                { err: r.reason, path: imageRefs[i]?.path },
                "outbound image download failed, skipping",
              );
            }
          }

          const docSettled = await Promise.allSettled(
            documentRefs.map(async (ref) => ({
              data: await attachments.download(ref.path),
              mediaType: ref.mediaType,
              name: ref.name,
            })),
          );

          const fulfilledDocs = docSettled
            .filter(
              (
                r,
              ): r is PromiseFulfilledResult<{
                data: Buffer;
                mediaType: string;
                name: string;
              }> => r.status === "fulfilled",
            )
            .map((r) => r.value);

          for (const [i, r] of docSettled.entries()) {
            if (r.status === "rejected") {
              logger.error(
                { err: r.reason, path: documentRefs[i]?.path },
                "outbound document download failed, skipping",
              );
            }
          }

          await delivery.deliverBatch(
            result.text,
            fulfilledImages.length > 0 ? fulfilledImages : undefined,
            fulfilledDocs.length > 0 ? fulfilledDocs : undefined,
          );

          return {
            imagesDelivered: fulfilledImages.length,
            imagesFailed: imageSettled.length - fulfilledImages.length,
            documentsDelivered: fulfilledDocs.length,
            documentsFailed: docSettled.length - fulfilledDocs.length,
          };
        });
      }

      // ──── DURABLE: notify (Observer, metrics — not delivery) ────

      await step.sendEvent(
        "send-response",
        responseReady.create({
          conversationId,
          messageId: assistantMsg.id,
        }),
      );

      // ──── RESUME POLICY ────

      if (debounceConfig.resumePolicy === "flush") {
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
