import type { z } from "zod";
import { parseGateCommand } from "../../agent/pipeline/gate-keyboard.js";
import { directInbound, directOutbound } from "../../inngest/events.js";
import type { StepRun } from "../../inngest/index.js";
import { logger } from "../../logger.js";
import {
  type AdapterDeps,
  type AdapterModule,
  type AdapterSetupResult,
  isRenderedMessage,
} from "../adapter-module.js";
import type { Transport } from "../transport.js";

export const channelType = "direct";

type DirectInboundData = z.infer<typeof directInbound.schema>;

export type DirectInboundResult =
  | { status: "new_conversation" }
  | { status: "emitted"; conversationId: string }
  | { status: "gate_resolved"; conversationId: string }
  | { status: "gate_rejected"; reason: string };

/**
 * Inbound body for the Direct channel — extracted from the Inngest function
 * so it's unit-testable by direct call with `makeStepRun()`, no real client
 * required. `/new` closes the session; anything else resolves (or creates)
 * the session and emits the message. Each transport touch is its own
 * `step.run` so an Inngest retry replays from the durable cache.
 */
export async function handleDirectInbound(
  deps: { transport: Transport },
  event: DirectInboundData,
  stepRun: StepRun,
): Promise<DirectInboundResult> {
  const { transport } = deps;
  const { platformAddress, text, platformTs } = event;

  if (text === "/new") {
    await stepRun("close-session", async () => {
      const session = await transport.resolveSession(platformAddress);
      if (session) {
        await transport.closeSession(session.id);
        logger.info({ platformAddress }, "direct: session closed");
      }
    });
    return { status: "new_conversation" };
  }

  // A gate decision is not conversation input: routing it through `emit`
  // would hand the model a turn where the engine wants a deterministic
  // transition. Same Transport method the Telegram keyboard taps.
  if (text.startsWith("/gate")) {
    const parsed = parseGateCommand(text.slice("/gate".length));
    if (!parsed) {
      return { status: "gate_rejected", reason: "usage: /gate approve|revise [feedback]|cancel" };
    }
    return stepRun("resolve-gate", async () => {
      const existing = await transport.resolveSession(platformAddress);
      if (!existing) return { status: "gate_rejected" as const, reason: "no active conversation" };
      const result = await transport.pipelines.resolveGate({
        target: { kind: "conversation", conversationId: existing.conversationId },
        decision: parsed.action,
        tapperPlatformHandle: platformAddress,
        ...(parsed.feedback !== undefined && { feedback: parsed.feedback }),
      });
      if (result.isErr()) {
        return { status: "gate_rejected" as const, reason: result.error.code };
      }
      logger.info(
        { platformAddress, runId: result.value.runId, decision: parsed.action },
        "direct: pipeline gate resolved",
      );
      return { status: "gate_resolved" as const, conversationId: existing.conversationId };
    });
  }

  const session = await stepRun("resolve-session", async () => {
    const existing = await transport.resolveSession(platformAddress);
    if (existing) return existing;

    const result = await transport.createConversation(platformAddress, platformAddress, {
      isPrivate: true,
    });
    if (result.isErr()) throw new Error(`Failed to create conversation: ${result.error.code}`);
    return result.value;
  });

  await stepRun("emit", async () => {
    const result = await transport.emit(session.id, text, new Date(platformTs));
    if (result.isErr()) throw new Error(`Failed to emit: ${result.error.code}`);
  });

  return { status: "emitted", conversationId: session.conversationId };
}

/**
 * Direct channel adapter — purely event-driven, no long-running process.
 *
 * Inbound: Inngest function listens for adapter/direct/inbound.
 * Outbound: deliver() emits adapter/direct/outbound.
 *
 * External clients (console script, automations) interact via Inngest events.
 */
export async function setup(deps: AdapterDeps): Promise<AdapterSetupResult> {
  const { transport, inngest } = deps;

  const inboundFn = inngest.createFunction(
    { id: "direct-inbound", triggers: [directInbound] },
    async ({ event, step }) => handleDirectInbound({ transport }, event.data, step.run),
  );

  return {
    adapter: {
      deliver: async (platformAddress, content) => {
        if (isRenderedMessage(content)) {
          const images = content.images?.map((img) => ({
            data: img.data.toString("base64"),
            mediaType: img.mediaType,
          }));
          await inngest.send(
            directOutbound.create({
              platformAddress,
              content: content.text,
              ...(images && images.length > 0 && { images }),
            }),
          );
        } else {
          const text = typeof content === "string" ? content : JSON.stringify(content);
          await inngest.send(
            directOutbound.create({
              platformAddress,
              content: text,
            }),
          );
        }
      },
      // Voice payload rides on the same `directOutbound` event as text —
      // emitted as a separate event with `content: ""` so console clients
      // can correlate it to the just-delivered text by `platformAddress`.
      // Present mostly as a capability hook for integration tests; real
      // CLI consumers may render or save the audio bytes as they prefer.
      sendVoice: async (platformAddress, audio) => {
        await inngest.send(
          directOutbound.create({
            platformAddress,
            content: "",
            voice: {
              data: audio.audio.toString("base64"),
              mediaType: audio.mediaType,
            },
          }),
        );
      },
      stop: async () => {},
    },
    functions: [inboundFn],
  };
}

export default { channelType, setup } satisfies AdapterModule;
