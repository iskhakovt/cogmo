import { inngest } from "../inngest/client.js";
import { inboundArrived, responseReady } from "../inngest/events.js";
import type { LlmProvider } from "../llm/provider.js";
import type { Message } from "../llm/types.js";
import { logger } from "../logger.js";
import type { MemoryProvider } from "../memory/provider.js";
import { contentToText } from "../transport/content.js";
import type { TransportStore } from "../transport/store/index.js";
import type { AgentLoopResult } from "./loop.js";
import type { PromptSource } from "./prompt.js";
import type { Service } from "./service.js";
import { createService } from "./service.js";
import type { AgentStore } from "./store/index.js";
import type { ToolRegistry } from "./tools.js";

export interface HandleMessageDeps {
  agentStore: AgentStore;
  transportStore: TransportStore;
  provider: LlmProvider;
  tools: ToolRegistry;
  memory: MemoryProvider;
  promptSource: PromptSource;
  runAgentLoop: (params: {
    provider: LlmProvider;
    model: string;
    systemPrompt: string;
    messages: Message[];
    tools: ToolRegistry;
    service: Service;
  }) => Promise<AgentLoopResult>;
}

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

/**
 * Main message pipeline — thin orchestration only.
 *
 * Receives inbound/arrived events (adapter has already persisted the inbound
 * message and resolved the session). Loads context, runs the agent, persists
 * the response, emits response/ready for delivery.
 */
export function createHandleMessage(deps: HandleMessageDeps) {
  const { agentStore, transportStore, provider, tools, memory, promptSource, runAgentLoop } = deps;

  return inngest.createFunction(
    {
      id: "handle-message",
      triggers: [inboundArrived],
      retries: 2,
      concurrency: { limit: 1, key: "event.data.conversationId" },
    },
    async ({ event, step }) => {
      const { conversationId, inboundMessageId } = event.data;

      // Step 1: Load conversation context
      const conv = await step.run("load-conversation", async () => {
        return agentStore.getConversation(conversationId);
      });
      if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

      const { userId, profileId } = conv;

      // Step 2: Load unbatched inbound messages
      const lastAssistant = await step.run("last-assistant", async () => {
        return agentStore.getLastAssistantMessage(conversationId);
      });

      const inboundMessages = await step.run("load-inbound", async () => {
        return transportStore.getUnbatchedInbound(
          conversationId,
          lastAssistant?.lastInboundMessageId ?? null,
        );
      });

      // Step 3: Batch into user message
      const userContent = inboundMessages.map((m) => contentToText(m.content)).join("\n");
      const maxInboundId = inboundMessages.at(-1)?.id ?? inboundMessageId;

      await step.run("create-user-message", async () => {
        await agentStore.insertMessage({
          conversationId,
          role: "user",
          content: userContent,
          lastInboundMessageId: maxInboundId,
        });
      });

      // Step 4: Load conversation history
      const history = await step.run("load-history", async () => {
        return agentStore.getHistory(conversationId);
      });

      // Step 5: Assemble system prompt
      const systemPrompt = await step.run("assemble-prompt", async () => {
        return promptSource.assemble(agentStore, profileId);
      });

      // Step 6: Run the agentic loop
      const profile = await agentStore.getProfile(profileId);
      const service = createService(memory, userId, []);
      const result = await step.run("agent-loop", async () => {
        return runAgentLoop({
          provider,
          model: profile?.model ?? DEFAULT_MODEL,
          systemPrompt,
          messages: [...history] as Message[],
          tools,
          service,
        });
      });

      logger.info(
        {
          conversationId,
          model: result.model,
          iterations: result.iterations,
          usage: result.usage,
        },
        "agent loop complete",
      );

      // Step 7: Persist assistant response
      const assistantMsg = await step.run("persist-assistant-message", async () => {
        return agentStore.insertMessage({
          conversationId,
          role: "assistant",
          content: result.text,
          lastInboundMessageId: maxInboundId,
        });
      });

      // Step 8: Emit response/ready — respond functions handle delivery
      await step.sendEvent(
        "send-response",
        responseReady.create({
          conversationId,
          messageId: assistantMsg.id,
        }),
      );
    },
  );
}
