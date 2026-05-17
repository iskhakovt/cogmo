import { NonRetriableError } from "inngest";
import type { Transactor } from "../db/index.js";
import { inngest } from "../inngest/client.js";
import { conversationErrored, inboundReady, responseReady } from "../inngest/events.js";
import { isRetriableProviderError } from "../llm/fallback.js";
import { computeBudget, resolveLimits } from "../llm/models.js";
import {
  type LlmProviderResolver,
  ProviderConfigError,
  type ResolvedLlm,
} from "../llm/resolver.js";
import type { ContentBlock, Message, StreamEvent } from "../llm/types.js";
import { logger } from "../logger.js";
import type { McpRegistry } from "../mcp/registry.js";
import type { MemoryProvider } from "../memory/provider.js";
import type { SkillRunner } from "../skills/runner.js";
import { buildSkillTools, composeTurnTools } from "../skills/skill-tool-builder.js";
import { createSkillsService } from "../skills/skills-service.js";
import type { AttachmentStore } from "../transport/attachment-store.js";
import { contentToBlocks, type InboundContent } from "../transport/content.js";
import type { DeliveryRouter } from "../transport/delivery-router.js";
import type { TransportStore } from "../transport/store/index.js";
import { resolveVoiceMode } from "../voice/mode.js";
import type { SttProvider, TtsProvider } from "../voice/types.js";
import type { CodingService } from "./coding/service.js";
import { compactMessages, SUMMARIZATION_PROMPT, shouldSkipCounting } from "./context.js";
import { loadConversationContext } from "./conversation/load-conversation-context.js";
import type { DebounceConfig } from "./debounce.js";
import { extractGeneratedDocuments, extractGeneratedImages } from "./extract-images.js";
import type { ImageToolsLoader } from "./image-tools-loader.js";
import type { AgentLoopResult, StreamingAgentLoopParams } from "./loop.js";
import type { PromptSource } from "./prompt.js";
import { shouldSkipRecall } from "./recall-gate.js";
import { createSchedulingService } from "./scheduling/scheduling-service.js";
import type { Service } from "./service.js";
import { createService } from "./service.js";
import type { AgentStore } from "./store/index.js";
import type { ToolRegistry } from "./tools.js";

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
   * Speech-to-text provider for transcribing inbound voice blocks. Optional
   * — absent when no `voice_config` row is present (the wizard hasn't been
   * run, or voice is intentionally disabled). When undefined, voice blocks
   * surface as a tool-style placeholder text rather than crashing the turn.
   */
  sttProvider?: SttProvider;
  /**
   * Text-to-speech provider for outbound voice replies. Optional — absent
   * when no `voice_config` row is present. Without it, `voice_mode = 'always'`
   * silently degrades to text-only rather than erroring.
   */
  ttsProvider?: TtsProvider;
  /**
   * Resolved voice config — pre-loaded from `voice_config` at bootstrap
   * (voice id + model). Only consumed when ttsProvider is also present.
   */
  voiceConfig?: { ttsVoice: string; ttsModel: string };
  /**
   * IANA timezone used as the default when an agent tool (e.g.
   * `schedule_task`) doesn't supply one. Sourced from `env.USER_TIMEZONE`
   * — single-user POSIX-style convention, same value the prompt source
   * already surfaces to the LLM. See design/scheduling.md.
   */
  userTimezone: string;
}

/**
 * Resolve a provider, rewrapping permanent config errors as
 * `NonRetriableError` so Inngest aborts on the first attempt instead of
 * burning all `retries: 2` attempts before `onFailure` notifies the user.
 * Transient errors (DB blip, network) keep their plain shape and follow
 * the default retry path.
 */
async function resolveOrFail(
  resolveProvider: LlmProviderResolver,
  model: string,
): Promise<ResolvedLlm> {
  try {
    return await resolveProvider(model);
  } catch (err) {
    if (err instanceof ProviderConfigError) {
      throw new NonRetriableError(err.message, { cause: err });
    }
    throw err;
  }
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
        return deps.runInTx((tx) => agentStore.getConversation(tx, conversationId));
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
        return deps.runInTx((tx) => agentStore.getLastAssistantMessage(tx, conversationId));
      });

      // Turn snapshot — read profile + model once at turn-start and stamp them on
      // every message row this turn produces (user batch + intermediate + final
      // assistant). Mid-turn /profile switch updates conversations.profile_id but
      // the running turn keeps its snapshot; next turn picks up the new value.
      // `summarizationModel` is captured the same way: profile override falls
      // back to the chat model so a Haiku profile doesn't pay the Sonnet rate
      // for prefix summarization.
      // See design/transport/overview.md → Profile and Model Stamping.
      const snapshot = await step.run("load-turn-snapshot", async () => {
        const p = await deps.runInTx((tx) => agentStore.getProfile(tx, profileId));
        if (!p) throw new Error(`Profile not found: ${profileId}`);
        return {
          profileId,
          model: p.model,
          summarizationModel: p.summarizationModel ?? p.model,
        };
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
        return deps.runInTx((tx) =>
          transportStore.getUnbatchedInbound(
            tx,
            conversationId,
            lastAssistant?.lastInboundMessageId ?? null,
          ),
        );
      });

      // No unbatched messages — nothing to process (e.g., flush with no new input)
      if (inboundMessages.length === 0) {
        return { status: "skipped", reason: "no_messages" };
      }

      const inboundBlocks = inboundMessages.flatMap((m) => contentToBlocks(m.content));
      // Safe — guarded by length check above
      const maxInboundId = inboundMessages.at(-1)?.id ?? "";

      // Scheduled inbounds have no originating session for source
      // routing — broadcast to every reachable session instead.
      const routingKind: "reply" | "broadcast" = inboundMessages.some(
        (m) => m.source === "scheduled",
      )
        ? "broadcast"
        : "reply";

      // Voice transcription runs in a durable `step.run` boundary — STT is
      // a billable LLM-adjacent call, so Inngest retries replay from the
      // step cache (exactly-once on second attempt) instead of re-charging
      // the provider. Cached value is just an array of transcripts in the
      // same order as voice_ref blocks; OGG bytes never enter step state.
      // Runs BEFORE create-user-message so the persisted message contains
      // the actual transcript text rather than a path-only JSON literal.
      const voiceRefs = inboundBlocks.filter((b) => b.type === "voice_ref");
      const transcripts =
        voiceRefs.length > 0
          ? await step.run("transcribe-voice", async () => {
              const stt = deps.sttProvider;
              if (!stt) {
                throw new Error(
                  "voice block received but no sttProvider configured — insert a `voice_config` row pointing at a valid `secrets` entry",
                );
              }
              const out: string[] = [];
              for (const ref of voiceRefs) {
                const bytes = await attachments.download(ref.path);
                const result = await stt.stt({ audio: bytes, mediaType: ref.mediaType });
                out.push(result.text);
              }
              return out;
            })
          : [];

      // Single source of truth for "what does each inbound row look like
      // after voice transcription?". Both consumers below (userContentText
      // for persistence; resolvedBlocks for the LLM call) derive from this
      // — eliminates the parallel-cursor pattern that was fragile under
      // walk-order changes. Cursor advances across rows in the same order
      // `transcripts` was produced (inboundMessages.flatMap order, voice
      // refs only).
      const substitutedMessages = ((): ReadonlyArray<{ content: InboundContent }> => {
        let cursor = 0;
        return inboundMessages.map((m) => {
          if (typeof m.content === "string") return { content: m.content };
          const blocks = m.content.map((b) =>
            b.type === "voice" ? ({ type: "text", text: transcripts[cursor++] ?? "" } as const) : b,
          );
          return { content: blocks };
        });
      })();

      // Per-row text serialization for `messages.content`. After voice→text
      // substitution above, a text-only row joins on newline (clean
      // round-trip for next-turn history loads); rows that still carry
      // image/document blocks JSON-stringify (matches today's behavior for
      // those attachment types — image-aware history isn't a slice 1
      // concern). The type-guarded filter narrows without an `as` cast.
      const userContentText = substitutedMessages
        .map(({ content }) => {
          if (typeof content === "string") return content;
          if (content.every((b) => b.type === "text")) {
            return content
              .filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("\n");
          }
          return JSON.stringify(content);
        })
        .join("\n");

      await step.run("create-user-message", async () => {
        await deps.runInTx((tx) =>
          agentStore.insertMessage(tx, {
            conversationId,
            role: "user",
            content: userContentText,
            profileId: snapshot.profileId,
            model: snapshot.model,
            lastInboundMessageId: maxInboundId,
          }),
        );
      });

      const history = await step.run("load-history", async () => {
        return deps.runInTx((tx) => agentStore.getHistory(tx, conversationId));
      });

      // Open delivery handles early — needed to resolve voice mode
      // (`canDeliverVoice` reflects which active sessions implement
      // `sendVoice`). Side effect is benign: the streaming adapter just
      // tracks an open run id; no Telegram message is posted until first
      // `push`.
      const delivery = await deliveryRouter.prepare({
        conversationId,
        runId,
        isPrivate: conv.isPrivate,
        maxInboundId,
        prevCursor: lastAssistant?.lastInboundMessageId ?? null,
        kind: routingKind,
      });

      // Resolve per-turn voice mode BEFORE prompt assembly so the
      // voice-style hint can be injected when TTS is in play. Decision
      // gates: adapter capability, TTS provider configured, conversation
      // override (NULL = follow profile default), profile mode, modality of
      // the most recent inbound. See design/voice.md.
      const profileForVoice = await deps.runInTx((tx) => agentStore.getProfile(tx, profileId));
      const voiceModeForTurn = resolveVoiceMode({
        adapterSupportsVoice: delivery.canDeliverVoice(),
        voiceConfigPresent: deps.ttsProvider !== undefined && deps.voiceConfig !== undefined,
        conversationMode: conv.voiceMode,
        profileMode: profileForVoice?.voiceMode ?? "auto",
        // Inspect ONLY the most recent inbound message in the debounced
        // batch — the user's latest intent. If the batch is [voice, text]
        // (user dictated, then typed a follow-up), they're at the keyboard
        // now and shouldn't get a voice reply just because the batch
        // started with voice. Symmetrically, [text, voice] correctly
        // mirrors voice.
        lastInboundWasVoice: contentToBlocks(inboundMessages.at(-1)?.content ?? "").some(
          (b) => b.type === "voice_ref",
        ),
      });

      // Per-turn tool registry — built-ins from bootstrap + the live image
      // catalog (loaded fresh each turn so wizard / CLI CRUD takes effect
      // without a restart) + one dynamic tool per live skill + MCP tools
      // resolved against the profile's globs. Rebuilt every turn so
      // registered skills + newly-approved MCP tools appear immediately, and
      // rolled-back / disabled / un-approved ones disappear. The skill-tool
      // builder is fault-tolerant: a single skill with unreadable git source
      // is logged and dropped, the rest of the list still loads. Composition
      // policy (built-ins win on collision; profile.toolSet globs filter
      // every source) lives in `composeTurnTools`. Image tools join the
      // built-ins set rather than the skill/MCP sets — they're first-party
      // and should win on any name collision with operator-installed
      // extensions, same as memory / web / file tools.
      //
      // Resolved BEFORE `assemble-prompt` so the catalog renders into the
      // system prompt's `# Tools` section — otherwise the LLM can't
      // introspect its own per-turn capabilities and answers "what can you
      // do?" from the built-ins alone, missing image gen, registered
      // skills, and MCP tools entirely.
      const imageTools = deps.imageToolsLoader ? await deps.imageToolsLoader.getTools() : [];
      const skillTools = deps.skillRunner ? await buildSkillTools(deps.skillRunner) : [];
      const turnToolSetGlobs = profileForVoice?.toolSet ?? [];
      const mcpTools = deps.mcpRegistry
        ? await deps.mcpRegistry.resolveTools({ toolGlobs: turnToolSetGlobs })
        : [];
      const turnTools = composeTurnTools({
        builtIns: [...tools.snapshot(), ...imageTools],
        skillTools,
        mcpTools,
        toolSetGlobs: turnToolSetGlobs,
      });
      const toolDefs = turnTools.definitions();

      // Profile passed in from the outer read (`profileForVoice`) so
      // voice-mode resolution, `composeTurnTools` globs, and the prompt's
      // `# Tools` / base-prompt sections all come from the same row. A
      // concurrent `/settings` mid-turn used to land between the outer
      // read and a second `getProfile` inside this step, leaving the
      // prompt's tool filter and base-prompt sourced from different
      // snapshots under READ COMMITTED.
      const systemPrompt = await step.run("assemble-prompt", async () => {
        const ctx = await loadConversationContext(
          { runInTx: deps.runInTx, agentStore, transportStore },
          { conversationId, profile: profileForVoice },
        );
        return promptSource.assemble({
          profile: profileForVoice,
          rules: ctx.rules,
          voiceMode: voiceModeForTurn,
          toolDefinitions: toolDefs,
        });
      });

      // ──── NON-DURABLE: resolve images + auto-recall + stream ────

      // Resolve image/document refs (S3 → base64). Voice substitution
      // already happened in `substitutedMessages` above, so re-flattening
      // through `contentToBlocks` produces a block stream with text in
      // place of voice — no voice_ref branch needed here.
      const substitutedInboundBlocks = substitutedMessages.flatMap(({ content }) =>
        contentToBlocks(content),
      );
      const resolvedBlocks: ContentBlock[] = await Promise.all(
        substitutedInboundBlocks.map(async (block): Promise<ContentBlock> => {
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
          // voice_ref is substituted to text upstream in substitutedMessages
          // — this branch is unreachable in practice. Keep an explicit
          // mapping rather than a cast so a future code path that bypasses
          // the substitution still produces a sane block instead of
          // crashing the loop's return-type inference.
          if (block.type === "voice_ref") return { type: "text", text: "" };
          return block;
        }),
      );

      // Reuse the profile loaded earlier for voice-mode resolution — saves
      // one DB roundtrip per turn. Needed downstream for auto-recall gating,
      // the `memoryScope` ACL filter, and other per-profile settings. `model`
      // still comes from the turn snapshot, not this read, to preserve the
      // invariant that one turn = one (profileId, model) stamp even if
      // profile.model changes mid-turn.
      const profile = profileForVoice;

      // Load the user's restricted profile-class set so the scoped service
      // can fold in the fail-closed NOT leaf. Keyed on the conversation
      // user (the bank owner), not `profile.userId` — an org profile
      // (`profile.userId === null`) speaks for the conversation user, and
      // restricted-class semantics follow the user's own registry. One
      // extra round-trip per turn; table is small and indexed on user_id.
      //
      // FUTURE: deployments that have never used class restriction pay
      // for this round-trip every turn for nothing. A per-user cache
      // (invalidated by `setProfileClassRestricted` /
      // `createProfileClass` / `deleteProfileClass`) would close that
      // gap, but it's strictly more code than the round-trip costs at
      // single-user scale — revisit when telemetry shows the read taking
      // a meaningful slice of turn latency.
      const restrictedClassNames = await deps
        .runInTx((tx) => agentStore.listProfileClasses(tx, userId))
        .then((classes) => classes.filter((c) => c.restricted).map((c) => c.name));

      // Build scoped service for this turn — must precede auto-recall so the
      // recall call goes through the same `memoryScope` ACL filter every other
      // memory operation does.
      const coreMemoryService: Service["coreMemory"] = {
        get: () => deps.runInTx((tx) => agentStore.getCoreMemoryBlocks(tx, userId)),
        update: (key, content) =>
          deps.runInTx((tx) => agentStore.upsertCoreMemoryBlock(tx, { userId, key, content })),
      };

      const codingService = deps.codingServiceFactory?.(conversationId);
      const skillsService = deps.skillRunner
        ? createSkillsService({
            runner: deps.skillRunner,
            inngest,
            conversationId,
          })
        : undefined;
      // Scheduling service is scoped per-turn to (userId, profileId)
      // so `schedule_task` / `list_tasks` / `remove_task` can't leak
      // across users. Always constructed when handle-message runs —
      // unlike coding/skills there's no env-gated absence.
      const schedulingService = createSchedulingService({
        runInTx: deps.runInTx,
        agentStore: deps.agentStore,
        userId,
        profileId,
        defaultTimezone: deps.userTimezone,
      });
      const service = createService(
        memory,
        userId,
        profile?.memoryScope ?? null,
        profile?.profileClass ?? null,
        restrictedClassNames,
        fileService,
        coreMemoryService,
        async (content, opts) => {
          await deps.runInTx((tx) =>
            agentStore.stagePendingMemory(tx, {
              userId,
              // Snapshot the staging profile so the Observer drain stamps
              // the right `profile_class:<class>` tag at retain time —
              // without this, a row staged by an `intimate`-class profile
              // could be drained by an idle on a `general`-class
              // conversation and end up tagged as `general`, leaking
              // across speaker isolation.
              profileId: profile?.id ?? null,
              content,
              ...(opts?.context !== undefined && { context: opts.context }),
              source: "live_retain",
            }),
          );
        },
        codingService,
        skillsService,
        schedulingService,
      );

      // Auto-recall: search memory for context relevant to this message, via
      // the scoped service so the profile's `memoryScope` filter applies.
      // Best-effort — a Hindsight failure (server down, malformed query, 4xx
      // from a server-side change we haven't caught up with) must not abort
      // the turn or trigger Inngest re-enqueue. Degrade to "no memories" and
      // let the conversation proceed; the LLM-driven `memory_recall` tool
      // path still surfaces hard failures to the model.
      const autoRecallMode = profile?.autoRecall ?? "heuristic";
      const recallResult = shouldSkipRecall(autoRecallMode, userContentText)
        ? { memories: [] }
        : await service.memory
            .recall(userContentText, { maxTokens: 2000 })
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

      // Per-turn provider dispatch — the snapshot's model determines which
      // adapter (Anthropic, xAI via OpenAI-compat, etc.) handles the chat,
      // streaming, and token-counting calls below. Resolved outside any
      // `step.run` because the resolver returns an `LlmProvider` instance
      // that isn't JSON-serializable; the production resolver caches by
      // model, so this is one DB read + one AES decrypt the first time a
      // model is seen, then a Map lookup for the rest of the process.
      // `resolveOrFail` rewraps permanent config errors (no routing row,
      // no secret, malformed `llm_providers` row) as `NonRetriableError`
      // so Inngest aborts immediately and `onFailure` notifies the user
      // — no point burning retries on a misconfiguration. See
      // design/providers.md → Provider dispatch.
      const { provider, limits: rowLimits } = await resolveOrFail(resolveProvider, model);
      // Layered limits: row override → bundled LiteLLM snapshot → conservative
      // default. Always returns a value; never throws on unknown models.
      const limits = resolveLimits(model, rowLimits);
      const budget = computeBudget(limits);
      const summarizationModel = snapshot.summarizationModel;

      const lastTokens = await deps.runInTx((tx) => agentStore.getLastTokens(tx, conversationId));
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
              summarizationModel === model
                ? provider
                : (await resolveOrFail(resolveProvider, summarizationModel)).provider;
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
        return deps.runInTx((tx) =>
          agentStore.insertMessages(tx, {
            conversationId,
            messages: result.newMessages,
            profileId: snapshot.profileId,
            model: snapshot.model,
            lastInboundMessageId: maxInboundId,
            lastMessageInputTokens: result.usage.inputTokens,
            lastMessageOutputTokens: result.usage.outputTokens,
          }),
        );
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

      // ──── DURABLE: voice delivery (Option B — voice + transcript) ────
      //
      // TTS happens AFTER persist + batch delivery so the streamed text
      // already landed before we touch the voice provider — a TTS failure
      // never strands the user (text is in front of them, voice is a
      // bonus). Wrapped in step.run so retries replay from the cached
      // result rather than re-charging the TTS provider; cached value is
      // just the audio length so step state stays small. Long replies
      // (above the per-channel cap) skip TTS entirely — the cap is a
      // fail-safe; the prompt hint should keep replies short already.
      if (
        voiceModeForTurn &&
        delivery.canDeliverVoice() &&
        deps.ttsProvider &&
        deps.voiceConfig &&
        result.text.length > 0
      ) {
        await step.run("voice-delivery", async () => {
          const cap = await deps.runInTx((tx) =>
            transportStore.getVoiceMaxReplyChars(tx, conversationId),
          );
          const effectiveCap = cap ?? 700;
          if (result.text.length > effectiveCap) {
            logger.info(
              { conversationId, length: result.text.length, cap: effectiveCap },
              "voice reply skipped — over cap",
            );
            // The streamed text reply already landed; tell the user voice
            // was skipped so they know why their voice request didn't
            // produce a clip. Notify reaches every active session — in
            // mixed-channel setups a non-voice session also sees the
            // note, which is harmless and matches Option B (text always
            // wins). Wrapped in try/catch so a transient notify failure
            // (Telegram rate limit, network blip) can't fail the whole
            // turn — the text reply has already succeeded; the note is a
            // best-effort UX nicety.
            try {
              await deliveryRouter.notifyConversation(
                conversationId,
                "(text reply too long for voice — see above)",
              );
            } catch (notifyErr) {
              logger.warn(
                { err: notifyErr, conversationId },
                "voice over-cap notification failed; turn already succeeded",
              );
            }
            return { skipped: "over_cap", length: result.text.length };
          }
          // ttsProvider + voiceConfig narrowed by the outer guard; redo
          // the check inside the closure since TS doesn't track narrowings
          // across the `await` boundary into the step.run body.
          const tts = deps.ttsProvider;
          const cfg = deps.voiceConfig;
          if (!tts || !cfg) {
            // Unreachable — outer guard ensures both are defined.
            return { skipped: "no_provider" };
          }
          const { audio, mediaType } = await tts.tts({
            text: result.text,
            voice: cfg.ttsVoice,
            model: cfg.ttsModel,
            format: "ogg",
          });
          await delivery.deliverVoice({ audio, mediaType });
          return { delivered: audio.byteLength, mediaType };
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
