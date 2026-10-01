import type { Message } from "../../llm/types.js";
import type { LoadedSystemPrompt } from "../conversation/load-system-prompt.js";
import { openSystemPromptEpoch } from "../conversation/open-system-prompt-epoch.js";
import type { SystemPromptDeps } from "../conversation/render-system-prompt.js";
import { storeTurnContext } from "../conversation/store-turn-context.js";
import type { CoreMemoryScope } from "../core-memory/scope.js";
import {
  type EpochSnapshot,
  historyStart,
  stripThinkingBefore,
  unannounced,
} from "../system-prompt-snapshot.js";
import {
  announcedInView,
  findTurnContext,
  newMemories,
  replaceTurnContext,
  shownMemories,
} from "../turn-context.js";
import type { TurnSystemPromptArgs } from "./freeze-turn-inputs.js";
import type { TurnTranscript } from "./load-turn-transcript.js";
import type { TurnSteps } from "./turn-steps.js";

export interface FinalizeTurnContextArgs {
  /** The compacted history, the turn's message led by its provisional turn context. */
  messages: Message[];
  provisionalTurnContext: string;
  transcript: TurnTranscript;
  /** The conversation's epoch, when the turn continued it before compaction. */
  continuing: EpochSnapshot | null;
  /** The cutoff of the summary compaction stored, if it stored one. */
  storedCutoff: string | null;
  loadedSystemPrompt: LoadedSystemPrompt;
  systemPromptArgs: TurnSystemPromptArgs;
  recalledMemories: ReadonlyArray<string>;
  handledAt: Date;
  voiceMode: boolean;
  coreMemoryScope: CoreMemoryScope;
  timezone: string;
}

export interface FinalizedTurnContext {
  /** The epoch's system prompt, which the loop sends. */
  systemPrompt: string;
  /** The history the loop sends, the turn's message led by its stored turn context. */
  messages: Message[];
}

/**
 * Settle the epoch the turn sends and its stored turn context, over the
 * compacted view.
 *
 * Steps, in order: `open-system-prompt-epoch` (unless the turn continues its
 * epoch), `render-turn-context`.
 */
export async function finalizeTurnContext(
  step: TurnSteps,
  deps: SystemPromptDeps,
  args: FinalizeTurnContextArgs,
): Promise<FinalizedTurnContext> {
  const { transcript, continuing } = args;
  const { history: turnHistory, turn } = transcript;
  let historyMessages = args.messages;

  const turnPosition = findTurnContext(historyMessages, args.provisionalTurnContext);
  if (turnPosition === -1) throw new Error("compaction dropped the turn's own message");

  // A summary this turn stored moves the history's start, so the turn opens
  // an epoch on the prefix compaction already rewrote. An opening turn
  // strips every thinking block before its own message.
  const epochStart = historyStart(turnHistory.messageIds, args.storedCutoff);
  const epoch =
    continuing !== null && continuing.historyStart === epochStart
      ? continuing
      : await step.run("open-system-prompt-epoch", () =>
          openSystemPromptEpoch(deps, {
            ...args.systemPromptArgs,
            openedBy: turn.id,
            historyStart: epochStart,
          }),
        );
  if (epoch.openedBy === turn.id) {
    historyMessages = stripThinkingBefore(historyMessages, turnPosition);
  }

  // Deduplicated after compaction: before it, a memory or an announcement
  // whose only earlier copy compaction then removes would be dropped. An
  // opening turn's snapshot shows core memory as it is, so it announces
  // nothing.
  const earlierInView = historyMessages.toSpliced(turnPosition, 1);
  const announced =
    epoch.openedBy === turn.id
      ? []
      : unannounced(
          args.loadedSystemPrompt.coreMemoryChanges,
          announcedInView(earlierInView, turnHistory),
        );
  const renderedTurnContext = await step.run("render-turn-context", () =>
    storeTurnContext(
      { runInTx: deps.runInTx, agentStore: deps.agentStore },
      {
        messageId: turn.id,
        handledAt: args.handledAt,
        timezone: args.timezone,
        context: {
          recalledMemories: newMemories(
            args.recalledMemories,
            shownMemories(earlierInView, turnHistory),
          ),
          voiceMode: args.voiceMode,
          channelTypes: args.loadedSystemPrompt.channelTypes,
        },
        coreMemoryUpdates: { scope: args.coreMemoryScope, blocks: announced },
      },
    ),
  );

  return {
    systemPrompt: epoch.rendered,
    messages: replaceTurnContext(historyMessages, turnPosition, renderedTurnContext),
  };
}
