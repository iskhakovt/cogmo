import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";

/** Renders a streamed tool call as a small card; results stream in after the call. */
const ToolCall: ToolCallMessagePartComponent = ({ toolName, result, isError }) => {
  return (
    <div className={`tool-card${isError ? " tool-error" : ""}`}>
      <span className="tool-name">{toolName}</span>
      {result === undefined ? (
        <span className="tool-running">running…</span>
      ) : (
        <pre className="tool-result">
          {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
};

function UserMessage() {
  return (
    <MessagePrimitive.Root className="message user">
      <div className="bubble">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="message assistant">
      <div className="bubble">
        <MessagePrimitive.Parts components={{ tools: { Fallback: ToolCall } }} />
      </div>
    </MessagePrimitive.Root>
  );
}

/** The chat thread: scrolling message viewport + a composer. Minimal styling (Phase 3 brings Ledger). */
export function Thread() {
  return (
    <ThreadPrimitive.Root className="thread">
      <ThreadPrimitive.Viewport className="thread-viewport">
        <ThreadPrimitive.Empty>
          <p className="hint">Start the conversation.</p>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
      </ThreadPrimitive.Viewport>
      <ComposerPrimitive.Root className="composer">
        <ComposerPrimitive.Input className="composer-input" placeholder="Message Cogmo…" />
        <ComposerPrimitive.Send className="composer-send" type="submit">
          Send
        </ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}
