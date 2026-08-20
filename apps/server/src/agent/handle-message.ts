import { NonRetriableError } from "inngest";
import type { Logger } from "pino";
import * as R from "remeda";
import type { Transactor } from "../db/index.js";
import { inngest } from "../inngest/client.js";
import {
  buildConversationCooldownClearedEvent,
  buildConversationErroredEvent,
  calculateElapsedCooldown,
  conversationDegraded,
  inboundReady,
  responseReady,
} from "../inngest/events.js";
import { isRetriableProviderError } from "../llm/fallback.js";
import { computeBudget, resolveLimits } from "../llm/models.js";
import {
  type LlmProviderResolver,
  ProviderConfigError,
  type ResolvedLlm,
} from "../llm/resolver.js";
import type { ContentBlock, CountTokensParams, Message, StreamEvent } from "../llm/types.js";
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
import type { VoiceProviderResolver } from "../voice/resolver.js";
import type { CodingService } from "./coding/service.js";
import { compactMessages, SUMMARIZATION_PROMPT, shouldSkipCounting } from "./context.js";
import { loadConversationContext } from "./conversation/load-conversation-context.js";
import { buildInCooldownReply, isInCooldown } from "./cooldown.js";
import type { DebounceConfig } from "./debounce.js";
import { extractGeneratedDocuments, extractGeneratedImages } from "./extract-images.js";
import type { ImageToolsLoader } from "./image-tools-loader.js";
import type { AgentLoopResult, StreamingAgentLoopParams } from "./loop.js";
import { createPipelinesService } from "./pipeline/pipelines-service.js";
import type { PipelineStore } from "./pipeline/store/index.js";
import { PIPELINE_TOOL_NAMES } from "./pipeline/tools.js";
import type { PromptSource } from "./prompt.js";
import { shouldSkipRecall } from "./recall-gate.js";
import { synthesizeDegradedReply } from "./repair.js";
import { createSchedulingService } from "./scheduling/scheduling-service.js";
import type { Service } from "./service.js";
import { createService } from "./service.js";
import type { AgentStore } from "./store/index.js";
import { buildSubAgentTools } from "./subagent/sub-agent-tool-builder.js";
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
 * What the streaming adapters were shown during one turn. Sourced from
 * `AgentLoopResult.streamed`, which the loop derives from its durable
 * iteration outcomes — identical on every Inngest re-invocation, unlike a
 * ledger of this invocation's live emissions (empty when the iterations
 * replay from the step cache).
 */
interface StreamedOutput {
  /** Every `text_delta` forwarded this turn, concatenated in order. */
  text: string;
  /** Every `tool_start` id forwarded this turn, in order. */
  toolUseIds: ReadonlyArray<string>;
}

/**
 * Work out what the degraded off-ramp has to take back off the user's screen.
 *
 * The orchestrator is the only component that sees both sides: `streamed` is
 * what the adapters were told during the turn, `newMessages` is what the
 * persist step is about to write. The difference is the degrade-triggering
 * iteration's output — the loop drops that iteration, so the user must not be
 * left reading it. Everything else streamed this turn is persisted and stays
 * exactly where it is.
 *
 * The persisted assistant text is a prefix of the streamed text: the dropped
 * iteration is always the last one, and each earlier iteration's text blocks
 * are reassembled from precisely the deltas that were forwarded. When that
 * prefix relationship doesn't hold, the turn is persisting text that was never
 * streamed — the non-streaming replay is the one path that does this, since it
 * deliberately doesn't re-emit its deltas — and there is no honest retraction
 * to make, so the text stands and only tool cards are reconciled.
 *
 * Returns null when everything streamed is being persisted (the iteration-cap
 * degrade drops nothing) — there is no retraction to push.
 */
function computeRetraction(
  streamed: StreamedOutput,
  newMessages: ReadonlyArray<Message>,
  log: Logger,
): { text: string; toolUseIds: ReadonlyArray<string> } | null {
  const persistedText = R.pipe(
    newMessages,
    R.filter((m) => m.role === "assistant"),
    R.flatMap((m) =>
      typeof m.content === "string"
        ? [m.content]
        : R.flatMap(m.content, (b) => (b.type === "text" ? [b.text] : [])),
    ),
    R.join(""),
  );
  const persistedToolUseIds = new Set(
    R.pipe(
      newMessages,
      R.flatMap((m) => (typeof m.content === "string" ? [] : m.content)),
      R.flatMap((b) => (b.type === "tool_use" ? [b.id] : [])),
    ),
  );

  const textIsPrefix = streamed.text.startsWith(persistedText);
  if (!textIsPrefix) {
    log.warn(
      { streamedChars: streamed.text.length, persistedChars: persistedText.length },
      "degraded turn persists assistant text that was never streamed; retracting no text",
    );
  }
  const text = textIsPrefix ? streamed.text.slice(persistedText.length) : "";
  const toolUseIds = streamed.toolUseIds.filter((id) => !persistedToolUseIds.has(id));

  if (text.length === 0 && toolUseIds.length === 0) return null;
  return { text, toolUseIds };
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
        const turnLogger = logger.child({ runId, conversationId });
        // `error` is what Inngest saw — typically NonRetriableError, since
        // we rewrap non-retriable provider errors above. The original
        // class (BadRequestError, RateLimitError, etc.) is on `cause`.
        // Surface both so the evolution failure-reflector can bucket by
        // upstream class rather than every error coalescing to one bucket.
        const cause = error.cause;
        const causeClass = cause instanceof Error ? cause.name : null;
        // Bus-level dedup with the worker-death reconcile (subscriber on
        // `inngest/function.failed`). Both emit `conversation/errored`
        // via `buildConversationErroredEvent`, which bakes in
        // `id: "errored-${runId}"`. Inngest's event-id dedup window
        // ensures `recover-conversation` runs exactly once even when
        // both paths fire for the same failed run. See
        // `src/inngest/events.ts → buildConversationErroredEvent` and
        // `design/agent-resilience.md → Triggers`.
        await step.sendEvent(
          "emit-conversation-errored",
          buildConversationErroredEvent({
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
            turnLogger.error(
              { err: notifyErr },
              "onFailure: notifyConversation failed, conversation/errored already emitted",
            );
          }
        });
      },
    },
    async ({ event, step, runId }) => {
      const { conversationId, triggerInboundId } = event.data;

      // Per-turn child logger — every emission inside the agent loop inherits
      // `runId` + `conversationId` so the evolution failure-reflector can join
      // logs to `conversation/degraded` events. See design/agent-resilience.md.
      const turnLogger = logger.child({ runId, conversationId });

      // ──── DURABLE: load context + entry guards ────

      const conv = await step.run("load-conversation", async () => {
        return deps.runInTx((tx) => agentStore.getConversation(tx, conversationId));
      });
      if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

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

      // Cooldown guard — `recover-conversation` writes a `cooldown_state`
      // blob on conversations whose `handle-message` runs exhausted retries
      // (or failed non-retriably). While the cooldown window is open, we
      // refuse to spend more LLM calls; the user gets a terse hand-built
      // reply with a retry-time estimate.
      //
      // Placement is deliberate — *after* the no_messages / staleness /
      // await_input exits — so the cooldown reply only fires when there's
      // a real triggering inbound the user is actively trying to deliver.
      // Otherwise a null-trigger flush during cooldown would send a reply
      // to a message that doesn't exist.
      //
      // The debounce contract caps the reply rate naturally: a burst of
      // user messages during one debounce window coalesces to one
      // `inbound/ready` and one cooldown reply. Across multiple debounce
      // windows in the same cooldown the user gets N replies, where N is
      // the number of user-active windows — not a tight loop. See
      // design/agent-resilience.md → In-cooldown reply.
      //
      // Inbounds stay unbatched — `getUnbatchedInbound` is a pure SELECT,
      // so when the cooldown elapses the next `inbound/ready` loads the
      // entire backlog as one batch.
      const guardNow = new Date();
      if (conv.cooldownState !== null && isInCooldown(conv.cooldownState, guardNow)) {
        const cooldownState = conv.cooldownState;
        await step.run("in-cooldown-reply", async () => {
          try {
            await deliveryRouter.notifyConversation(
              conversationId,
              buildInCooldownReply(cooldownState, guardNow),
            );
          } catch (notifyErr) {
            // Best-effort delivery — same shape as `onFailure`'s
            // `notify-user`. Swallowing prevents a transient session-lookup
            // or transport blip from propagating up, exhausting Inngest's
            // retry budget, and tripping `onFailure` → spuriously doubling
            // the cooldown for what's really just a delivery hiccup.
            turnLogger.error(
              { err: notifyErr },
              "in-cooldown-reply: notifyConversation failed; conversation stays in cooldown",
            );
          }
        });
        return { status: "skipped", reason: "cooldown" };
      }

      const inboundBlocks = inboundMessages.flatMap((m) => contentToBlocks(m.content));
      // Safe — guarded by length check above
      const maxInboundId = inboundMessages.at(-1)?.id ?? "";

      // A batch is either all-user or all-scheduled — never mixed. The
      // debounce stages user inbounds; scheduled fires emit their own
      // `inbound/arrived` independently after persisting a single
      // synthetic row, so the two paths can't legitimately interleave
      // into one turn. A mixed batch would mean a fire landed in a
      // user-batched turn (or vice versa) and the routing kind below
      // would silently pick the wrong path — fail fast instead.
      const scheduledCount = inboundMessages.filter((m) => m.source === "scheduled").length;
      if (scheduledCount > 0 && scheduledCount !== inboundMessages.length) {
        throw new Error(
          `mixed-source inbound batch in conversation ${conversationId}: ${scheduledCount}/${inboundMessages.length} scheduled`,
        );
      }
      // Scheduled inbounds have no originating session for source
      // routing — broadcast to every reachable session instead.
      const routingKind: "reply" | "broadcast" = scheduledCount > 0 ? "broadcast" : "reply";

      // Voice bundle resolved once per turn (one indexed singleton read +
      // two secret lookups; cached by content hash inside the resolver so
      // steady-state cost is negligible). Re-runs on replay — providers
      // aren't durable, but step.run still caches transcript / audio
      // results downstream, so the upstream APIs aren't re-billed. Config
      // edits between attempts surface on the next non-cached step.
      const voiceBundle = await deps.voiceResolver?.();

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
              const stt = voiceBundle?.stt;
              if (!stt) {
                throw new Error(
                  "voice block received but no STT provider configured — run `cogmo setup` and configure voice, or insert a `voice_config` row pointing at valid `secrets` entries",
                );
              }
              const out: string[] = [];
              for (const ref of voiceRefs) {
                const bytes = await attachments.download(ref.path);
                const result = await stt.provider.stt({
                  audio: bytes,
                  mediaType: ref.mediaType,
                  model: stt.model,
                });
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

      // Load profile up front — its streaming knobs ride into `prepare` so
      // open streams honor the per-profile chunk target and edit mode, and
      // voice resolution, auto-recall gating, and the `memoryScope` ACL
      // filter further down read the same row. One DB roundtrip per turn.
      // `model` still comes from the turn snapshot, not this read, to
      // preserve the invariant that one turn = one (profileId, model) stamp
      // even if profile.model changes mid-turn.
      const profile = await deps.runInTx((tx) => agentStore.getProfile(tx, profileId));

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
        ...(profile && {
          streamOpts: {
            chunkChars: profile.streamChunkChars,
            allowEdits: profile.streamEdits,
          },
        }),
      });

      // Resolve per-turn voice mode BEFORE prompt assembly so the
      // voice-style hint can be injected when TTS is in play. Decision
      // gates: adapter capability, TTS provider configured, conversation
      // override (NULL = follow profile default), profile mode, modality of
      // the most recent inbound. See design/voice.md.
      const voiceModeForTurn = resolveVoiceMode({
        adapterSupportsVoice: delivery.canDeliverVoice(),
        voiceConfigPresent: voiceBundle !== undefined,
        conversationMode: conv.voiceMode,
        profileMode: profile?.voiceMode ?? "auto",
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
      // One `subagent__<name>` tool per row, loaded fresh each turn (CLI CRUD
      // takes effect without a restart). The handler closes over the same
      // per-turn `resolveProvider`, so a sub-agent can target any routable
      // model — including a different provider than the main turn. Joins the
      // built-ins set; the `subagent__` namespace makes a collision with a
      // built-in structurally impossible.
      const subAgentTools = buildSubAgentTools(
        await deps.runInTx((tx) => agentStore.listSubAgents(tx, userId)),
        resolveProvider,
      );
      const turnToolSetGlobs = profile?.toolSet ?? [];
      const mcpTools = deps.mcpRegistry
        ? await deps.mcpRegistry.resolveTools({ toolGlobs: turnToolSetGlobs })
        : [];
      const turnTools = composeTurnTools({
        builtIns: [...tools.snapshot(), ...imageTools, ...subAgentTools],
        skillTools,
        mcpTools,
        toolSetGlobs: turnToolSetGlobs,
      });
      const toolDefs = turnTools.definitions();

      // Profile passed in from the outer read (`profile`) so
      // voice-mode resolution, `composeTurnTools` globs, and the prompt's
      // `# Tools` / base-prompt sections all come from the same row. A
      // concurrent `/settings` mid-turn used to land between the outer
      // read and a second `getProfile` inside this step (separate
      // durable steps run in separate txs, so the project's REPEATABLE
      // READ snapshot doesn't span them), leaving the prompt's tool
      // filter and base-prompt sourced from different snapshots.
      const systemPrompt = await step.run("assemble-prompt", async () => {
        const ctx = await loadConversationContext(
          { runInTx: deps.runInTx, agentStore, transportStore },
          { conversationId, profile: profile },
        );
        return promptSource.assemble({
          profile: profile,
          rules: ctx.rules,
          voiceMode: voiceModeForTurn,
          toolDefinitions: toolDefs,
        });
      });

      // ──── Streaming section: bare-body glue + in-loop durable steps ────

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
      // Pipelines service compiles on the conversation's current model and
      // validates stage tool-globs against this turn's composed tool list,
      // so a definition can't allowlist a tool the profile can't see. The
      // pipeline tools themselves are excluded — a run defining/activating
      // pipelines mid-run is a self-modification surface the
      // preview/confirm gate exists to prevent.
      const pipelinesService = deps.pipelineStore
        ? createPipelinesService({
            runInTx: deps.runInTx,
            store: deps.pipelineStore,
            userId,
            resolveProvider,
            model: snapshot.model,
            validation: {
              availableTools: toolDefs
                .map((d) => d.name)
                .filter((name) => !PIPELINE_TOOL_NAMES.includes(name)),
              knownEventSources: [],
            },
          })
        : undefined;
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
        pipelinesService,
      );

      // Single conversion point for "this failure gains nothing from a
      // blind retry" — shared by the durable-step wrapper below and the
      // outer catch around the streaming section.
      const asNonRetriable = (err: unknown): NonRetriableError => {
        const message = err instanceof Error ? err.message : String(err);
        return new NonRetriableError(message, { cause: err });
      };

      // Durable boundary wrapper shared by the in-turn steps (`llm-iter<N>`,
      // `tool-iter<N>-<P>`, `auto-recall`, `summarize-prefix`,
      // `load-last-tokens`, `count-tokens-<n>`, `emit-tool-results-iter<N>`).
      // It injects Inngest's `step.run` without making the loop depend on
      // Inngest, and applies the retry policy per step kind INSIDE the body:
      //
      // - `tool-iter*` gets NO step retries at all. A failed tool handler is
      //   the model's feedback channel — the agent loop is the retry
      //   mechanism (the model re-decides with the `is_error` tool_result in
      //   context), and blind re-runs of the same handler only delay that
      //   feedback by the backoff schedule. This covers deterministic
      //   failures (Zod validation, edit_file mismatches) and outages alike:
      //   a fresh tool_use from the model creates a fresh step, which IS the
      //   retry.
      // - Everything else keeps Inngest's per-step retries for transient
      //   failures, with deterministic provider errors (4xx that aren't
      //   408/425/429) translated to NonRetriableError so Inngest fails fast
      //   instead of burning attempts on a call that fails identically.
      //
      // The cast erases Inngest's `Jsonify<T>` return type: every payload
      // passed through this wrapper is JSON-safe by construction (see
      // design/crash-recovery.md → State serialization), so `Jsonify<T>` and
      // `T` coincide at runtime but not for the compiler.
      const stepRun = <T>(id: string, fn: () => Promise<T>): Promise<T> =>
        step.run(id, async () => {
          try {
            return await fn();
          } catch (err) {
            if (id.startsWith("tool-iter")) throw asNonRetriable(err);
            if (!isRetriableProviderError(err)) throw asNonRetriable(err);
            throw err;
          }
        }) as Promise<T>;

      // Auto-recall: search memory for context relevant to this message, via
      // the scoped service so the profile's `memoryScope` filter applies.
      // Best-effort — a Hindsight failure (server down, malformed query, 4xx
      // from a server-side change we haven't caught up with) must not abort
      // the turn or trigger Inngest re-enqueue. Degrade to "no memories" and
      // let the conversation proceed; the LLM-driven `memory_recall` tool
      // path still surfaces hard failures to the model.
      const autoRecallMode = profile?.autoRecall ?? "heuristic";
      // Durable: recall costs an embedding round-trip plus a vector search
      // per call, and its result feeds the system prompt — caching it keeps
      // both the spend and the prompt identical across the ~one re-invocation
      // per step boundary that a tool-calling turn produces. The `.catch`
      // stays INSIDE the body so a Hindsight failure degrades to "no
      // memories" instead of failing the step into Inngest retries. Known
      // conditional-step caveat: the gate reads `profile.autoRecall` from a
      // non-durable read, so a concurrent settings change mid-turn can flip
      // the step's existence between invocations — same accepted hazard as
      // `summarize-prefix`, see design/crash-recovery.md.
      const recallResult = shouldSkipRecall(autoRecallMode, userContentText)
        ? { memories: [] }
        : await stepRun("auto-recall", async () =>
            service.memory.recall(userContentText, { maxTokens: 2000 }).catch((err: unknown) => {
              turnLogger.warn({ err }, "auto-recall failed, proceeding without recalled context");
              return { memories: [] };
            }),
          );
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
      // compactMessages orchestration runs on every invocation — the
      // threshold decisions are pure functions, and `historyMessages`
      // carries resolved image payloads that must not land in Inngest step
      // state, so the pipeline itself can't be a step. Its expensive or
      // decision-bearing inputs ARE steps: history, auto-recall,
      // `load-last-tokens` (freezes the skip decision persist-new-messages
      // would otherwise flip mid-run), each `count-tokens-<n>` round-trip,
      // and the `summarize-prefix` LLM call. Every replay therefore walks
      // the same decision tree over cached values. See
      // design/crash-recovery.md.

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

      // Durable: persist-new-messages rewrites the row this reads MID-RUN,
      // so a bare-body read would flip `skipBudgetStrategies` between
      // invocations — and with it the compaction decisions and the
      // existence of the conditional `summarize-prefix` / `count-tokens-*`
      // steps. Freezing the read pins the whole compaction decision tree
      // for the run.
      const lastTokens = await stepRun("load-last-tokens", () =>
        deps.runInTx((tx) => agentStore.getLastTokens(tx, conversationId)),
      );
      const skipBudgetStrategies = shouldSkipCounting(
        lastTokens?.inputTokens ?? null,
        lastTokens?.outputTokens ?? null,
        userContentText.length,
        budget,
      );

      // Always invoke compaction. Strategy 0 (same-tool supersession)
      // is structural and runs regardless of budget — gating it behind
      // shouldSkipCounting would defeat the design (volume-driven
      // attention dilution doesn't care about budget headroom). The
      // skip-counting decision now flows in as `skipBudgetStrategies`,
      // which gates Strategies 1–3 inside compactMessages so the
      // expensive provider.countTokens round-trip is only paid when
      // budget pressure could matter.
      const compactResult = await compactMessages(
        fullPrompt,
        historyMessages,
        toolDefs,
        {
          // Each count is a full-payload POST (system + history + tool
          // schemas + resolved images) — durable so re-invocations replay
          // the integer instead of re-shipping megabytes per boundary. The
          // call sequence is deterministic per run: compaction's inputs are
          // frozen (durable history, auto-recall, load-last-tokens), so the
          // counter-keyed ids line up on every replay.
          countTokens: (() => {
            let countCall = 0;
            return (params: CountTokensParams) => {
              countCall += 1;
              return stepRun(`count-tokens-${countCall}`, () =>
                provider.countTokens({ ...params, model }),
              );
            };
          })(),
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
            // Keep the resolved limits, not just the provider: the cap
            // below has to respect this model's own output ceiling, and
            // the main model's row overrides don't describe it.
            const resolvedSummarization =
              summarizationModel === model
                ? null
                : await resolveOrFail(resolveProvider, summarizationModel);
            const summarizationProvider = resolvedSummarization?.provider ?? provider;
            const summarizationLimits = resolvedSummarization
              ? resolveLimits(summarizationModel, resolvedSummarization.limits)
              : limits;
            // Step ID is hardcoded — relies on `compactMessages` calling
            // `summarize` at most once per invocation (contract on
            // ContextManagerDeps.summarize). If that ever changes, switch to
            // a counter-based ID like `summarize-prefix-${i}` to avoid
            // Inngest's duplicate-step-id error.
            return stepRun("summarize-prefix", async () => {
              // Status banner lives inside the step body so it reaches the
              // user exactly once — compactMessages re-runs on every
              // invocation, and a bare-body push would re-append the banner
              // (or open a stray message on a post-finish replay handle)
              // each time.
              await delivery.push({ type: "status", message: "Summarizing conversation..." });
              const response = await summarizationProvider.chat({
                model: summarizationModel,
                system,
                messages: [...msgs, { role: "user", content: SUMMARIZATION_PROMPT }],
                // Room for reasoning as well as the summary, bounded by
                // what this model accepts — asking above its ceiling is a
                // 400, which compaction swallows into a fall-through to
                // truncation.
                maxTokens: Math.min(16_000, summarizationLimits.maxOutputTokens),
              });
              return response.content
                .filter((b) => b.type === "text")
                .map((b) => (b as { text: string }).text)
                .join("");
            });
          },
        },
        skipBudgetStrategies,
      );
      historyMessages = compactResult.messages;

      let result: AgentLoopResult;
      try {
        result = await runStreamingAgentLoop({
          provider,
          model,
          systemPrompt: fullPrompt,
          messages: historyMessages,
          tools: turnTools,
          service,
          // The number `computeBudget` reserved for output when it sized
          // the input budget above; reasoning shares it on models that
          // think by default. That reservation covers one iteration while
          // the loop caps every one, so a long tool-using turn can still
          // outgrow the window and degrade to `context_overflow`.
          maxTokens: limits.maxOutputTokens,
          onEvent: (event: StreamEvent) => delivery.push(event),
          // Durable boundaries inside the loop: each streaming LLM
          // iteration runs in a `llm-iter<N>` step (tokens reach the
          // delivery layer live from inside the step body; a memoized
          // replay returns the cached iteration outcome without calling
          // the provider or re-emitting), and each `durable: true` tool
          // handler runs in a `tool-iter<N>-<P>` step. Handlers execute
          // *between* stream events, so wrapping preserves event
          // ordering. See design/crash-recovery.md → Durable LLM
          // iterations / Per-tool durability.
          stepRun,
          // Turn token for per-tool-call idempotency keys. Off the event
          // payload, so it survives re-invocations, function retries and
          // re-deliveries alike — the scope a side-effectful tool should
          // dedup over, and one a run id would not give. `flush` turns carry
          // a null trigger while still processing real input, so they fall
          // back to the batch's high-water mark off the memoized
          // `load-inbound` step. Both are empty only for a turn with no
          // inbound rows, which has nothing to duplicate.
          ...((event.data.triggerInboundId ?? maxInboundId) !== "" && {
            turnKey: event.data.triggerInboundId ?? maxInboundId,
          }),
          turnLogger,
        });
        // Class C / D degraded off-ramp. The loop exited because a repair
        // budget exhausted (or an immediate-degrade subtype tripped); the
        // user-facing apology is appended here so the streamed reply
        // closes with a coherent message rather than silence. See
        // design/agent-resilience.md → Degraded reply.
        if (result.degraded) {
          const degraded = result.degraded;
          // Retraction computed OUTSIDE the step from `result.streamed` —
          // the loop derives that ledger from its durable iteration
          // outcomes, so it is identical on every invocation (a ledger of
          // live emissions would be empty on a replay whose iterations all
          // came from the step cache).
          const retraction = computeRetraction(result.streamed, result.newMessages, turnLogger);
          // One step owns the whole user-visible off-ramp: the tools-free
          // synthesis LLM call plus the retract/apology pushes. The
          // synthesis is billable and the pushes append to the user's live
          // message, so both must fire exactly once across the persist /
          // delivery / notify boundaries that follow — in the bare body
          // they would re-fire on every subsequent re-invocation. The
          // step returns the apology text, so replays persist the same
          // words the user saw. Plain `step.run`, not the `stepRun`
          // wrapper: synthesizeDegradedReply swallows provider failures
          // into the fixed fallback string internally, so no 4xx can
          // escape this body — the only escapable errors are delivery
          // pushes, which should keep normal step-retry semantics.
          const apology = await step.run("degraded-reply", async () => {
            // One tools-free LLM call summarizes the failure in
            // user-facing terms (what was attempted, what went wrong, one
            // next step). Falls through to the fixed string on any
            // synthesis failure (timeout, refusal, provider outage). See
            // design/agent-resilience.md → Tools-free synthesis on
            // degrade.
            const { text } = await synthesizeDegradedReply({
              provider,
              model: result.model,
              messages: result.messages,
              reason: degraded.reason,
              subtype: degraded.subtype,
              log: turnLogger,
            });
            // Retract first. Output streamed before the degrade fired is
            // already on the user's screen (Telegram edits the live
            // message every ~500ms; the web adapter forwards every delta
            // as an SSE frame), and the loop drops the triggering
            // iteration from `newMessages` — so appending the apology to
            // it would leave the user reading a truncated fragment welded
            // to an apology that history doesn't contain. The retraction
            // names that iteration's output and nothing else: text and
            // tool calls from earlier iterations are persisted, so they
            // stay. Nothing to retract (nothing streamed, or an
            // iteration-cap degrade that persists every iteration) means
            // no event at all.
            if (retraction) {
              await delivery.push({ type: "retract", ...retraction });
            }
            await delivery.push({ type: "text_delta", text });
            return text;
          });
          result = {
            ...result,
            text: apology,
            newMessages: [
              ...result.newMessages,
              { role: "assistant", content: [{ type: "text", text: apology }] },
            ],
          };
        }
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
          throw asNonRetriable(err);
        }
        // Never wrap the error on this rethrow path. A permanently-failed
        // step surfaces here as Inngest's StepError (no `status`, so it
        // classifies as "retriable" above), and the engine's non-retriable
        // detection relies on the rethrown object keeping its identity and
        // serialized name — wrapping it would silently re-enable function
        // retries that instantly replay the memoized rejection.
        throw err;
      }

      turnLogger.info(
        {
          model: result.model,
          iterations: result.iterations,
          usage: result.usage,
        },
        "agent loop complete",
      );

      // ──── DURABLE: persist all new messages (tool turns + final assistant) ────
      //
      // Half-open success: when the entry guard saw an elapsed cooldown
      // and admitted this probe turn, clear `cooldown_state` in the same
      // transaction. Strict prior-cooldown gating avoids a per-turn
      // pointless UPDATE on Closed conversations.

      const wasCoolingDown = conv.cooldownState !== null;
      const assistantMsg = await step.run("persist-new-messages", async () => {
        return await deps.runInTx(async (tx) => {
          const inserted = await agentStore.insertMessages(tx, {
            conversationId,
            messages: result.newMessages,
            profileId: snapshot.profileId,
            model: snapshot.model,
            lastInboundMessageId: maxInboundId,
            lastMessageInputTokens: result.usage.inputTokens,
            lastMessageOutputTokens: result.usage.outputTokens,
          });
          if (wasCoolingDown) {
            await agentStore.clearCooldown(tx, conversationId);
          }
          return inserted;
        });
      });

      // Half-open success: cooldown was cleared inside the persist tx.
      // Emit `conversation/cooldown/cleared` as a separate durable step
      // AFTER persist commits so the event can't fire on a rolled-back
      // tx. Same pattern as the degrade emit below. Pre-tx
      // `conv.cooldownState` carries `lastErroredAt` for the elapsed
      // calculation. Explicit bus-dedup `id` keyed on the cooldown
      // being cleared protects against `step.sendEvent`'s at-least-once
      // delivery contract — a retry after the send registers but before
      // the cache write would otherwise double-fire downstream
      // consumers. See design/agent-resilience.md → Telemetry.
      //
      // Narrow once via the local — `wasCoolingDown` is the same
      // predicate but doesn't help TS narrow `conv.cooldownState`.
      const priorCooldown = conv.cooldownState;
      if (priorCooldown !== null) {
        await step.sendEvent(
          "emit-cooldown-cleared",
          buildConversationCooldownClearedEvent(
            {
              conversationId,
              clearedBy: "success",
              elapsedCooldownSeconds: calculateElapsedCooldown(priorCooldown.lastErroredAt),
            },
            `cooldown-cleared-${conversationId}-${priorCooldown.lastErroredAt}`,
          ),
        );
      }

      // Emit the degrade signal as a separate durable step after persist —
      // `step.sendEvent` provides exactly-once delivery, same pattern as
      // `conversation/errored` in `onFailure`. See
      // design/agent-resilience.md → Telemetry.
      if (result.degraded) {
        const degradedSubtype = result.degraded.subtype;
        await step.sendEvent(
          "emit-conversation-degraded",
          conversationDegraded.create({
            conversationId,
            runId,
            triggerInboundId,
            subtype: degradedSubtype,
            reason: result.degraded.reason,
          }),
        );
      }

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
              turnLogger.error(
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
              turnLogger.error(
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
      if (voiceModeForTurn && delivery.canDeliverVoice() && voiceBundle && result.text.length > 0) {
        const ttsBundle = voiceBundle.tts;
        await step.run("voice-delivery", async () => {
          const cap = await deps.runInTx((tx) =>
            transportStore.getVoiceMaxReplyChars(tx, conversationId),
          );
          const effectiveCap = cap ?? 700;
          if (result.text.length > effectiveCap) {
            turnLogger.info(
              { length: result.text.length, cap: effectiveCap },
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
              turnLogger.warn(
                { err: notifyErr },
                "voice over-cap notification failed; turn already succeeded",
              );
            }
            return { skipped: "over_cap", length: result.text.length };
          }
          const { audio, mediaType } = await ttsBundle.provider.tts({
            text: result.text,
            voice: ttsBundle.voice,
            model: ttsBundle.model,
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
