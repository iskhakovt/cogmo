/**
 * Wizard step: voice — a TTS and an STT provider, probed with one short TTS
 * round-trip and stored as the `voice_config` row.
 */

import * as p from "@clack/prompts";
import type { SttProviderTypeValue, TtsProviderTypeValue } from "../../agent/store/schema.js";
import { ElevenLabsTtsProvider } from "../../voice/elevenlabs.js";
import { OpenAIVoiceProvider } from "../../voice/openai.js";
import type { TtsProvider } from "../../voice/types.js";
import { cancelGuard, type WizardDeps } from "./step.js";

const VOICE_SECRET_NAME = "openai_voice_key";
const VOICE_TTS_SECRET_NAME = "voice_tts_key";
const VOICE_STT_SECRET_NAME = "voice_stt_key";
const DEFAULT_OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_OPENAI_STT_MODEL = "gpt-4o-mini-transcribe";
const DEFAULT_OPENAI_TTS_VOICE = "alloy";
const DEFAULT_ELEVENLABS_TTS_MODEL = "eleven_turbo_v2_5";
const DEFAULT_ELEVENLABS_TTS_VOICE = "21m00Tcm4TlvDq8ikWAM";

/**
 * Six classic OpenAI TTS voices that work across all `gpt-4o-mini-tts` /
 * `tts-1` checkpoints. Newer voices (ash, ballad, coral, sage, verse) are
 * available on `gpt-4o-mini-tts` only and aren't worth a per-model voice
 * list in the wizard — operators wanting them can rotate via re-running
 * setup and entering a custom voice id via the CLI later if needed.
 */
const OPENAI_TTS_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;

/**
 * Lower-bound key length sanity check — real keys for the supported
 * providers (OpenAI sk-…, OpenRouter sk-or-…, ElevenLabs xi-…/sk_…, Groq
 * gsk_…) are all well over 20 chars. Catches obviously-typo'd inputs
 * without false-rejecting any current key format.
 */
const MIN_API_KEY_LENGTH = 20;

function validateBaseUrl(v: string | undefined): string | undefined {
  if (!v) return "Base URL is required";
  if (!v.startsWith("https://")) return "Base URL must start with https://";
  if (v.endsWith("/")) return "Base URL must not have a trailing slash";
  return undefined;
}

function validateApiKey(v: string | undefined): string | undefined {
  if (!v) return "API key is required";
  if (v.length < MIN_API_KEY_LENGTH) return "API key seems too short";
  return undefined;
}

interface TtsChoice {
  type: TtsProviderTypeValue;
  apiKey: string;
  baseURL: string | null;
  model: string;
  voice: string;
}

interface SttChoice {
  type: SttProviderTypeValue;
  apiKey: string;
  baseURL: string | null;
  model: string;
}

async function promptTtsChoice(): Promise<TtsChoice> {
  const type = cancelGuard(
    await p.select<TtsProviderTypeValue>({
      message: "TTS provider:",
      options: [
        { value: "openai", label: "OpenAI", hint: "/v1/audio/speech" },
        {
          value: "openai_compatible",
          label: "OpenAI-compatible (custom base URL)",
          hint: "Groq, self-hosted relay, …",
        },
        { value: "elevenlabs", label: "ElevenLabs", hint: "natural voice character" },
      ],
      initialValue: "openai",
    }),
  );

  const baseURL =
    type === "openai_compatible"
      ? cancelGuard(
          await p.text({
            message: "TTS base URL (no trailing slash):",
            placeholder: "https://api.groq.com/openai/v1",
            validate: validateBaseUrl,
          }),
        )
      : null;

  const apiKey = cancelGuard(
    await p.password({
      message: `Paste your ${type === "elevenlabs" ? "ElevenLabs" : "TTS"} API key:`,
      validate: validateApiKey,
    }),
  );

  if (type === "elevenlabs") {
    const model = cancelGuard(
      await p.text({
        message: "TTS model:",
        placeholder: DEFAULT_ELEVENLABS_TTS_MODEL,
        defaultValue: DEFAULT_ELEVENLABS_TTS_MODEL,
      }),
    );
    const voice = cancelGuard(
      await p.text({
        message: "Voice id (from your ElevenLabs voice library):",
        placeholder: DEFAULT_ELEVENLABS_TTS_VOICE,
        defaultValue: DEFAULT_ELEVENLABS_TTS_VOICE,
      }),
    );
    return { type, apiKey, baseURL, model, voice };
  }

  const model = cancelGuard(
    await p.text({
      message: "TTS model:",
      placeholder: DEFAULT_OPENAI_TTS_MODEL,
      defaultValue: DEFAULT_OPENAI_TTS_MODEL,
    }),
  );
  const voice =
    type === "openai"
      ? cancelGuard(
          await p.select({
            message: "Voice:",
            options: OPENAI_TTS_VOICES.map((v) => ({ value: v, label: v })),
            initialValue: DEFAULT_OPENAI_TTS_VOICE,
          }),
        )
      : cancelGuard(
          await p.text({
            message: "Voice id (provider-specific):",
            placeholder: DEFAULT_OPENAI_TTS_VOICE,
            defaultValue: DEFAULT_OPENAI_TTS_VOICE,
          }),
        );
  return { type, apiKey, baseURL, model, voice };
}

async function promptSttChoice(tts: TtsChoice): Promise<SttChoice> {
  const type = cancelGuard(
    await p.select<SttProviderTypeValue>({
      message: "STT provider:",
      options: [
        { value: "openai", label: "OpenAI", hint: "/v1/audio/transcriptions" },
        {
          value: "openai_compatible",
          label: "OpenAI-compatible (custom base URL)",
          hint: "Groq, self-hosted relay, …",
        },
      ],
      initialValue: "openai",
    }),
  );

  const baseURL =
    type === "openai_compatible"
      ? cancelGuard(
          await p.text({
            message: "STT base URL (no trailing slash):",
            placeholder: "https://api.groq.com/openai/v1",
            validate: validateBaseUrl,
          }),
        )
      : null;

  // Reuse-key shortcut only when both directions hit the SAME provider type
  // and base URL — anything else (different vendor, different relay, ElevenLabs
  // TTS) needs its own key and offering reuse would silently 401. The
  // `tts.type === type` narrows tts.type to the STT-supported subset, so
  // ElevenLabs TTS already excludes itself here.
  const canReuse = tts.type === type && tts.baseURL === baseURL;
  let apiKey = tts.apiKey;
  if (!canReuse) {
    apiKey = cancelGuard(
      await p.password({
        message: "Paste your STT API key:",
        validate: validateApiKey,
      }),
    );
  } else {
    const reuse = await p.confirm({
      message: "Use the same key for STT? (TTS + STT routed to the same endpoint)",
      initialValue: true,
    });
    if (!cancelGuard(reuse)) {
      apiKey = cancelGuard(
        await p.password({
          message: "Paste your STT API key:",
          validate: validateApiKey,
        }),
      );
    }
  }

  const model = cancelGuard(
    await p.text({
      message: "STT model:",
      placeholder: DEFAULT_OPENAI_STT_MODEL,
      defaultValue: DEFAULT_OPENAI_STT_MODEL,
    }),
  );

  return { type, apiKey, baseURL, model };
}

function buildTtsProbe(choice: TtsChoice): TtsProvider {
  switch (choice.type) {
    case "openai":
      return new OpenAIVoiceProvider({ apiKey: choice.apiKey });
    case "openai_compatible":
      return new OpenAIVoiceProvider({
        apiKey: choice.apiKey,
        baseURL: choice.baseURL ?? "",
      });
    case "elevenlabs":
      return new ElevenLabsTtsProvider({ apiKey: choice.apiKey });
  }
}

/**
 * Configure voice (TTS + STT). Optional — only operators who want
 * Telegram voice replies need this. Re-runnable: existing config offers
 * keep / replace / remove. The "remove" branch deletes the `voice_config`
 * row; the bootstrap resolver returns undefined on the next message and
 * voice degrades to text.
 *
 * TTS supports OpenAI, OpenAI-compatible (any provider that serves
 * `/v1/audio/speech`, e.g. self-hosted relays), and ElevenLabs. STT
 * supports OpenAI and OpenAI-compatible (Groq's `/v1/audio/transcriptions`
 * is a common pick). Each direction is configured independently — a shared
 * key is offered only when the provider type and base URL match. Config takes effect on the next message; no
 * restart required (resolver is hot-reloaded).
 */
export async function stepConfigureVoice(deps: WizardDeps): Promise<void> {
  const existing = await deps.runInTx((tx) => deps.agentStore.getVoiceConfig(tx));

  if (existing) {
    const action = await p.select({
      message: `Voice is configured (TTS=${existing.ttsProvider}/${existing.ttsModel}/${existing.ttsVoice}). What would you like to do?`,
      options: [
        { value: "keep", label: "Keep current configuration" },
        { value: "replace", label: "Reconfigure" },
        { value: "remove", label: "Remove voice configuration" },
      ],
    });
    cancelGuard(action);
    if (action === "keep") return;
    if (action === "remove") {
      await deps.runInTx((tx) => deps.agentStore.deleteVoiceConfig(tx));
      p.log.success("Voice configuration removed. Takes effect on the next message.");
      return;
    }
  } else {
    const proceed = await p.confirm({
      message: "Configure voice replies (TTS + STT)? (optional)",
      initialValue: false,
    });
    if (!cancelGuard(proceed)) return;
  }

  p.note(
    [
      "TTS providers: OpenAI (/v1/audio/speech), OpenAI-compatible relays",
      "(Groq, self-hosted), or ElevenLabs (natural voice character).",
      "STT providers: OpenAI or OpenAI-compatible (e.g. Groq Whisper).",
      "",
      "Keys: https://platform.openai.com/api-keys",
      "      https://elevenlabs.io/app/settings/api-keys",
      "      https://console.groq.com/keys",
    ].join("\n"),
    "Voice provider keys",
  );

  const tts = await promptTtsChoice();
  const stt = await promptSttChoice(tts);

  // Live probe — one short TTS round-trip (~$0.0002 at OpenAI pricing,
  // <$0.001 at ElevenLabs free tier). Validates the key + model + voice
  // against the actual endpoint, catching wrong-account / wrong-tier
  // failures the wizard can't see at paste-time. STT probe stays out —
  // requires a real audio sample.
  const s = p.spinner();
  s.start("Validating TTS provider (1-word probe)...");
  let probeOk = false;
  try {
    const probe = buildTtsProbe(tts);
    await probe.tts({ text: "hi", voice: tts.voice, model: tts.model, format: "ogg" });
    s.stop("TTS provider validated.");
    probeOk = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    s.stop(`TTS probe failed: ${message}`);
    p.log.warn(
      "If the model is tier-locked or the name is wrong, re-run setup and pick a different TTS model or provider.",
    );
    const saveAnyway = await p.confirm({
      message: "Save the config anyway? Voice replies will error on first use.",
      initialValue: false,
    });
    if (!cancelGuard(saveAnyway)) return;
  }

  // Atomic — store secret(s), conditionally mark them validated, and link
  // the voice_config row in a single tx. A crash mid-flight leaves no
  // orphan rows in a state that affects bootstrap (no voice_config row →
  // voice stays disabled).
  //
  // Reuse is gated on the same condition `promptSttChoice`'s "use the same
  // key" shortcut uses (same provider type + same base URL). String-equal
  // keys across incompatible providers (e.g. ElevenLabs TTS + OpenAI STT
  // happening to paste the same clipboard contents) get two rows, so each
  // secret's `description` accurately names its provider.
  const reusedSecret =
    tts.apiKey === stt.apiKey && tts.type === stt.type && tts.baseURL === stt.baseURL;
  // Both directions sharing an OpenAI key store it as `openai_voice_key`, the
  // name existing single-key deployments already hold.
  const ttsSecretName =
    reusedSecret && tts.type === "openai" && stt.type === "openai"
      ? VOICE_SECRET_NAME
      : VOICE_TTS_SECRET_NAME;
  const sttSecretName = reusedSecret ? ttsSecretName : VOICE_STT_SECRET_NAME;

  await deps.runInTx(async (tx) => {
    const { id: ttsSecretId } = await deps.secretsStore.putSecret(tx, {
      name: ttsSecretName,
      plaintext: tts.apiKey,
      description: `${tts.type} API key for voice TTS`,
    });
    let sttSecretId = ttsSecretId;
    if (!reusedSecret) {
      const stored = await deps.secretsStore.putSecret(tx, {
        name: sttSecretName,
        plaintext: stt.apiKey,
        description: `${stt.type} API key for voice STT`,
      });
      sttSecretId = stored.id;
    }
    if (probeOk) {
      await deps.secretsStore.markValidated(tx, ttsSecretName);
    }
    await deps.agentStore.upsertVoiceConfig(tx, {
      ttsSecretId,
      sttSecretId,
      ttsProvider: tts.type,
      ttsModel: tts.model,
      ttsVoice: tts.voice,
      ttsBaseUrl: tts.baseURL,
      sttProvider: stt.type,
      sttModel: stt.model,
      sttBaseUrl: stt.baseURL,
    });
  });

  const summary = `TTS=${tts.type}/${tts.model}/${tts.voice}, STT=${stt.type}/${stt.model}`;
  if (probeOk) {
    p.log.success(`Voice configured (${summary}). Takes effect on the next message.`);
  } else {
    p.log.warn(
      `Voice config saved UNVALIDATED — probe failed; first voice reply will surface any auth issue (${summary}). Takes effect on the next message.`,
    );
  }
}
