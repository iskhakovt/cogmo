import type { Logger } from "pino";
import { match, P } from "ts-pattern";
import type { Durable } from "../../inngest/durable.js";
import type { Message } from "../../llm/types.js";
import { promptPrefixViolations } from "../../metrics.js";
import type { LoadedSystemPrompt } from "../conversation/load-system-prompt.js";
import { openSystemPromptEpoch } from "../conversation/open-system-prompt-epoch.js";
import type { SystemPromptDeps } from "../conversation/render-system-prompt.js";
import { storeTurnContext } from "../conversation/store-turn-context.js";
import type { CoreMemoryScope } from "../core-memory/scope.js";
import {
  type EpochSnapshot,
  epochReason,
  historyStart,
  stripThinkingBefore,
  unannounced,
} from "../system-prompt-snapshot.js";
import type { HeadVerdict } from "../transcript-head.js";
import {
  announcedInView,
  findTurnContext,
  newMemories,
  replaceTurnContext,
  shownMemories,
} from "../turn-context.js";
import type { TurnSystemPromptArgs } from "./freeze-turn-inputs.js";
import type { TurnTranscript } from "./load-turn-transcript.js";
import type { TurnView } from "./render-turn-view.js";

export interface FinalizeTurnContextArgs {
  /** The compacted history, the turn's message led by its provisional turn context. */
  messages: Message[];
  provisionalTurnContext: string;
  transcript: TurnTranscript;
  /** The history as sent, and the attachment cutoff an epoch the turn opens stores. */
  view: TurnView;
  /** The conversation's epoch, when the turn continued it before compaction. */
  continuing: EpochSnapshot | null;
  /** The cutoff of the summary compaction stored, if it stored one. */
  storedCutoff: string | null;
  /** Whether compaction rewrote the view without storing a summary. */
  rewroteView: boolean;
  loadedSystemPrompt: LoadedSystemPrompt;
  /** The across-turn head check's verdict on the loaded history. */
  head: HeadVerdict;
  systemPromptArgs: TurnSystemPromptArgs;
  recalledMemories: ReadonlyArray<string>;
  handledAt: Date;
  voiceMode: boolean;
  coreMemoryScope: CoreMemoryScope;
  timezone: string;
  turnLogger: Logger;
}

export interface FinalizedTurnContext {
  /** The epoch's system prompt, which the loop sends. */
  systemPrompt: string;
  /** The history the loop sends, the turn's message led by its stored turn context. */
  messages: Message[];
}

/**
 * Settle the epoch the turn sends and its stored turn context, over the
 * compacted view. An epoch opened on a violated head check counts
 * `cogmo.prompt.prefix_violations{site: "turn"}` and warns, once: only the
 * attempt whose insert stored the snapshot does.
 *
 * Steps, in order: `open-system-prompt-epoch` (unless the turn continues its
 * epoch), `render-turn-context`.
 */
export async function finalizeTurnContext(
  step: Durable,
  deps: SystemPromptDeps,
  args: FinalizeTurnContextArgs,
): Promise<FinalizedTurnContext> {
  const { transcript, continuing } = args;
  const { history: turnHistory, turn } = transcript;
  const turnPosition = findTurnContext(args.messages, args.provisionalTurnContext);
  if (turnPosition === -1) throw new Error("compaction dropped the turn's own message");

  // A summary this turn stored moves the history's start, and a view
  // compaction rewrote without one is no longer the rows' render, so either
  // way the turn opens an epoch on the prefix compaction already rewrote. An
  // opening turn strips every thinking block before its own message.
  const epochStart = historyStart(turnHistory.messageIds, args.storedCutoff);
  const epoch =
    continuing !== null && continuing.historyStart === epochStart && !args.rewroteView
      ? continuing
      : await step.run("open-system-prompt-epoch", async () => {
          const opened = await openSystemPromptEpoch(deps, {
            ...args.systemPromptArgs,
            openedBy: turn.id,
            historyStart: epochStart,
            attachmentCutoff: args.view.cutoff.cutoff,
            reason: epochReason(args.loadedSystemPrompt.snapshot, {
              configDigest: args.loadedSystemPrompt.configDigest,
              loadedStart: historyStart(turnHistory.messageIds, null),
              epochStart,
              compacted: args.rewroteView,
              cutoff: args.view.cutoff,
              head: args.head,
            }),
          });
          reportViolation(opened.kind, args.head, args.turnLogger);
          return opened.epoch;
        });
  const opensEpoch = epoch.openedBy === turn.id;
  const historyMessages = opensEpoch
    ? stripThinkingBefore(args.messages, turnPosition)
    : args.messages;

  // Deduplicated after compaction: before it, a memory whose only earlier
  // copy compaction then removes would be dropped. An opening turn's snapshot
  // shows core memory as it is, so it announces nothing.
  const earlierInView = historyMessages.toSpliced(turnPosition, 1);
  const sentHistory = {
    messages: args.view.messages,
    turnContexts: turnHistory.turnContexts,
  };
  const announced = opensEpoch
    ? []
    : unannounced(
        args.loadedSystemPrompt.coreMemoryChanges,
        announcedInView(earlierInView, sentHistory),
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
            shownMemories(earlierInView, sentHistory),
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

/**
 * Count and log a violated head check when this attempt stored the epoch; a
 * recovered snapshot was reported by the attempt that stored it, and any other
 * verdict reports nothing.
 */
function reportViolation(opened: "new" | "recovered", head: HeadVerdict, turnLogger: Logger): void {
  match({ opened, head })
    .with({ opened: "new", head: { kind: "violated" } }, ({ head: { firstDiverging } }) => {
      promptPrefixViolations.add(1, { site: "turn" });
      turnLogger.warn(
        { site: "turn", firstDivergingMessageId: firstDiverging },
        "the turn's history no longer has a stored transcript head; opened an epoch",
      );
    })
    .with(
      { opened: "recovered" },
      { head: { kind: P.union("skipped", "matched", "explained") } },
      () => undefined,
    )
    .exhaustive();
}
