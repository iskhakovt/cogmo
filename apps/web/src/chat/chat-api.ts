/** Create a fresh conversation and return its id (the tab's session is opened by the stream). */
export async function createConversation(tab: string): Promise<string> {
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
