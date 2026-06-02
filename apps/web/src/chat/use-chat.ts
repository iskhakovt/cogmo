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
  // Whether any local message (a user send or a streamed turn) has landed since
  // open. Once true, a late history fetch must not replace the in-memory state.
  const touched = useRef(false);

  useEffect(() => {
    let cancelled = false;
    streamingId.current = null;
    touched.current = false;
    setIsRunning(false);
    setMessages([]);

    void api.conversations
      .getMessages({ conversationId })
      .then((history) => {
        // Only seed history if nothing local has happened yet. A late fetch must
        // not clobber an optimistic user send or an already-streaming turn —
        // neither is in `history` yet, so a replace would drop them. Side effect
        // (Phase 2b): on a mid-stream refresh an early delta also suppresses the
        // *prior* history for this session (it returns on the next reload). Since
        // history ids (DB UUID) and live ids (localId) are disjoint, 2b can
        // prepend history instead of suppressing it.
        if (!cancelled && !touched.current) {
          setMessages(history.map(historyToUi));
        }
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      });

    const onStreamEvent = (event: StreamEvent): void => {
      touched.current = true;
      const current = streamingId.current;
      if (current === null) {
        const id = localId("a");
        streamingId.current = id;
        setMessages((prev) => [
          ...prev,
          applyStreamEvent({ id, role: "assistant", text: "", tools: [] }, event),
        ]);
      } else {
        // O(n) array rebuild per delta — fine at proof scale (assistant-ui only
        // re-converts the changed message). Track the in-flight message apart
        // from the settled list if long turns make the allocation churn matter.
        setMessages((prev) => prev.map((m) => (m.id === current ? applyStreamEvent(m, event) : m)));
      }
    };

    const es = createEventSource({
      url: `/api/chat/${conversationId}/stream?tab=${encodeURIComponent(tab)}`,
      fetch: credentialed,
      onMessage: (msg) => {
        if (msg.event === "ready") return;
        if (msg.event === "turn-end") {
          streamingId.current = null;
          setIsRunning(false);
          return;
        }
        // Every other frame carries JSON. The server only emits valid frames, so
        // a parse failure is defensive-only — skip the bad frame rather than let
        // it throw inside the reader and wedge the stream.
        let data: unknown;
        try {
          data = JSON.parse(msg.data);
        } catch {
          return;
        }
        if (msg.event === "turn-abort") {
          const { message } = data as { message: string };
          const id = streamingId.current;
          if (id) {
            setMessages((prev) =>
              prev.map((m) => (m.id === id ? { ...m, text: `${m.text}\n\n⚠️ ${message}` } : m)),
            );
          } else {
            // Aborted before any delta — no in-flight message to annotate, so
            // surface a fresh one rather than clearing the spinner silently.
            touched.current = true;
            setMessages((prev) => [
              ...prev,
              { id: localId("a"), role: "assistant", text: `⚠️ ${message}`, tools: [] },
            ]);
          }
          streamingId.current = null;
          setIsRunning(false);
          return;
        }
        onStreamEvent(data as StreamEvent);
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
      touched.current = true;
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
