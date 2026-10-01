import type { Logger } from "pino";
import type { Transactor } from "../../db/index.js";
import { resolveLimits } from "../../llm/models.js";
import { MAX_VIEW_BYTES } from "../../llm/request-size.js";
import type { LlmProviderResolver } from "../../llm/resolver.js";
import type { CountTokensParams, Message, ToolDefinition } from "../../llm/types.js";
import { type DeliveryHandle, pushOrThrow } from "../../transport/delivery-router.js";
import {
  compactMessages,
  extractSummaryText,
  shouldSkipCounting,
  summarizationRequest,
} from "../context.js";
import { summarizedSpan } from "../conversation/load-turn-history.js";
import type { StepRunner } from "../loop.js";
import type { AgentStore } from "../store/index.js";
import { resolveOrFail, type TurnModel } from "./resolve-turn-model.js";

export interface CompactTurnDeps {
  runInTx: Transactor;
  agentStore: Pick<AgentStore, "getLastTokens" | "insertOrRecoverSummary">;
  resolveProvider: LlmProviderResolver;
}

export interface CompactTurnArgs {
  conversationId: string;
  turnModel: TurnModel;
  summarizationModel: string;
  /** The system prompt the view is counted with. */
  system: string;
  messages: ReadonlyArray<Message>;
  toolDefs: ToolDefinition[];
  /** `load-turn-transcript`'s message ids, positionally aligned with `messages`. */
  messageIds: ReadonlyArray<string | null>;
  /** The characters this turn adds that no earlier request's usage counted. */
  newContentChars: number;
  /** The status banner a summarizing turn shows goes here. */
  delivery: DeliveryHandle;
  turnLogger: Logger;
}

export interface CompactedTurn {
  messages: Message[];
  /** The cutoff of the summary this turn stored, which later turns' history starts after. */
  storedCutoff: string | null;
}

/**
 * Context window compaction.
 *
 * `compactMessages` orchestration runs on every invocation — the threshold
 * decisions are pure functions, and the history carries resolved image
 * payloads that must not land in Inngest step state, so the pipeline itself
 * can't be a step. Its expensive or decision-bearing inputs ARE steps:
 * history, auto-recall, the frozen tool table, `load-last-tokens` (freezes the
 * skip decision persist-new-messages would otherwise flip mid-run), each
 * `count-tokens-<n>` round-trip, and the `summarize-prefix-outcome` LLM call.
 * Every replay therefore walks the same decision tree over cached values. See
 * design/crash-recovery.md.
 *
 * Steps, in order: `load-last-tokens`, `count-tokens-<n>` (as compaction
 * counts), `summarize-prefix-outcome` and `persist-summary` (when Strategy 2
 * summarizes).
 */
export async function compactTurn(
  stepRun: StepRunner,
  deps: CompactTurnDeps,
  args: CompactTurnArgs,
): Promise<CompactedTurn> {
  const { turnModel } = args;
  const { budget } = turnModel;

  // Durable: persist-new-messages rewrites the row this reads MID-RUN,
  // so a bare-body read would flip `skipBudgetStrategies` between
  // invocations — and with it the compaction decisions and the
  // existence of the conditional `summarize-prefix-outcome` / `count-tokens-*`
  // steps. Freezing the read pins the whole compaction decision tree
  // for the run.
  const lastTokens = await stepRun("load-last-tokens", () =>
    deps.runInTx((tx) => deps.agentStore.getLastTokens(tx, args.conversationId)),
  );
  // The turn context is new input too: recalled memories are in no earlier
  // request's usage.
  const skipBudgetStrategies = shouldSkipCounting(
    lastTokens?.inputTokens ?? null,
    lastTokens?.outputTokens ?? null,
    args.newContentChars,
    budget,
  );

  const summarizer = prefixSummarizer(stepRun, deps.resolveProvider, args);

  // The skip-counting decision flows in as `skipBudgetStrategies`, which
  // spares compactMessages the provider.countTokens round-trip when budget
  // pressure can't matter; a view past the size trigger compacts anyway.
  const compactResult = await compactMessages(
    args.system,
    args.messages,
    args.toolDefs,
    {
      countTokens: countTokensSteps(stepRun, turnModel),
      budget,
      clearToolResults: turnModel.clearToolResults,
      maxViewBytes: MAX_VIEW_BYTES,
      // Refuse a split that buys nothing durable — the shape where the
      // prefix is the previously-stored summary and nothing else.
      canSummarizePrefix: (candidate) => summarizedSpan(args.messageIds, candidate) !== null,
      summarize: summarizer.summarize,
    },
    skipBudgetStrategies,
  );

  // Persist what Strategy 2 produced so the next turn replays the summary
  // instead of paying for it again. `messagesSummarized` is the split
  // index into the compaction input — nothing before Strategy 2 changes
  // the array, so it indexes `messageIds` directly. It is 0 whenever the
  // strategy no-opped (under budget, or the model returned no text), which
  // is also the guard against storing an empty summary.
  //
  // The compaction view's split index, not the count the row records:
  // `event.messagesSummarized` counts entries, a folded-in previous summary
  // among them, while the column stores `span.messageCount`.
  const splitIdx = compactResult.event?.messagesSummarized ?? 0;
  const span = splitIdx > 0 ? summarizedSpan(args.messageIds, splitIdx) : null;
  const summary = summarizer.outcome();
  const storedCutoff =
    summary !== null && span !== null && !summary.truncated
      ? await persistTurnSummary(stepRun, deps, {
          conversationId: args.conversationId,
          text: summary.text,
          span,
          summarizationModel: args.summarizationModel,
          turnLogger: args.turnLogger,
        })
      : null;

  return { messages: compactResult.messages, storedCutoff };
}

/**
 * Each count is a full-payload POST (system + history + tool schemas +
 * resolved images) — durable so re-invocations replay the integer instead of
 * re-shipping megabytes per boundary. The call sequence is deterministic per
 * run: compaction's inputs are frozen (durable history, auto-recall, the
 * frozen tool table, load-last-tokens), so the counter-keyed ids line up on
 * every replay.
 */
function countTokensSteps(
  stepRun: StepRunner,
  { provider, model }: TurnModel,
): (params: CountTokensParams) => Promise<number> {
  let countCall = 0;
  return (params) => {
    countCall += 1;
    return stepRun(`count-tokens-${countCall}`, () => provider.countTokens({ ...params, model }));
  };
}

interface PrefixSummary {
  text: string;
  /**
   * The summarization response stopped at its output cap. The text is still
   * worth using for this turn, but a summary cut mid-sentence must not become
   * the permanent stand-in for a span whose raw messages later turns no longer
   * load — nothing ever re-derives it.
   */
  truncated: boolean;
}

/**
 * Strategy 2's summarize callback, and what it produced. The outcome is set on
 * every invocation that reaches the strategy — `summarize-prefix-outcome`
 * hands back the memoized text on a replay just as it does on the first pass —
 * so the persist step downstream is planned identically each time.
 */
function prefixSummarizer(
  stepRun: StepRunner,
  resolveProvider: LlmProviderResolver,
  args: Pick<CompactTurnArgs, "turnModel" | "summarizationModel" | "delivery" | "turnLogger">,
): {
  summarize: (system: string, msgs: Message[]) => Promise<string>;
  outcome: () => PrefixSummary | null;
} {
  const { turnModel, summarizationModel, delivery, turnLogger } = args;
  let outcome: PrefixSummary | null = null;
  const summarize = async (system: string, msgs: Message[]): Promise<string> => {
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
      summarizationModel === turnModel.model
        ? null
        : await resolveOrFail(resolveProvider, summarizationModel);
    const summarizationProvider = resolvedSummarization?.provider ?? turnModel.provider;
    const summarizationLimits = resolvedSummarization
      ? resolveLimits(summarizationModel, resolvedSummarization.limits)
      : turnModel.limits;
    // Step ID is hardcoded — relies on `compactMessages` calling
    // `summarize` at most once per invocation (contract on
    // ContextManagerDeps.summarize). If that ever changes, switch to
    // a counter-based ID like `summarize-prefix-${i}` to avoid
    // Inngest's duplicate-step-id error.
    const summarized = await stepRun("summarize-prefix-outcome", async () => {
      // Status banner lives inside the step body so it reaches the
      // user exactly once — compactMessages re-runs on every
      // invocation, and a bare-body push would re-append the banner
      // (or open a stray message on a post-finish replay handle)
      // each time.
      await pushOrThrow(delivery, {
        type: "status",
        message: "Summarizing conversation...",
      });
      const response = await summarizationProvider.chat(
        summarizationRequest({
          model: summarizationModel,
          system,
          messages: msgs,
          maxOutputTokens: summarizationLimits.maxOutputTokens,
          clearToolResults: turnModel.clearToolResults,
        }),
      );
      const text = extractSummaryText(response.content);
      if (response.stopReason === "max_tokens") {
        // Logged from the step body so replay suppresses it. In the
        // bare body this would re-emit once per remaining boundary of
        // the turn, over-reporting by the turn's step count.
        turnLogger.warn(
          { summaryChars: text.length },
          "summarization hit its output cap; using the text for this turn but not storing it",
        );
      }
      return { text, stopReason: response.stopReason };
    });
    outcome = { text: summarized.text, truncated: summarized.stopReason === "max_tokens" };
    return summarized.text;
  };
  return { summarize, outcome: () => outcome };
}

/**
 * Store the turn's summary; returns its cutoff, or null when the write failed.
 *
 * Every input is durable or memoized, so this step is planned the same way on
 * every invocation. The (conversation, cutoff) unique makes the write
 * idempotent under the retry that `durable` alone doesn't prevent — a crash
 * between the commit and Inngest recording the step recovers the existing row
 * rather than appending a second one.
 *
 * Caching a summary is not worth the turn. The write sits between compaction
 * and the agent loop, so an unhandled failure here costs the user their reply
 * over a span that would simply be re-summarized next turn — the same
 * reasoning that has `auto-recall` degrade inside its own step body rather
 * than propagate.
 *
 * Projected down to the id: the full row would push the summary text into
 * Inngest step state a second time, and its `createdAt` would come back from
 * the cache as a string rather than a Date.
 *
 * Caught around the step, not inside it. Inside, `stepRun` never sees the
 * error, so Inngest cannot retry and one connection blip discards a summary
 * already paid for. Out here the step keeps its retry budget and only a
 * permanently-failed one reaches this catch — where degrading is the designed
 * channel.
 *
 * Step: `persist-summary`.
 */
async function persistTurnSummary(
  stepRun: StepRunner,
  deps: Pick<CompactTurnDeps, "runInTx" | "agentStore">,
  args: {
    conversationId: string;
    text: string;
    span: { cutoff: string; messageCount: number };
    summarizationModel: string;
    turnLogger: Logger;
  },
): Promise<string | null> {
  const { span, turnLogger } = args;
  try {
    await stepRun("persist-summary", async () => {
      const { kind, row } = await deps.runInTx((tx) =>
        deps.agentStore.insertOrRecoverSummary(tx, {
          conversationId: args.conversationId,
          summary: args.text,
          throughMessageId: span.cutoff,
          // The real messages replaced, not the compaction-view entries:
          // the column is an audit trail, and counting a folded-in
          // previous summary as content would overstate every
          // re-compaction by one.
          messagesSummarized: span.messageCount,
          model: args.summarizationModel,
          source: "turn",
        }),
      );
      if (kind === "recovered") {
        // A concurrent `/compact` stored this span first and the conflict
        // arm kept its text. This turn answers from the summary it just
        // computed while every later turn replays the other one — the
        // same signal `compactConversation` reports as `nothing_new`,
        // which here is only worth a log.
        turnLogger.info(
          { summaryId: row.id },
          "summary for this span was already stored; keeping the stored text",
        );
      }
      // The id is not read by any caller — it is here to show up in the
      // Inngest run view, where it is the only handle on which row a
      // summarizing turn wrote.
      return { id: row.id };
    });
    return span.cutoff;
  } catch (err) {
    turnLogger.warn({ err }, "failed to persist conversation summary, continuing the turn");
    return null;
  }
}
