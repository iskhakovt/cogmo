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
