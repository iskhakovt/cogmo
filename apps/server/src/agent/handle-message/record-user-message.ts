import type { Transactor } from "../../db/index.js";
import type { AttachmentStore } from "../../transport/attachment-store.js";
import { contentToBlocks } from "../../transport/content.js";
import type { VoiceBundle } from "../../voice/resolver.js";
import type { AgentStore } from "../store/index.js";
import {
  type InboundRow,
  renderUserContent,
  type SubstitutedInbound,
  substituteTranscripts,
} from "./inbound-batch.js";
import type { TurnSteps } from "./turn-steps.js";

export interface RecordUserMessageDeps {
  runInTx: Transactor;
  agentStore: Pick<AgentStore, "insertMessage">;
  attachments: Pick<AttachmentStore, "download">;
}

export interface RecordUserMessageArgs {
  conversationId: string;
  inboundMessages: ReadonlyArray<InboundRow>;
  voiceBundle: VoiceBundle | undefined;
  snapshot: { profileId: string; model: string };
  /** The batch's last inbound: the cursor the user row is written with. */
  maxInboundId: string;
}

export interface RecordedUserMessage {
  substitutedMessages: ReadonlyArray<SubstitutedInbound>;
  /** The user row's `messages.content`. */
  userContentText: string;
}

/**
 * Transcribe the batch's voice notes and write the turn's user row.
 *
 * Steps, in order: `transcribe-voice` (only when the batch carries voice),
 * `create-user-message`.
 */
export async function recordUserMessage(
  step: TurnSteps,
  deps: RecordUserMessageDeps,
  args: RecordUserMessageArgs,
): Promise<RecordedUserMessage> {
  const { conversationId, inboundMessages, voiceBundle, snapshot, maxInboundId } = args;

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
            throw new Error(
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
  const userContentText = renderUserContent(substitutedMessages);

  await step.run("create-user-message", async () => {
    await deps.runInTx((tx) =>
      deps.agentStore.insertMessage(tx, {
        conversationId,
        role: "user",
        content: userContentText,
        profileId: snapshot.profileId,
        model: snapshot.model,
        lastInboundMessageId: maxInboundId,
      }),
    );
  });

  return { substitutedMessages, userContentText };
}
