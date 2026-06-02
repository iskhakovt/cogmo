import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../orpc.js";
import { Thread } from "./Thread.js";
import { useChat } from "./use-chat.js";

/** Create a fresh conversation and return its id (the tab's session is opened by the stream). */
async function createConversation(tab: string): Promise<string> {
  const res = await fetch(`/api/chat?tab=${encodeURIComponent(tab)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: "{}",
  });
  if (!res.ok) throw new Error(`Couldn't start a conversation (${res.status}).`);
  const { conversationId } = (await res.json()) as { conversationId: string };
  return conversationId;
}

function Chat({ conversationId, tab }: { conversationId: string; tab: string }) {
  const runtime = useChat(conversationId, tab);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
}

/**
 * The post-login chat screen — opens the most recent conversation (or creates
 * one) and streams it. No sidebar/switcher yet; that's the Phase 3 app shell.
 */
export function ChatView({ onLogout }: { onLogout: () => Promise<void> }) {
  // Per-tab id: the channel session's address + the SSE registry key. Minted once.
  const tab = useRef(crypto.randomUUID()).current;
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.conversations
      .list()
      .then(async (list) => {
        const id = list[0]?.id ?? (await createConversation(tab));
        if (!cancelled) setConversationId(id);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load conversations.");
      });
    return () => {
      cancelled = true;
    };
  }, [tab]);

  async function newChat(): Promise<void> {
    setError(null);
    try {
      setConversationId(await createConversation(tab));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start a conversation.");
    }
  }

  return (
    <div className="chat-view">
      <header className="chat-header">
        <h1>Cogmo</h1>
        <div className="chat-actions">
          <button type="button" onClick={() => void newChat()}>
            New chat
          </button>
          <button type="button" onClick={() => void onLogout()}>
            Log out
          </button>
        </div>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {conversationId ? (
        <Chat key={conversationId} conversationId={conversationId} tab={tab} />
      ) : (
        <p className="hint">Loading…</p>
      )}
    </div>
  );
}
