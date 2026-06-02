import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useApp } from "../app-context.js";
import { api } from "../orpc.js";
import { createConversation } from "./chat-api.js";
import { Thread } from "./Thread.js";
import { useChat } from "./use-chat.js";

/** `/chat` — resolve the most-recent (or a fresh) conversation and redirect to its URL. */
export function ChatIndex() {
  const { tab } = useApp();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.conversations
      .list()
      .then(async (list) => {
        if (cancelled) return;
        const id = list[0]?.id ?? (await createConversation(tab));
        if (!cancelled) {
          navigate({ to: "/chat/$conversationId", params: { conversationId: id }, replace: true });
        }
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to open a conversation.");
      });
    return () => {
      cancelled = true;
    };
  }, [tab, navigate]);

  return (
    <div className="flex h-full items-center justify-center text-sm text-muted">
      {error ?? "Loading…"}
    </div>
  );
}

/** `/chat/$conversationId` — the streaming chat for one conversation. */
export function ChatSection() {
  const { conversationId } = useParams({ from: "/chat/$conversationId" });
  const { tab } = useApp();
  return <Chat key={conversationId} conversationId={conversationId} tab={tab} />;
}

function Chat({ conversationId, tab }: { conversationId: string; tab: string }) {
  const runtime = useChat(conversationId, tab);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
}
