/**
 * One turn as the Observer reads it: the rows sharing a cursor, rendered for
 * the extraction prompt, the user's own text in it, and the exchange before
 * it as context (design/observation.md → Rendering a turn, Slice 1a).
 */

import * as R from "remeda";
import { isTurnRowContent } from "../../../llm/content.js";
import type { TextBlock } from "../../../llm/types.js";
import type { TurnMessage } from "../../store/index.js";
import type { StoredContent } from "../../stored-content.js";
import { formatTranscript } from "../extract-corrections.js";

/** The most characters of one earlier message the context keeps, head and tail. */
const CONTEXT_MESSAGE_CHARS = 1500;

export interface RenderedTurn {
  /** The turn row, its tool rounds and its replies, as the extraction reads them. */
  transcript: string;
  /**
   * What the user wrote or said in the turn, forwarded text left out: where
   * a correction's evidence must appear. Empty when the turn row holds no
   * text (an image alone).
   */
  userText: string;
}

/**
 * The rows of the turn `cursor` names, with every turn row but the newest
 * dropped: an insert re-run after its commit leaves an earlier duplicate.
 */
function turnRows(rows: ReadonlyArray<TurnMessage>, cursor: string): ReadonlyArray<TurnMessage> {
  const own = rows.filter((r) => r.cursor === cursor);
  const newestTurnRow = R.findLast(own, isTurnRow);
  return own.filter((r) => !isTurnRow(r) || r === newestTurnRow);
}

function isTurnRow(row: TurnMessage): boolean {
  return row.role === "user" && isTurnRowContent(row.content);
}

export function renderTurn(rows: ReadonlyArray<TurnMessage>, cursor: string): RenderedTurn {
  const own = turnRows(rows, cursor);
  const turnRow = own.find(isTurnRow);
  return {
    transcript: formatTranscript(own),
    userText: turnRow === undefined ? "" : userTextOf(turnRow.content),
  };
}

/**
 * The turn before the observed one, as context: its user text and its final
 * reply, each capped to its head and tail. Tool rounds are left out.
 */
export function renderContext(rows: ReadonlyArray<TurnMessage>, cursor: string): string {
  const own = turnRows(rows, cursor);
  const turnRow = own.find(isTurnRow);
  const finalReply = R.findLast(own, (r) => r.role === "assistant" && textOf(r.content) !== "");
  return R.pipe(
    [turnRow, finalReply],
    R.filter(R.isNonNullish),
    R.map((r) => capped(formatTranscript([{ role: r.role, content: textOnly(r.content) }]))),
    R.filter((line) => line.length > 0),
  ).join("\n\n");
}

/** Text blocks only, so the context carries what was said and nothing it called. */
function textOnly(content: StoredContent): StoredContent {
  return typeof content === "string" ? content : content.filter((b) => b.type === "text");
}

function textOf(content: StoredContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextBlock => b.type === "text" && b.harness === undefined)
    .map((b) => b.text)
    .join("\n");
}

const FORWARDED_MESSAGE = /<forwarded_message[^>]*>[\s\S]*?<\/forwarded_message>/g;

/** A turn row's own text: untagged text blocks, forwarded elements removed. */
function userTextOf(content: StoredContent): string {
  return textOf(content).replace(FORWARDED_MESSAGE, " ").trim();
}

function capped(text: string): string {
  if (text.length <= CONTEXT_MESSAGE_CHARS) return text;
  const half = Math.floor(CONTEXT_MESSAGE_CHARS / 2);
  const cut = text.length - 2 * half;
  return `${text.slice(0, half)}\n[… ${cut} characters truncated]\n${text.slice(-half)}`;
}

/**
 * Whether `evidence` quotes `userText`, after folding case, whitespace and
 * curly quotes, and trimming quote marks and ellipses around the quote. An
 * empty quote quotes nothing.
 */
export function quotesUser(evidence: string, userText: string): boolean {
  const quote = normalized(evidence)
    .replace(/^["'\s.…]+|["'\s.…]+$/g, "")
    .trim();
  return quote.length > 0 && normalized(userText).includes(quote);
}

function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
