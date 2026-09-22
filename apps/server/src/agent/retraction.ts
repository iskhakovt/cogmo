import type { Logger } from "pino";
import * as R from "remeda";
import { extractText } from "../llm/content.js";
import type { Message } from "../llm/types.js";

/**
 * What the streaming adapters were shown during one turn. Sourced from
 * `AgentLoopResult.streamed`, which the loop derives from its durable
 * iteration outcomes — identical on every Inngest re-invocation, unlike a
 * ledger of this invocation's live emissions (empty when the iterations
 * replay from the step cache).
 */
export interface StreamedOutput {
  /** Every `text_delta` forwarded this turn, concatenated in order. */
  text: string;
  /** Every `tool_start` id forwarded this turn, in order. */
  toolUseIds: ReadonlyArray<string>;
}

/** The payload of a `retract` stream event. */
export interface Retraction {
  text: string;
  toolUseIds: ReadonlyArray<string>;
}

/**
 * Work out what a degraded turn has to take back off the user's screen.
 *
 * The orchestrator driving the loop — `handle-message` or a pipeline stage —
 * is the only component that sees both sides: `streamed` is what the adapters
 * were told during the turn, `newMessages` is what the persist step is about to
 * write. The difference is the degrade-triggering iteration's output — the
 * loop drops that iteration, so the user must not be left reading it.
 * Everything else streamed this turn is persisted and stays exactly where it
 * is.
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
export function computeRetraction(
  streamed: StreamedOutput,
  newMessages: ReadonlyArray<Message>,
  log: Logger,
): Retraction | null {
  const persistedText = R.pipe(
    newMessages,
    R.filter((m) => m.role === "assistant"),
    R.map((m) => extractText(m.content)),
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
