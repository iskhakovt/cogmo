import type { z } from "zod";
import { directInbound, directOutbound } from "../../inngest/events.js";
import type { StepRun } from "../../inngest/index.js";
import { logger } from "../../logger.js";
import {
  type AdapterDeps,
  type AdapterModule,
  type AdapterSetupResult,
  isRenderedMessage,
} from "../adapter-module.js";
import type { Transport, TransportError } from "../transport.js";

export const channelType = "direct";

type DirectInboundData = z.infer<typeof directInbound.schema>;

export type DirectInboundResult =
  | { status: "new_conversation" }
  | { status: "emitted"; conversationId: string }
  /** Transport refused the message: an unknown sender, or a session gone before emit. */
  | { status: "rejected"; reason: TransportError };

/**
 * Inbound body for the Direct channel — extracted from the Inngest function
 * so it's unit-testable by direct call with `makeStepRun()`, no real client
 * required. `/new` closes the session; anything else resolves (or creates)
 * the session and emits the message. Each transport touch is its own
 * `step.run` so an Inngest retry replays from the durable cache.
 *
 * Transport's refusals are deterministic, so the run completes as `rejected`
 * rather than throwing into a retry that meets the same answer. Steps return
 * them as plain records: a neverthrow `Result` does not survive the step's
 * JSON round trip.
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

  const resolved = await stepRun("resolve-or-create-session", async () => {
    const existing = await transport.resolveSession(platformAddress);
    if (existing) return { ok: true as const, session: existing };
    const created = await transport.createConversation(platformAddress, platformAddress, {
      isPrivate: true,
    });
    return created.match(
      (session) => ({ ok: true as const, session }),
      (reason) => ({ ok: false as const, reason }),
    );
  });
  if (!resolved.ok) return rejected(platformAddress, resolved.reason);
  const { session } = resolved;

  const emitted = await stepRun("emit-inbound", async () => {
    const result = await transport.emit(session.id, text, new Date(platformTs));
    return result.match(
      () => ({ ok: true as const }),
      (reason) => ({ ok: false as const, reason }),
    );
  });
  if (!emitted.ok) return rejected(platformAddress, emitted.reason);

  return { status: "emitted", conversationId: session.conversationId };
}

function rejected(platformAddress: string, reason: TransportError): DirectInboundResult {
  logger.warn({ platformAddress, reason }, "direct: transport rejected the inbound message");
  return { status: "rejected", reason };
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
