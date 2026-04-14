import { inngest } from "../../inngest/client.js";
import { directInbound, directOutbound } from "../../inngest/events.js";
import { logger } from "../../logger.js";
import type {
  AdapterDeps,
  AdapterModule,
  AdapterSetupResult,
  RenderedMessage,
} from "../adapter-module.js";
import { contentToText } from "../content.js";

export const channelType = "direct";

/**
 * Direct channel adapter — purely event-driven, no long-running process.
 *
 * Inbound: Inngest function listens for adapter/direct/inbound.
 * Outbound: deliver() emits adapter/direct/outbound.
 *
 * External clients (console script, automations) interact via Inngest events.
 */
export async function setup(deps: AdapterDeps): Promise<AdapterSetupResult> {
  const { transport } = deps;

  const inboundFn = inngest.createFunction(
    { id: "direct-inbound", triggers: [directInbound] },
    async ({ event, step }) => {
      const { platformAddress, text, platformTs } = event.data;

      if (text === "/new") {
        await step.run("close-session", async () => {
          const session = await transport.resolveSession(platformAddress);
          if (session) {
            await transport.closeSession(session.id);
            logger.info({ platformAddress }, "direct: session closed");
          }
        });
        return { status: "new_conversation" };
      }

      const session = await step.run("resolve-session", async () => {
        const existing = await transport.resolveSession(platformAddress);
        if (existing) return existing;

        const result = await transport.createConversation(platformAddress, platformAddress, {
          isPrivate: true,
        });
        if (result.isErr()) throw new Error(`Failed to create conversation: ${result.error.code}`);
        return result.value;
      });

      await step.run("emit", async () => {
        const result = await transport.emit(session.id, text, new Date(platformTs));
        if (result.isErr()) throw new Error(`Failed to emit: ${result.error.code}`);
      });

      return { status: "emitted", conversationId: session.conversationId };
    },
  );

  return {
    adapter: {
      deliver: async (platformAddress, content) => {
        const text =
          typeof content === "object" && content !== null && "parseMode" in content
            ? (content as RenderedMessage).text
            : contentToText(content as import("type-fest").JsonValue);
        await inngest.send(directOutbound.create({ platformAddress, content: text }));
      },
      stop: async () => {},
    },
    functions: [inboundFn],
  };
}

export default { channelType, setup } satisfies AdapterModule;
