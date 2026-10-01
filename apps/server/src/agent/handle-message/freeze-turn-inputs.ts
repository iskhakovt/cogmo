import type { Transactor } from "../../db/index.js";
import type { ToolDefinition } from "../../llm/types.js";
import { type InboundContent, isVoiceContent } from "../../transport/content.js";
import type {
  DeliveryHandle,
  DeliveryRouter,
  RoutingContext,
} from "../../transport/delivery-router.js";
import type { TransportStore } from "../../transport/store/index.js";
import { resolveVoiceMode } from "../../voice/mode.js";
import type { VoiceBundle } from "../../voice/resolver.js";
import { type LoadedSystemPrompt, loadSystemPrompt } from "../conversation/load-system-prompt.js";
import type {
  RenderSystemPromptArgs,
  SystemPromptDeps,
} from "../conversation/render-system-prompt.js";
import { loadCoreMemoryScope } from "../core-memory/load-core-memory-scope.js";
import type { CoreMemoryScope } from "../core-memory/scope.js";
import type { PromptSource } from "../prompt.js";
import type { AgentStore, Profile, VoiceMode } from "../store/index.js";
import type { ToolRegistry } from "../tools.js";
import { bindFrozenTools, freezeToolTable } from "../turn-tools.js";
import { buildLiveToolCatalog, type LiveToolCatalogDeps } from "./live-tool-catalog.js";
import type { TurnSteps } from "./turn-steps.js";

export interface FreezeTurnInputsDeps extends Omit<LiveToolCatalogDeps, "agentStore"> {
  runInTx: Transactor;
  agentStore: AgentStore;
  transportStore: TransportStore;
  promptSource: PromptSource;
  deliveryRouter: Pick<DeliveryRouter, "prepare">;
}

export interface FreezeTurnInputsArgs {
  conversationId: string;
  runId: string;
  userId: string;
  profileId: string;
  conversation: { isPrivate: boolean; voiceMode: VoiceMode | null };
  routing: Pick<RoutingContext, "maxInboundId" | "prevCursor" | "kind">;
  voiceBundle: VoiceBundle | undefined;
  /** The batch's most recent inbound: the voice decision mirrors its modality. */
  lastInboundContent: InboundContent;
}

/** The system prompt's render arguments, which an epoch the turn opens renders from again. */
export type TurnSystemPromptArgs = RenderSystemPromptArgs & { conversationId: string };

export interface FrozenTurnInputs {
  profile: Profile | undefined;
  coreMemoryScope: CoreMemoryScope;
  delivery: DeliveryHandle;
  /** Whether the reply goes out as voice too. */
  voiceMode: boolean;
  /** Gates `batch-delivery`, so the step exists on every invocation that reaches it or on none. */
  batchDelivery: boolean;
  /** The frozen tool table bound to the live handlers. */
  turnTools: ToolRegistry;
  toolDefs: ToolDefinition[];
  systemPromptDeps: SystemPromptDeps;
  systemPromptArgs: TurnSystemPromptArgs;
  loadedSystemPrompt: LoadedSystemPrompt;
}

/**
 * Freeze what the turn resolves from reads that can change between
 * invocations — the core-memory scope, the voice decision, whether there are
 * batch targets, the tool table — and load the system prompt rendered from
 * them (design/crash-recovery.md → Turn inputs are frozen). Opens the
 * delivery handle on the way, since the voice decision reads its capability.
 *
 * Steps, in order: `freeze-core-memory-scope`, `freeze-turn-inputs`,
 * `load-system-prompt`.
 */
export async function freezeTurnInputs(
  step: TurnSteps,
  deps: FreezeTurnInputsDeps,
  args: FreezeTurnInputsArgs,
): Promise<FrozenTurnInputs> {
  const { agentStore } = deps;
  const { conversationId, userId, profileId, conversation, voiceBundle } = args;

  // Load profile up front — its streaming knobs ride into `prepare` so
  // open streams honor the per-profile chunk target and edit mode, and
  // voice resolution, auto-recall gating, and the `memoryScope` ACL
  // filter further down read the same row. One DB roundtrip per turn.
  // `model` still comes from the turn snapshot, not this read, to
  // preserve the invariant that one turn = one (profileId, model) stamp
  // even if profile.model changes mid-turn.
  const profile = await deps.runInTx((tx) => agentStore.getProfile(tx, profileId));

  // Which core memory the turn renders, reads and writes. Its own step, and
  // ahead of the catalog reads: design/crash-recovery.md → Turn inputs are
  // frozen.
  const coreMemoryScope = await step.run("freeze-core-memory-scope", () =>
    loadCoreMemoryScope({ runInTx: deps.runInTx, agentStore }, { userId, profile }),
  );

  // Open delivery handles early — needed to resolve voice mode
  // (`canDeliverVoice` reflects which active sessions implement
  // `sendVoice`). Side effect is benign: the streaming adapter just
  // tracks an open run id; no Telegram message is posted until first
  // `push`.
  const delivery = await deps.deliveryRouter.prepare({
    conversationId,
    runId: args.runId,
    isPrivate: conversation.isPrivate,
    ...args.routing,
    ...(profile && {
      streamOpts: {
        chunkChars: profile.streamChunkChars,
        allowEdits: profile.streamEdits,
      },
    }),
  });

  const liveTools = await buildLiveToolCatalog(deps, {
    userId,
    coreMemoryScope,
    toolSetGlobs: profile?.toolSet ?? [],
  });

  // Frozen for the turn: decisions resolved from non-durable reads (the
  // profile, the delivery handle, the live catalogs) that shape the LLM
  // request or the step graph. See `turn-tools.ts` for the tool table.
  const turnInputs = await step.run("freeze-turn-inputs", async () => ({
    // Decision gates: adapter capability, TTS provider configured,
    // conversation override (NULL = follow profile default), profile
    // mode, modality of the most recent inbound. See design/voice.md.
    voiceMode: resolveVoiceMode({
      adapterSupportsVoice: delivery.canDeliverVoice(),
      voiceConfigPresent: voiceBundle !== undefined,
      conversationMode: conversation.voiceMode,
      profileMode: profile?.voiceMode ?? "auto",
      // Inspect ONLY the most recent inbound message in the debounced
      // batch — the user's latest intent. If the batch is [voice, text]
      // (user dictated, then typed a follow-up), they're at the keyboard
      // now and shouldn't get a voice reply just because the batch
      // started with voice. Symmetrically, [text, voice] correctly
      // mirrors voice. A forwarded voice note isn't the user speaking.
      lastInboundWasVoice: isVoiceContent(args.lastInboundContent),
    }),
    // Gates `batch-delivery`, so the step exists on every invocation that
    // reaches it or on none.
    batchDelivery: delivery.hasBatchTargets(),
    tools: freezeToolTable(liveTools),
  }));
  const turnTools = bindFrozenTools(turnInputs.tools, liveTools);
  const toolDefs = turnTools.definitions();

  // The system prompt as it renders now, and the conversation's current
  // epoch (design/prompt-caching.md → System Prompt Snapshot). `# Tools`
  // renders from the frozen turn inputs — the same table the loop sends
  // as `tools` — and the base prompt from the outer `profile` read.
  const systemPromptArgs: TurnSystemPromptArgs = {
    conversationId,
    userId,
    profile,
    coreMemoryScope,
    toolDefinitions: toolDefs,
    toolTable: turnInputs.tools,
  };
  const systemPromptDeps: SystemPromptDeps = {
    runInTx: deps.runInTx,
    agentStore,
    promptSource: deps.promptSource,
  };
  const loadedSystemPrompt = await step.run("load-system-prompt", () =>
    loadSystemPrompt(
      { ...systemPromptDeps, transportStore: deps.transportStore },
      systemPromptArgs,
    ),
  );

  return {
    profile,
    coreMemoryScope,
    delivery,
    voiceMode: turnInputs.voiceMode,
    batchDelivery: turnInputs.batchDelivery,
    turnTools,
    toolDefs,
    systemPromptDeps,
    systemPromptArgs,
    loadedSystemPrompt,
  };
}
