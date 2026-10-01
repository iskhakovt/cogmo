import { type InboundContent, renderInboundText } from "../../transport/content.js";
import type { InboundMessageSource } from "../../transport/store/schema.js";

/** One row of the turn's inbound batch, as `load-inbound` returns it. */
export interface InboundRow {
  id: string;
  content: InboundContent;
  source: InboundMessageSource;
}

/** An inbound row's content after voice transcription. */
export interface SubstitutedInbound {
  content: InboundContent;
}

/**
 * The batch's cursors. `maxInboundId` is the last inbound the turn consumes:
 * the cursor its rows are written with. `firstInboundId` is the low-water
 * mark, the turn token: it doesn't move when a re-delivered turn reloads a
 * batch that has grown, since the batch always starts after the last message
 * the previous assistant turn consumed, so its first id is the same on every
 * delivery of the same logical turn. `triggerInboundId` is not — Inngest hands
 * debounce the LAST event of a burst, so another message arriving before the
 * turn succeeds re-fires it with a different trigger over a grown batch.
 *
 * Both are empty only for an empty batch, which admission never lets through.
 */
export function batchCursors(inboundMessages: ReadonlyArray<InboundRow>): {
  maxInboundId: string;
  firstInboundId: string;
} {
  return {
    maxInboundId: inboundMessages.at(-1)?.id ?? "",
    firstInboundId: inboundMessages[0]?.id ?? "",
  };
}

/**
 * How the turn's reply is routed. A batch is either all-user or
 * all-scheduled — never mixed. The debounce stages user inbounds; scheduled
 * fires emit their own `inbound/arrived` independently after persisting a
 * single synthetic row, so the two paths can't legitimately interleave into
 * one turn. A mixed batch would mean a fire landed in a user-batched turn (or
 * vice versa) and the routing kind would silently pick the wrong path — fail
 * fast instead. Scheduled inbounds have no originating session for source
 * routing, so they broadcast to every reachable session.
 */
export function routingKindOf(
  conversationId: string,
  inboundMessages: ReadonlyArray<InboundRow>,
): "reply" | "broadcast" {
  const scheduledCount = inboundMessages.filter((m) => m.source === "scheduled").length;
  if (scheduledCount > 0 && scheduledCount !== inboundMessages.length) {
    throw new Error(
      `mixed-source inbound batch in conversation ${conversationId}: ${scheduledCount}/${inboundMessages.length} scheduled`,
    );
  }
  return scheduledCount > 0 ? "broadcast" : "reply";
}

/**
 * Each inbound row after voice transcription: every consumer downstream
 * derives from this. A forwarded clip's transcript keeps the clip's
 * `forwarded` marking, as forwarded text does; `renderUserContent` and the
 * attachment resolution render it into its `<forwarded_message>` element, and
 * the recall query reads the bare text. The cursor walks `transcripts` in the
 * order they were produced: voice blocks, in inbound order.
 */
export function substituteTranscripts(
  inboundMessages: ReadonlyArray<InboundRow>,
  transcripts: ReadonlyArray<string>,
): ReadonlyArray<SubstitutedInbound> {
  let cursor = 0;
  return inboundMessages.map((m) => {
    if (typeof m.content === "string") return { content: m.content };
    const blocks = m.content.map((b) => {
      if (b.type !== "voice") return b;
      const text = transcripts[cursor++] ?? "";
      return {
        type: "text",
        text,
        ...(b.forwarded !== undefined && { forwarded: b.forwarded }),
      } as const;
    });
    return { content: blocks };
  });
}

/**
 * Per-row text serialization for `messages.content`, forwarded text inside its
 * element. After voice→text substitution, a text-only row joins on newline,
 * so it loads back cleanly as history; a row that still carries image or
 * document blocks is JSON-stringified.
 */
export function renderUserContent(substitutedMessages: ReadonlyArray<SubstitutedInbound>): string {
  return substitutedMessages
    .map(({ content }) => {
      if (typeof content === "string") return content;
      const rendered = content.map((b) =>
        b.type === "text"
          ? ({ type: "text", text: renderInboundText(b.text, b.forwarded) } as const)
          : b,
      );
      if (rendered.every((b) => b.type === "text")) {
        return rendered.map((b) => b.text).join("\n");
      }
      return JSON.stringify(rendered);
    })
    .join("\n");
}
