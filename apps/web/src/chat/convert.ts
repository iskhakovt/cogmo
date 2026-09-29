import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ChatHistoryMessage, StreamEvent } from "@cogmo/contracts";

/** A tool call accumulated from `tool_start` (+ a later `tool_result`) during a turn. */
export interface UiToolCall {
  id: string;
  name: string;
  args: unknown;
  result?: string | undefined;
  isError?: boolean | undefined;
}

/** The SPA's own message model — fed to assistant-ui via `convertMessage`. */
export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: UiToolCall[];
}

/**
 * A run of a user message's text: the user's own, or a message they forwarded.
 * `at` is where the run starts in the text, a stable key.
 */
export type UserTextSegment =
  | { kind: "text"; text: string; at: number }
  | { kind: "forwarded"; from: string; body: string; at: number };

/**
 * The exact element the server wraps forwarded text in: attribute values with
 * `& " < >` as entities, and the body on its own lines unless it's empty.
 */
const FORWARDED_MESSAGE =
  /<forwarded_message from="([^"<>]*)" origin="(?:user|hidden_user|chat|channel)" sent="[^"<>]*">(?:\n([\s\S]*?)\n)?<\/forwarded_message>/g;

/**
 * A user message's text split around its forwarded messages, so each renders
 * as a quote naming its sender. Anything but the exact element stays text.
 */
export function splitForwarded(text: string): UserTextSegment[] {
  const segments: UserTextSegment[] = [];
  let at = 0;
  for (const match of text.matchAll(FORWARDED_MESSAGE)) {
    segments.push(...ownText(text.slice(at, match.index), at));
    segments.push({
      kind: "forwarded",
      from: decodeEntities(match[1] ?? ""),
      body: decodeForwardedTags(match[2] ?? ""),
      at: match.index,
    });
    at = match.index + match[0].length;
  }
  if (segments.length === 0) return [{ kind: "text", text, at: 0 }];
  return [...segments, ...ownText(text.slice(at), at)];
}

/** Text beside a forwarded message, without the line breaks that separate it from the quote. */
function ownText(slice: string, at: number): UserTextSegment[] {
  const text = slice.replace(/^\n+|\n+$/g, "");
  return text === "" ? [] : [{ kind: "text", text, at }];
}

/** A body with the `forwarded_message` tags the server escaped as `&lt;` shown as written. */
function decodeForwardedTags(body: string): string {
  return body.replace(/&lt;(?=[\s\\/]*forwarded_message)/gi, "<");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Map a persisted history turn into the live message model (text only — no tool history). */
export function historyToUi(message: ChatHistoryMessage): UiMessage {
  return { id: message.id, role: message.role, text: message.text, tools: [] };
}

/**
 * Fold one streamed event into the in-flight assistant message. `tool_result`
 * carries the tool *name*, not its id, so it pairs to the most recent
 * still-pending tool of that name (the agent runs tools sequentially per turn).
 * `thinking_delta` and `status` aren't rendered in this proof.
 */
export function applyStreamEvent(message: UiMessage, event: StreamEvent): UiMessage {
  switch (event.type) {
    case "text_delta":
      return { ...message, text: message.text + event.text };
    case "tool_start":
      return {
        ...message,
        tools: [...message.tools, { id: event.id, name: event.name, args: event.input }],
      };
    case "retract": {
      // The event names the streamed output the turn won't persist — the
      // degrade-triggering iteration's text (always the tail of what streamed)
      // and its tool calls, which on a context-overflow degrade never ran.
      // Whatever it doesn't name came from an iteration that completed and is
      // in the persisted transcript, so it stays on screen.
      const text = message.text.endsWith(event.text)
        ? message.text.slice(0, message.text.length - event.text.length)
        : message.text;
      const retracted = new Set(event.toolUseIds);
      return { ...message, text, tools: message.tools.filter((t) => !retracted.has(t.id)) };
    }
    case "tool_result": {
      const tools = [...message.tools];
      for (let i = tools.length - 1; i >= 0; i--) {
        const tool = tools[i];
        if (tool && tool.name === event.name && tool.result === undefined) {
          tools[i] = { ...tool, result: event.output, isError: event.isError };
          break;
        }
      }
      return { ...message, tools };
    }
    default:
      return message;
  }
}

/** Convert the SPA model into the shape assistant-ui renders. */
export function convertMessage(message: UiMessage): ThreadMessageLike {
  const content: ThreadMessageLike["content"] = [
    ...(message.text.length > 0 ? [{ type: "text" as const, text: message.text }] : []),
    ...message.tools.map((tool) => ({
      type: "tool-call" as const,
      toolCallId: tool.id,
      toolName: tool.name,
      argsText: JSON.stringify(tool.args),
      ...(tool.result !== undefined && { result: tool.result }),
      ...(tool.isError !== undefined && { isError: tool.isError }),
    })),
  ];
  return {
    id: message.id,
    role: message.role,
    // assistant-ui rejects an empty content array — keep an empty text placeholder.
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
  };
}
