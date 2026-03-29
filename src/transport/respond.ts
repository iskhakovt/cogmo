import type { AgentStore } from "../agent/store/index.js";
import { inngest } from "../inngest/client.js";
import { responseReady } from "../inngest/events.js";
import { contentToText } from "./content.js";
import type { TransportStore } from "./store/index.js";

/**
 * Create a respond function for a channel.
 *
 * Listens for response/ready, loads the message, finds active sessions
 * for the channel, and delivers via the provided deliver function.
 * Shared logic — each channel only provides its delivery mechanism.
 */
export function createRespond(opts: {
  id: string;
  channelId: string;
  agentStore: AgentStore;
  transportStore: TransportStore;
  deliver: (platformAddress: string, text: string) => Promise<void>;
}) {
  const { id, channelId, agentStore, transportStore, deliver } = opts;

  return inngest.createFunction({ id, triggers: [responseReady] }, async ({ event, step }) => {
    const { conversationId, messageId } = event.data;

    const [msg, sessions] = await step.run("resolve", async () => {
      const m = await agentStore.getMessage(messageId);
      const s = await transportStore.getActiveSessionsForConversation(conversationId);
      return [m, s.filter((s) => s.channelId === channelId)] as const;
    });

    if (!msg || sessions.length === 0) return;

    const text = contentToText(msg.content);

    for (const session of sessions) {
      await deliver(session.platformAddress, text);
    }
  });
}
