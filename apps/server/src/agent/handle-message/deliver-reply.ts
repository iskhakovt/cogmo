import type { Logger } from "pino";
import type { Transactor } from "../../db/index.js";
import type { AttachmentStore } from "../../transport/attachment-store.js";
import type { DeliveryHandle, DeliveryRouter } from "../../transport/delivery-router.js";
import type { TransportStore } from "../../transport/store/index.js";
import type { VoiceBundle } from "../../voice/resolver.js";
import { extractGeneratedDocuments, extractGeneratedImages } from "../extract-images.js";
import type { AgentLoopResult } from "../loop.js";
import type { TurnSteps } from "./turn-steps.js";

export interface DeliverReplyDeps {
  runInTx: Transactor;
  transportStore: Pick<TransportStore, "getVoiceMaxReplyChars">;
  attachments: Pick<AttachmentStore, "download">;
  deliveryRouter: Pick<DeliveryRouter, "notifyConversation">;
}

export interface DeliverReplyArgs {
  conversationId: string;
  delivery: DeliveryHandle;
  result: AgentLoopResult;
  /** The frozen decision that gates `batch-delivery`. */
  batchDelivery: boolean;
  /** Sessions whose stream failed at finish. */
  unstreamed: ReadonlyArray<string>;
  /** The frozen decision that gates `voice-delivery`. */
  voiceMode: boolean;
  voiceBundle: VoiceBundle | undefined;
  turnLogger: Logger;
}

/**
 * Deliver the persisted reply everywhere the stream didn't: batch targets,
 * streams that failed at finish, and voice.
 *
 * Steps, in order, each conditional: `batch-delivery`, `redeliver-unstreamed`,
 * `voice-delivery`.
 */
export async function deliverReply(
  step: TurnSteps,
  deps: DeliverReplyDeps,
  args: DeliverReplyArgs,
): Promise<void> {
  const { delivery, result, turnLogger } = args;

  // ──── DURABLE: batch delivery ────
  //
  // Wrapped in step.run so it's exactly-once on Inngest retry — without
  // this, a post-delivery step failure would re-fire sendMessage /
  // sendPhoto to batch adapters. Return value is the delivery summary
  // (small counts), so state stays lean — image bytes flow through the
  // step body in memory but never into Inngest state.
  //
  // Skipped entirely when the turn froze no batch targets (pure-streaming
  // setups like Telegram-only): the stream handle already handled
  // delivery mid-loop, and no S3 downloads are needed. The live targets
  // are re-checked inside the body.
  if (args.batchDelivery) {
    await step.run("batch-delivery", async () => {
      if (!delivery.hasBatchTargets()) {
        turnLogger.warn("batch delivery skipped — no batch targets");
        return { skipped: "unavailable" };
      }
      const imageRefs = extractGeneratedImages(result.newMessages);
      const documentRefs = extractGeneratedDocuments(result.newMessages);

      // Per-attachment resilience via allSettled — one S3 miss or
      // corrupted attachment shouldn't block delivery of the others
      // (matches the stream handle's swallow-and-log pattern).
      const imageSettled = await Promise.allSettled(
        imageRefs.map(async (ref) => ({
          data: await deps.attachments.download(ref.path),
          mediaType: ref.mediaType,
        })),
      );

      const fulfilledImages = imageSettled
        .filter((r) => r.status === "fulfilled")
        .map((r) => r.value);

      for (const [i, r] of imageSettled.entries()) {
        if (r.status === "rejected") {
          turnLogger.error(
            { err: r.reason, path: imageRefs[i]?.path },
            "outbound image download failed, skipping",
          );
        }
      }

      const docSettled = await Promise.allSettled(
        documentRefs.map(async (ref) => ({
          data: await deps.attachments.download(ref.path),
          mediaType: ref.mediaType,
          name: ref.name,
        })),
      );

      const fulfilledDocs = docSettled.filter((r) => r.status === "fulfilled").map((r) => r.value);

      for (const [i, r] of docSettled.entries()) {
        if (r.status === "rejected") {
          turnLogger.error(
            { err: r.reason, path: documentRefs[i]?.path },
            "outbound document download failed, skipping",
          );
        }
      }

      await delivery.deliverBatch(
        result.text,
        fulfilledImages.length > 0 ? fulfilledImages : undefined,
        fulfilledDocs.length > 0 ? fulfilledDocs : undefined,
      );

      return {
        imagesDelivered: fulfilledImages.length,
        imagesFailed: imageSettled.length - fulfilledImages.length,
        documentsDelivered: fulfilledDocs.length,
        documentsFailed: docSettled.length - fulfilledDocs.length,
      };
    });
  }

  // ──── DURABLE: redeliver to streams that failed at finish ────
  //
  // Through the target's batch `deliver`, in a step whose retries can
  // outlast a Telegram wait the stream handle gave up on.
  if (args.unstreamed.length > 0 && result.text.length > 0) {
    const sessions = args.unstreamed;
    await step.run("redeliver-unstreamed", async () => {
      await delivery.deliverUnstreamed(sessions, result.text);
      return { sessions: sessions.length };
    });
  }

  // ──── DURABLE: voice delivery (Option B — voice + transcript) ────
  //
  // TTS happens AFTER persist + batch delivery so the streamed text
  // already landed before we touch the voice provider — a TTS failure
  // never strands the user (text is in front of them, voice is a
  // bonus). Wrapped in step.run so retries replay from the cached
  // result rather than re-charging the TTS provider; cached value is
  // just the audio length so step state stays small. Long replies
  // (above the per-channel cap) skip TTS entirely — the cap is a
  // fail-safe; the voice guidance should keep replies short already.
  //
  // Gated on the frozen decision and the reply only, so the step exists
  // on every invocation that needs it; the live capability checks run
  // inside the body.
  if (args.voiceMode && result.text.length > 0) {
    await step.run("voice-delivery", async () => {
      const ttsBundle = args.voiceBundle?.tts;
      if (ttsBundle === undefined || !delivery.canDeliverVoice()) {
        turnLogger.warn("voice reply skipped — no TTS provider or voice-capable session");
        return { skipped: "unavailable" };
      }
      const cap = await deps.runInTx((tx) =>
        deps.transportStore.getVoiceMaxReplyChars(tx, args.conversationId),
      );
      const effectiveCap = cap ?? 700;
      if (result.text.length > effectiveCap) {
        turnLogger.info(
          { length: result.text.length, cap: effectiveCap },
          "voice reply skipped — over cap",
        );
        // The streamed text reply already landed; tell the user voice
        // was skipped so they know why their voice request didn't
        // produce a clip. Notify reaches every active session — in
        // mixed-channel setups a non-voice session also sees the
        // note, which is harmless and matches Option B (text always
        // wins). Wrapped in try/catch so a transient notify failure
        // (Telegram rate limit, network blip) can't fail the whole
        // turn — the text reply has already succeeded; the note is a
        // best-effort UX nicety.
        try {
          await deps.deliveryRouter.notifyConversation(
            args.conversationId,
            "(text reply too long for voice — see above)",
          );
        } catch (notifyErr) {
          turnLogger.warn(
            { err: notifyErr },
            "voice over-cap notification failed; turn already succeeded",
          );
        }
        return { skipped: "over_cap", length: result.text.length };
      }
      const { audio, mediaType } = await ttsBundle.provider.tts({
        text: result.text,
        voice: ttsBundle.voice,
        model: ttsBundle.model,
        format: "ogg",
      });
      await delivery.deliverVoice({ audio, mediaType });
      return { delivered: audio.byteLength, mediaType };
    });
  }
}
