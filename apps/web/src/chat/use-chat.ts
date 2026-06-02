import { type AppendMessage, useExternalStoreRuntime } from "@assistant-ui/react";
import type { StreamEvent } from "@cogmo/contracts";
import { createEventSource } from "eventsource-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../orpc.js";
import { applyStreamEvent, convertMessage, historyToUi, type UiMessage } from "./convert.js";

let seq = 0;
function localId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

const credentialed = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
  fetch(input, { ...init, credentials: "include" });

/**
 * Chat runtime for one conversation over the web SSE + inbound routes. Maintains
 * the message list, loads history on open, streams the assistant turn from the
 * SSE connection, and posts user turns. The SSE owns the assistant message
 * lifecycle (create on the first event of a turn, finalize on `turn-end`);
 * `onNew` only appends the user turn and sends it.
 */
export function useChat(conversationId: string, tab: string) {
  const [messages, setMessages] = useState<readonly UiMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  // Id of the assistant message currently being streamed (null between turns).
  const streamingId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    streamingId.current = null;
    setIsRunning(false);
    setMessages([]);

    void api.conversations
      .getMessages({ conversationId })
      .then((history) => {
        // Don't clobber a turn already streaming: if a live event beat the
        // history fetch (an in-flight turn on open), it set `streamingId`, so
        // skip the replace and let the live message stand.
        if (!cancelled && streamingId.current === null) {
          setMessages(history.map(historyToUi));
        }
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      });

    const onStreamEvent = (event: StreamEvent): void => {
      const current = streamingId.current;
      if (current === null) {
        const id = localId("a");
        streamingId.current = id;
        setMessages((prev) => [
          ...prev,
          applyStreamEvent({ id, role: "assistant", text: "", tools: [] }, event),
        ]);
      } else {
        setMessages((prev) => prev.map((m) => (m.id === current ? applyStreamEvent(m, event) : m)));
      }
    };

    const es = createEventSource({
      url: `/api/chat/${conversationId}/stream?tab=${encodeURIComponent(tab)}`,
      fetch: credentialed,
      onMessage: (msg) => {
        switch (msg.event) {
          case "ready":
            return;
          case "turn-end":
            streamingId.current = null;
            setIsRunning(false);
            return;
          case "turn-abort": {
            const id = streamingId.current;
            const { message } = JSON.parse(msg.data) as { message: string };
            if (id) {
              setMessages((prev) =>
                prev.map((m) => (m.id === id ? { ...m, text: `${m.text}\n\n⚠️ ${message}` } : m)),
              );
            }
            streamingId.current = null;
            setIsRunning(false);
            return;
          }
          default:
            onStreamEvent(JSON.parse(msg.data) as StreamEvent);
        }
      },
    });
    return () => {
      cancelled = true;
      es.close();
    };
  }, [conversationId, tab]);

  const onNew = useCallback(
    async (message: AppendMessage): Promise<void> => {
      const text = message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("")
        .trim();
      if (text.length === 0) return;
      setMessages((prev) => [...prev, { id: localId("u"), role: "user", text, tools: [] }]);
      setIsRunning(true);
      try {
        const res = await credentialed(
          `/api/chat/${conversationId}?tab=${encodeURIComponent(tab)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
          },
        );
        if (!res.ok) throw new Error(`send failed (${res.status})`);
        // On success the turn streams back over the SSE, which clears isRunning
        // at `turn-end`. On failure no events arrive, so clear it here and
        // surface the error instead of leaving the UI stuck "thinking".
      } catch {
        setIsRunning(false);
        setMessages((prev) => [
          ...prev,
          { id: localId("a"), role: "assistant", text: "⚠️ Couldn't send your message.", tools: [] },
        ]);
      }
    },
    [conversationId, tab],
  );

  return useExternalStoreRuntime({ messages, isRunning, onNew, convertMessage });
}
