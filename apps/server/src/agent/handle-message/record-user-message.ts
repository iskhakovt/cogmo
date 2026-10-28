import { NonRetriableError } from "inngest";
import type { LlmProviderResolver } from "../../llm/resolver.js";
import type { AttachmentStore } from "../../transport/attachment-store.js";
import type { VoiceBundle } from "../../voice/resolver.js";
import {
  type ArrivalRoute,
  type NormalizeArrivalDeps,
  normalizeArrival,
} from "../attachments/normalize-arrival.js";
import { contentToBlocks } from "../conversation/inbound-content.js";
import type { AgentStore } from "../store/index.js";
import {
  type InboundRow,
  type SubstitutedInbound,
  substituteTranscripts,
} from "./inbound-batch.js";
import { freezeLimits, limitsPolicy, resolveOrFail } from "./resolve-turn-model.js";
import type { TurnSteps } from "./turn-steps.js";

export interface RecordUserMessageDeps extends Omit<NormalizeArrivalDeps, "attachments"> {
  agentStore: Pick<AgentStore, "insertMessage">;
  attachments: Pick<AttachmentStore, "download" | "read" | "put">;
  resolveProvider: LlmProviderResolver;
}

export interface RecordUserMessageArgs {
  conversationId: string;
  inboundMessages: ReadonlyArray<InboundRow>;
  voiceBundle: VoiceBundle | undefined;
  snapshot: { profileId: string; model: string };
  /** The batch's last inbound: the cursor the user row is written with. */
  maxInboundId: string;
  /** The batch's first inbound: the start of the range the user row records. */
  firstInboundId: string;
}

export interface RecordedUserMessage {
  substitutedMessages: ReadonlyArray<SubstitutedInbound>;
}

/**
 * Transcribe the batch's voice notes and write the turn's user row, its
 * attachments normalized to refs and placeholders capped to the turn's route
 * (design/transport/attachments.md).
 *
 * Steps, in order: `transcribe-voice` (only when the batch carries voice),
 * `create-user-message`.
 */
export async function recordUserMessage(
  step: TurnSteps,
  deps: RecordUserMessageDeps,
  args: RecordUserMessageArgs,
): Promise<RecordedUserMessage> {
  const { conversationId, inboundMessages, voiceBundle, snapshot, maxInboundId, firstInboundId } =
    args;

  // Voice transcription runs in a durable `step.run` boundary — STT is
  // a billable LLM-adjacent call, so Inngest retries replay from the
  // step cache (exactly-once on second attempt) instead of re-charging
  // the provider. Cached value is just an array of transcripts in the
  // same order as voice_ref blocks; OGG bytes never enter step state.
  // Runs BEFORE create-user-message so the persisted message contains
  // the actual transcript text rather than a path-only JSON literal.
  const voiceRefs = inboundMessages
    .flatMap((m) => contentToBlocks(m.content))
    .filter((b) => b.type === "voice_ref");
  const transcripts =
    voiceRefs.length > 0
      ? await step.run("transcribe-voice", async () => {
          const stt = voiceBundle?.stt;
          if (!stt) {
            // The resolver returns no bundle only for absent or invalid
            // config, which a retry would find unchanged.
            throw new NonRetriableError(
              "voice block received but no STT provider configured — run `cogmo setup` and configure voice, or insert a `voice_config` row pointing at valid `secrets` entries",
            );
          }
          const out: string[] = [];
          for (const ref of voiceRefs) {
            const bytes = await deps.attachments.download(ref.path);
            const result = await stt.provider.stt({
              audio: bytes,
              mediaType: ref.mediaType,
              model: stt.model,
            });
            out.push(result.text);
          }
          return out;
        })
      : [];

  const substitutedMessages = substituteTranscripts(inboundMessages, transcripts);

  await step.run("create-user-message", async () => {
    const content = await normalizeArrival(
      deps,
      () => arrivalRoute(deps.resolveProvider, snapshot.model),
      substitutedMessages,
    );
    await deps.runInTx((tx) =>
      deps.agentStore.insertMessage(tx, {
        conversationId,
        role: "user",
        content,
        profileId: snapshot.profileId,
        model: snapshot.model,
        lastInboundMessageId: maxInboundId,
        firstInboundMessageId: firstInboundId,
      }),
    );
  });

  return { substitutedMessages };
}

/**
 * The route the turn's attachments are capped to: the snapshot's model, as
 * `freeze-model-limits` will resolve it. A routing change between the two is
 * a concurrent operator action, and the cutoff absorbs any overrun.
 */
async function arrivalRoute(
  resolveProvider: LlmProviderResolver,
  model: string,
): Promise<ArrivalRoute> {
  const { provider, limits: rowLimits } = await resolveOrFail(resolveProvider, model);
  const limits = freezeLimits(model, provider, rowLimits);
  const { budget, attachmentBudget } = limitsPolicy(limits);
  if (attachmentBudget === null) {
    throw new Error("freezeLimits resolved no attachment limits");
  }
  return {
    budget: attachmentBudget,
    textDocumentBytes: limits.attachments?.textDocumentBytes,
    textDocumentTokens: Math.floor(budget / 4),
    countTokens: (text) =>
      provider.countTokens({ model, system: "", messages: [{ role: "user", content: text }] }),
  };
}
