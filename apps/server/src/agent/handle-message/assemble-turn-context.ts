import type { Logger } from "pino";
import type { ContentBlock, Message } from "../../llm/types.js";
import { memoryRecallFailures } from "../../metrics.js";
import type { LoadedSystemPrompt } from "../conversation/load-system-prompt.js";
import type { CoreMemoryScope } from "../core-memory/scope.js";
import type { StepRunner } from "../loop.js";
import { type AutoRecallMode, recallQueryText, shouldSkipRecall } from "../recall-gate.js";
import type { Service } from "../service.js";
import {
  continuesEpoch,
  type EpochSnapshot,
  historyStart,
  stripThinkingBefore,
} from "../system-prompt-snapshot.js";
import { renderTurnContext, withTurnContext } from "../turn-context.js";
import type { SubstitutedInbound } from "./inbound-batch.js";
import type { TurnTranscript } from "./load-turn-transcript.js";

export interface AssembleTurnContextArgs {
  /** The conversation's user, who owns the memory bank. */
  userId: string;
  autoRecallMode: AutoRecallMode;
  substitutedMessages: ReadonlyArray<SubstitutedInbound>;
  transcript: TurnTranscript;
  /** The turn's inbound with its attachments resolved. */
  resolvedBlocks: ReadonlyArray<ContentBlock>;
  loadedSystemPrompt: LoadedSystemPrompt;
  voiceMode: boolean;
  coreMemoryScope: CoreMemoryScope;
  timezone: string;
  turnLogger: Logger;
}

export interface AssembledTurnContext {
  /** The history the turn compacts, its own message led by the provisional turn context. */
  messages: Message[];
  /** The turn context compaction counts, an upper bound on the stored one. */
  provisionalTurnContext: string;
  /** Every memory auto-recall returned. */
  recalledMemories: ReadonlyArray<string>;
  /** When the turn was handled: its user row's `created_at`. */
  handledAt: Date;
  /** The conversation's epoch, when the turn continues it. */
  continuing: EpochSnapshot | null;
}

/**
 * Recall memory for the turn and lay out the history it sends, before
 * compaction: the turn's message carries its resolved attachments and a
 * provisional turn context, and the turns before the epoch's opening row lose
 * their thinking blocks.
 *
 * Step: `auto-recall` (unless the recall gate skips it).
 */
export async function assembleTurnContext(
  stepRun: StepRunner,
  service: Service,
  args: AssembleTurnContextArgs,
): Promise<AssembledTurnContext> {
  const { transcript, loadedSystemPrompt } = args;
  const { history: turnHistory, turn } = transcript;
  const recalledMemories = await recallForTurn(stepRun, service, args);

  // This turn's message, led by a provisional block carrying every
  // recalled memory: compaction counts that upper bound, and
  // `render-turn-context` swaps in the stored, deduplicated block.
  const history: Message[] = turnHistory.messages;
  const turnIndex = turnHistory.messageIds.lastIndexOf(turn.id);
  const turnRow = history[turnIndex];
  if (turnRow === undefined) {
    throw new Error(`user message ${turn.id} is missing from the turn's history`);
  }
  const hasAttachments = args.resolvedBlocks.some(
    (b) => b.type === "image" || b.type === "document",
  );
  const handledAt = new Date(turn.createdAt);
  const { channelTypes, coreMemoryChanges } = loadedSystemPrompt;
  // An upper bound on the stored block, which compaction counts: every
  // recalled memory and every core-memory change since the snapshot. The
  // stored block leaves out what earlier turns still in view show.
  const provisionalTurnContext = renderTurnContext({
    handledAt,
    timezone: args.timezone,
    context: {
      recalledMemories: [...recalledMemories],
      voiceMode: args.voiceMode,
      channelTypes,
      announcedCoreMemoryBlocks: coreMemoryChanges.map(({ profileClass, key, updatedAt }) => ({
        profileClass,
        key,
        updatedAt,
      })),
    },
    coreMemoryUpdates: { scope: args.coreMemoryScope, blocks: coreMemoryChanges },
  });

  // The epoch continues unless the configuration or the summary the history
  // starts from changed; compaction below can still open one. The turns
  // before the epoch's opening row lose their thinking blocks, which are
  // bound to an earlier system prompt or history.
  const loadedStart = historyStart(turnHistory.messageIds, null);
  const continuing = continuesEpoch(loadedSystemPrompt.snapshot, {
    configDigest: loadedSystemPrompt.configDigest,
    historyStart: loadedStart,
  })
    ? loadedSystemPrompt.snapshot
    : null;
  // An opener missing from the history belongs to a concurrent turn's epoch,
  // which opened after everything before this turn.
  const openerIndex =
    continuing === null ? -1 : turnHistory.messageIds.indexOf(continuing.openedBy);
  // The row's content, or the resolved image and document blocks it names.
  const messages = stripThinkingBefore(history, openerIndex === -1 ? turnIndex : openerIndex).with(
    turnIndex,
    withTurnContext(
      { role: "user", content: hasAttachments ? [...args.resolvedBlocks] : turnRow.content },
      provisionalTurnContext,
    ),
  );

  return { messages, provisionalTurnContext, recalledMemories, handledAt, continuing };
}

/**
 * Auto-recall: search memory for context relevant to this message, via the
 * scoped service so the profile's `memoryScope` filter applies. Best-effort —
 * a Hindsight failure (server down, malformed query, 4xx from a server-side
 * change we haven't caught up with) must not abort the turn or trigger
 * Inngest re-enqueue. Degrade to "no memories" and let the conversation
 * proceed; the LLM-driven `memory_recall` tool path still surfaces hard
 * failures to the model.
 *
 * Durable: recall costs an embedding round-trip plus a vector search per
 * call, and its result feeds the turn context — caching it keeps both the
 * spend and the context identical across the ~one re-invocation per step
 * boundary that a tool-calling turn produces. The `.catch` stays INSIDE the
 * body so a Hindsight failure degrades to "no memories" instead of failing
 * the step into Inngest retries, and so the failure counts once per failed
 * recall rather than once per replay. `bank_id` is the conversation user, who
 * owns the bank (`buildTurnService`). Known conditional-step caveat: the gate
 * reads `profile.autoRecall` from a non-durable read, so a concurrent settings
 * change mid-turn can flip the step's existence between invocations — same
 * accepted hazard as `summarize-prefix-outcome`, see design/crash-recovery.md.
 */
async function recallForTurn(
  stepRun: StepRunner,
  service: Service,
  args: Pick<
    AssembleTurnContextArgs,
    "userId" | "autoRecallMode" | "substitutedMessages" | "turnLogger"
  >,
): Promise<ReadonlyArray<string>> {
  const recallQuery = recallQueryText(args.substitutedMessages);
  const recallResult = shouldSkipRecall(args.autoRecallMode, recallQuery)
    ? { memories: [] }
    : await stepRun("auto-recall", async () =>
        service.memory.recall(recallQuery, { maxTokens: 2000 }).catch((err: unknown) => {
          args.turnLogger.warn({ err }, "auto-recall failed, proceeding without recalled context");
          memoryRecallFailures.add(1, { bank_id: args.userId });
          return { memories: [] };
        }),
      );
  return recallResult.memories.map((m) => m.content);
}
