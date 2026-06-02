import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";

/** Renders a streamed tool call as a small mono card; results stream in after the call. */
const ToolCall: ToolCallMessagePartComponent = ({ toolName, result, isError }) => {
  return (
    <div
      className={`my-1.5 rounded border bg-sunk px-2.5 py-2 font-mono text-xs ${
        isError ? "border-bad" : "border-line"
      }`}
    >
      <span className="font-semibold text-ink">{toolName}</span>
      {result === undefined ? (
        <span className="ml-2 text-faint">running…</span>
      ) : (
        <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words text-muted">
          {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
};

const bubble =
  "max-w-[min(46rem,85%)] whitespace-pre-wrap break-words rounded-lg px-3.5 py-2.5 leading-relaxed";

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className={`${bubble} bg-accent text-on-accent`}>
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-start">
      <div className={`${bubble} border border-line bg-surface text-ink`}>
        <MessagePrimitive.Parts components={{ tools: { Fallback: ToolCall } }} />
      </div>
    </MessagePrimitive.Root>
  );
}

/** The chat thread: a scrolling message viewport over a composer, in the Ledger palette. */
export function Thread() {
  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
      <ThreadPrimitive.Viewport className="flex flex-1 flex-col gap-3 overflow-y-auto p-6">
        <ThreadPrimitive.Empty>
          <p className="text-sm text-muted">Start the conversation.</p>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
      </ThreadPrimitive.Viewport>
      <ComposerPrimitive.Root className="flex gap-2 border-t border-line bg-sunk px-6 py-3">
        <ComposerPrimitive.Input
          className="max-h-48 min-h-[2.5rem] flex-1 resize-none rounded border border-line bg-bg px-3 py-2 text-sm text-ink outline-none focus:border-accent"
          placeholder="Message Cogmo…"
        />
        <ComposerPrimitive.Send
          type="submit"
          className="self-end rounded bg-accent px-4 py-2 text-sm font-medium text-on-accent"
        >
          Send
        </ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}
