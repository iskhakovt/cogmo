import * as R from "remeda";
import { match } from "ts-pattern";
import type { Message, ToolDefinition } from "../../llm/types.js";
import type { AttachmentReader } from "../attachments/attachment-reader.js";
import { renderStoredMessages } from "../attachments/render-stored-content.js";
import type { TurnHistory } from "../conversation/load-turn-history.js";
import { validateHistory } from "../history-invariants.js";
import {
  type EpochSnapshot,
  historyStart,
  stripThinkingBefore,
} from "../system-prompt-snapshot.js";
import {
  baseDigest,
  type HeadExplanation,
  type HeadVerdict,
  PrefixViolationError,
  type PrefixViolationPolicy,
  TranscriptHasher,
  type TranscriptHead,
} from "../transcript-head.js";
import type { TurnTranscript } from "./load-turn-transcript.js";
import type { TurnView } from "./render-turn-view.js";

export interface CheckTurnHeadArgs {
  transcript: TurnTranscript;
  /** The turn's rendered view: its rows as sent, when its cutoff is the epoch's. */
  view: TurnView;
  /** The conversation's epoch, as `load-system-prompt` returned it; null before its first. */
  snapshot: EpochSnapshot | null;
  /** The frozen tool definitions every request of the turn sends. */
  toolDefs: ReadonlyArray<ToolDefinition>;
  policy: PrefixViolationPolicy;
}

/** An assistant row of the current epoch and the head it stored. */
interface HeadedRow {
  id: string;
  head: TranscriptHead;
}

/**
 * The across-turn head check (design/prompt-caching.md → Head check): whether
 * the history the turn loaded, before its own compaction and rendered as the
 * current epoch sends it, still has the head the epoch's latest headed
 * assistant row stored. The render is the epoch's: its snapshot's attachment
 * cutoff, the thinking strip before its opening row, and the loop's history
 * sanitization, chained from h₀ over the snapshot and the frozen tools.
 *
 * Only rows after the epoch's opening row are compared: those before it were
 * sent under an earlier epoch's render state, which the opening turn rewrote.
 * An opening row missing from the history belongs to an epoch that opened
 * after the turn loaded it, so no row is compared.
 *
 * Under `throw`, a `violated` verdict throws {@link PrefixViolationError}.
 *
 * Bare body, on every invocation. Its inputs are memoized, or the view
 * rendered from them — `load-turn-transcript`'s rows and heads,
 * `load-system-prompt`'s snapshot and the frozen tool table — so every
 * invocation reaches the same verdict; the
 * render and the hash re-run each time. `open-system-prompt-epoch` counts and
 * logs a violation.
 */
export async function checkTurnHead(
  deps: { attachmentReader: AttachmentReader },
  args: CheckTurnHeadArgs,
): Promise<HeadVerdict> {
  const verdict = await turnHeadVerdict(deps, args);
  return match(verdict)
    .returnType<HeadVerdict>()
    .with({ kind: "violated" }, (violated) =>
      match(args.policy)
        .returnType<HeadVerdict>()
        .with("reopen", () => violated)
        .with("throw", () => {
          throw new PrefixViolationError(
            `the turn's history no longer has the transcript head stored on assistant row ${violated.firstDiverging}`,
          );
        })
        .exhaustive(),
    )
    .with({ kind: "skipped" }, { kind: "matched" }, { kind: "explained" }, (other) => other)
    .exhaustive();
}

async function turnHeadVerdict(
  deps: { attachmentReader: AttachmentReader },
  args: CheckTurnHeadArgs,
): Promise<HeadVerdict> {
  const { snapshot } = args;
  const { history } = args.transcript;
  if (snapshot === null || history.heads === undefined) return { kind: "skipped" };
  const openerIndex = history.messageIds.indexOf(snapshot.openedBy);
  const headed = epochRows(history.messageIds, history.heads, openerIndex);
  const latest = headed.at(-1);
  if (latest === undefined) return { kind: "skipped" };

  const base = baseDigest(snapshot.rendered, args.toolDefs);
  const start = historyStart(history.messageIds, null);
  const reason = explanation(latest.head, base, start);
  if (reason !== null) return { kind: "explained", reason };

  const sent = await renderAsSent(deps, args.view, history, snapshot, openerIndex);
  const chain = chainDigests(base, sent, latest.head.length);
  const holds = (head: TranscriptHead): boolean => chain[head.length] === head.digest;
  if (holds(latest.head)) return { kind: "matched" };
  // `latest` is comparable and doesn't hold, so the search always finds a row.
  const first =
    headed.find(({ head }) => explanation(head, base, start) === null && !holds(head)) ?? latest;
  return { kind: "violated", firstDiverging: first.id };
}

/** The headed rows after the epoch's opening row at `openerIndex`; none when it is missing (-1). */
function epochRows(
  messageIds: ReadonlyArray<string | null>,
  heads: ReadonlyArray<TranscriptHead | null>,
  openerIndex: number,
): HeadedRow[] {
  if (openerIndex === -1) return [];
  return heads.flatMap((head, i) => {
    const id = messageIds[i];
    return i > openerIndex && R.isNonNullish(head) && R.isNonNullish(id) ? [{ id, head }] : [];
  });
}

/**
 * Why `head` can't be compared with the turn's history, in the epoch rule's
 * precedence; null when its `base` and `historyStart` are the turn's and its
 * status is `intact`.
 */
function explanation(head: TranscriptHead, base: string, start: string): HeadExplanation | null {
  if (head.base !== base) return "configuration";
  if (head.historyStart !== start) return "summary";
  return match(head.status)
    .returnType<HeadExplanation | null>()
    .with("intact", () => null)
    .with("compacted", () => "compaction")
    .with("diverged", () => "prefix_violation")
    .exhaustive();
}

/**
 * The chain's digest at every position up to `through` over `messages`, from
 * `base` at position 0; shorter when `messages` runs out first.
 */
function chainDigests(base: string, messages: ReadonlyArray<Message>, through: number): string[] {
  const hasher = new TranscriptHasher();
  const end = Math.min(through, messages.length);
  return messages.slice(0, end).reduce<string[]>(
    (chain, message, i) => {
      const previous = chain.at(-1) ?? base;
      chain.push(hasher.extend({ length: i, digest: previous }, [message], 0).digest);
      return chain;
    },
    [base],
  );
}

/**
 * The loaded history as the epoch's requests send it, before the turn's own
 * compaction. The turn's view already renders it under the epoch's cutoff
 * when the turn kept that cutoff; an advanced one is rendered again.
 */
async function renderAsSent(
  deps: { attachmentReader: AttachmentReader },
  view: TurnView,
  history: TurnHistory,
  snapshot: EpochSnapshot,
  openerIndex: number,
): Promise<Message[]> {
  const rendered = await match(view.cutoff)
    .with({ kind: "kept" }, () => Promise.resolve(view.messages))
    .with({ kind: "advanced" }, () =>
      renderStoredMessages(
        history.messages,
        history.messageIds,
        deps.attachmentReader,
        snapshot.attachmentCutoff ?? null,
      ),
    )
    .exhaustive();
  return validateHistory(stripThinkingBefore(rendered, openerIndex)).messages;
}
