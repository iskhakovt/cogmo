# Voice `[confirmed]`

How cogmo handles voice messages — speech-to-text on inbound, text-to-speech on outbound — across pluggable providers (OpenAI, ElevenLabs, Cartesia, Deepgram, …).

## Problem

Telegram is the primary channel and ships first-class voice clips (OGG/Opus). Users want to:

1. Send a voice message → cogmo transcribes it and treats it as a normal text turn
2. Receive a voice reply when their input was voice (modality mirroring), or always, or never

Voice TTS providers are commodity, expensive (~$0.02 per round-trip with current cheap PAYG), and quality-vs-price varies. Cogmo's existing LLM provider abstraction (`design/providers.md`) lets operators swap Anthropic / OpenRouter / OpenAI without code changes; the voice subsystem must hit the same bar — pick OpenAI today, swap to ElevenLabs tomorrow without touching the agent loop or transport.

## Architecture

### Cascade of decisions `[confirmed]`

Voice slots into the existing pipeline at four points, each consistent with how the rest of the system handles its concerns:

| Concern | Mechanism | Location |
|-|-|-|
| **Capability** | adapter capability flag (code-level) | `AdapterModule.supportsVoice` (or duck-typed via voice methods) |
| **Cost ceiling** | per-channel column | `channels.voice_max_reply_chars` |
| **User preference** | profile default + per-conversation override | `profiles.voice_mode`, nullable `conversations.voice_mode` |
| **Per-turn resolution** | pure helper called at turn-start | `resolveVoiceMode(...)` |

The agent loop stays modality-agnostic in terms of state, but the prompt-assembly step receives `voiceMode: boolean` and conditionally injects a voice-style hint. Voice mode is decided **once at turn-start** (durable step) and consumed in two places: (a) prompt assembly, (b) delivery-time TTS branching.

### Provider interfaces `[confirmed]`

Two interfaces in `src/voice/`, mirroring `LlmProvider`:

```typescript
interface TtsProvider {
  readonly name: string;
  tts(params: TtsParams): Promise<TtsResult>;
}

interface TtsParams {
  text: string;
  voice: string;             // provider-specific voice id (e.g. "alloy", or 11labs voice UUID)
  model?: string;            // e.g. "gpt-4o-mini-tts" — provider-specific
  format?: "ogg" | "mp3";    // requested encoding; provider may downgrade
}

interface TtsResult {
  audio: Buffer;
  mediaType: string;         // e.g. "audio/ogg"
  durationMs?: number;       // populated when the provider returns it
}

interface SttProvider {
  readonly name: string;
  stt(params: SttParams): Promise<SttResult>;
}

interface SttParams {
  audio: Buffer;
  mediaType: string;         // input format hint (Telegram voice = "audio/ogg")
  model?: string;
  language?: string;         // ISO-639-1, omit to auto-detect
}

interface SttResult {
  text: string;
  language?: string;
}
```

Two interfaces (not one combined `VoiceProvider`) so an operator can use OpenAI for STT (cheap, accurate) and ElevenLabs for TTS (better voice character) independently.

### Provider implementations

| Class | Provides | Notes |
|-|-|-|
| `OpenAIVoiceProvider` | TTS + STT | `gpt-4o-mini-tts` / `gpt-4o-mini-transcribe`; reuses the `openai` SDK already in the project; OGG/Opus directly via `response_format: "opus"` (no ffmpeg needed) |
| `ElevenLabsTtsProvider` *(deferred)* | TTS only | Pluggable for users who prefer 11labs quality; OGG output via `output_format=opus_48000_192` |
| `DeepgramSttProvider` *(deferred)* | STT only | Optional; Nova-3 for higher accuracy on noisy inputs |

Slice 1 ships `OpenAIVoiceProvider` only — covers both directions with one API key. The interface is what makes the others swappable; the deferred classes can be added later without touching consumers.

### Configuration `[confirmed]`

**Credentials live in the existing `secrets` table from day 0** — no env-only phase, in line with the [credential-storage decision](decisions.md). A small singleton table holds the active voice config:

```sql
voice_config (
  id              UUID PK,
  tts_secret_id   UUID NOT NULL FK → secrets,
  stt_secret_id   UUID NOT NULL FK → secrets,
  tts_provider    TEXT NOT NULL,                      -- 'openai' (slice 1)
  tts_model       TEXT NOT NULL,                      -- 'gpt-4o-mini-tts'
  tts_voice       TEXT NOT NULL,                      -- 'alloy' / etc.
  tts_base_url    TEXT,                               -- NULL = SDK default
  stt_provider    TEXT NOT NULL,
  stt_model       TEXT NOT NULL,                      -- 'gpt-4o-mini-transcribe'
  stt_base_url    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

**Singleton enforced (UNIQUE + CHECK)** — exactly zero or one row, pinned at the DB level via a `singleton boolean NOT NULL DEFAULT TRUE` column with `UNIQUE` and `CHECK (singleton = TRUE)`. A second insert violates the unique constraint at write time rather than relying on convention; `getVoiceConfig` also `ORDER BY created_at DESC` as defense-in-depth in case the constraint is somehow bypassed (manual psql, broken migration). The wizard creates the row when the operator opts into voice; reads return null when voice is unconfigured. If a future need for multiple voice configs emerges (per-profile voice character, per-channel TTS provider), promote to `voice_providers` + `voice_models` mirroring `llm_providers` + `model_providers` — but don't pre-build that machinery.

**Credential entry.** The wizard prompts for a fresh OpenAI API key dedicated to voice (stored as the `openai_voice_key` secret). Both `voice_config.tts_secret_id` and `voice_config.stt_secret_id` point at it initially; the FK split keeps a future TTS-on-ElevenLabs swap to a single column update. No "reuse the LLM provider's key" shortcut — voice traffic hits `/v1/audio/{speech,transcriptions}`, which some OpenAI-compatible providers (OpenRouter, custom proxies) don't serve, so making the operator paste the key once is clearer than offering a reuse path that silently fails on a subset of providers.

### Data model `[confirmed]`

```sql
-- channels: per-channel cost ceiling. (No voice_enabled gate — adapter
-- capability + voice_config presence + voice_mode preference are the gates.)
ALTER TABLE channels
  ADD COLUMN voice_max_reply_chars INT NOT NULL DEFAULT 700;

-- profiles: default voice preference (lives next to auto_recall, same shape).
CREATE TYPE voice_mode AS ENUM ('auto', 'always', 'never');
ALTER TABLE profiles
  ADD COLUMN voice_mode voice_mode NOT NULL DEFAULT 'auto';

-- conversations: optional override (NULL = follow profile).
-- Justification for nullable: NULL is "use profile default", a real semantic
-- value. Setting voice_mode at conversation level is opt-in via /voice.
ALTER TABLE conversations
  ADD COLUMN voice_mode voice_mode;
```

`voice_mode` semantics:
- `auto` (profile default) — mirror inbound modality. Voice in → voice out. Text in → text out.
- `always` — TTS every assistant message regardless of inbound type.
- `never` — text-only, even if inbound was voice.

**No `inbound_messages.source_type` column.** Modality lives in the content blocks themselves — a voice message is delivered as a `voice` content block (path to OGG in `AttachmentStore`), and the orchestrator detects "auto" mode by inspecting the most recent inbound row's content for a voice block. Project rule: avoid default values unless justified, and prefer signals that already exist in the data over redundant columns.

**Resolution at turn-start:**

```typescript
function resolveVoiceMode(input: {
  adapterSupportsVoice: boolean;
  voiceConfigPresent: boolean;
  conversationMode: VoiceMode | null;
  profileMode: VoiceMode;
  lastInboundWasVoice: boolean;
}): boolean {
  if (!input.adapterSupportsVoice) return false;
  if (!input.voiceConfigPresent) return false;
  const effective = input.conversationMode ?? input.profileMode;  // 'auto' if profile default unchanged
  if (effective === "never") return false;
  if (effective === "always") return true;
  // auto — mirror inbound
  return input.lastInboundWasVoice;
}
```

Decided once per turn at turn-start, fed to prompt assembly AND delivery. The agent sees voice mode (via the injected prompt hint) and shapes its response accordingly; delivery uses the same flag to branch into TTS.

### Inbound content shape `[confirmed]`

Extend `InboundContentSchema` in `src/transport/content.ts` with a voice block:

```typescript
const InboundVoiceBlockSchema = z.object({
  type: z.literal("voice"),
  path: z.string(),               // AttachmentStore key; OGG/Opus from Telegram
  mediaType: z.string(),          // 'audio/ogg' typically
  durationMs: z.number().int().optional(),  // when adapter knows it
});
```

The voice block lives in `inbound_messages.content` alongside text and image blocks. **Append-only** — the OGG path stays in the inbound row forever (audit trail, future re-transcription).

`contentToBlocks` translates voice blocks into `voice_ref` (orchestrator-only intermediate, like `image_ref` / `document_ref`):

```typescript
interface VoiceRef {
  type: "voice_ref";
  path: string;
  mediaType: string;
  durationMs?: number;
}
```

The orchestrator resolves `voice_ref` blocks to text via `step.run("transcribe-voice")` (see below) and replaces them with `text` blocks before passing to the LLM. The LLM never sees raw audio or a "voice block" — just plain text from transcription, like any other user input.

**Modality detection** for `auto` mode is purely structural: the orchestrator scans the most recent inbound row's content; presence of a voice block = `lastInboundWasVoice = true`.

### Inbound flow (Telegram voice → text)

```
bot.on("message:voice" | "message:audio")
  ↓ downloadTelegramFile (existing helper, validates file_path + response.ok)
  ↓ transport.uploadAttachment(buffer, "audio/ogg")
  ↓ emit inbound: [{ type: "voice", path, mediaType: "audio/ogg", durationMs }]

handle-message orchestrator (per-turn):
  ↓ inboundBlocks = contentToBlocks(...)  → has voice_ref
  ↓ resolvedBlocks = step.run("transcribe-voice", async () => {
       for each voice_ref:
         bytes = attachments.download(ref.path)
         { text } = sttProvider.stt({ audio: bytes, mediaType: ref.mediaType })
         return { type: "text", text }
     })
  ↓ feeds Message[] to runStreamingAgentLoop as normal user text
```

**Why orchestrator-side STT, not adapter-side:**
- **Retry semantics:** STT is a paid LLM-adjacent call. Failure inside a grammY handler drops the inbound on the floor. Inside `step.run`, Inngest retries replay from the cache (exactly-once on second attempt).
- **Audit + re-transcription:** OGG persists in `AttachmentStore` indefinitely. A future Observer can re-transcribe with a better model, a language hint, or a domain-specific vocabulary.
- **Domain-vs-infra split:** STT is a billable LLM-adjacent call — domain logic. Belongs in `src/voice/` invoked from `src/agent/`, not in `src/transport/adapters/telegram/`.

### Outbound flow (text → Telegram voice) — Option B `[confirmed]`

**Voice plus transcript** — text streams normally to the Telegram message edit-loop, then the voice clip arrives as a follow-up. Mirrors the image-generation pattern (text + photo). Trade: mildly noisy (user gets both modalities), but TTS failures don't strand the user — text is already delivered.

```
TelegramStreamHandle.finish()  // existing flow finishes the streamed text message
  ↓ if voiceModeForTurn:
      if result.text.length > channel.voice_max_reply_chars:
        // Above cap → text-only fallback with one-line note
        bot.api.sendMessage(chatId, "(too long for voice — text reply above)")
      else:
        ttsProvider.tts({ text: result.text, voice, model, format: "ogg" })
        ↓ bot.api.sendVoice(chatId, new InputFile(audio, "voice.ogg"))
```

The cap is a UX/cost fail-safe — the prompt hint should keep replies short already; the cap catches cases where the model ignores it. **No chunked-voice-plus-text-remainder mode** — simpler failure mode, fewer edge cases. 700 chars ≈ 60s of speech at conversational pace.

For batch delivery (Direct CLI, future channels): same code path inside `deliverBatch`, gated by `adapterSupportsVoice`.

### Prompt injection `[confirmed]`

When `voiceModeForTurn === true`, append to the system prompt at `assemblePrompt` time:

```
# Voice mode
Your response will be spoken aloud. Keep it short and natural — one or two sentences when possible. Skip routine acknowledgments ("saved", "noted", "I'll remember") unless the acknowledgment IS the entire answer. Don't narrate background work (memory saves, file writes, web searches) — the user assumes those happened. Avoid markdown, lists, code fences, and tables — they don't translate to speech.
```

Hooks into `DefaultPromptSource.assemble` — extend the signature with `{ voiceMode: boolean }` so all conditional inputs sit together (channel types, voice mode, recall context). This is the same pattern channel-types use today.

### `/voice` Telegram command `[confirmed]`

```
/voice                    — show current effective mode + provider info
/voice auto               — mirror inbound modality
/voice always             — TTS every reply
/voice off | /voice never — text only
/voice clear              — clear conversation override; follow profile default
```

Per-conversation. Mutates `conversations.voice_mode`. New `Transport.conversations.setVoiceMode(handle, conversationId, mode | null)` mirroring `setAlias` / `setProfile` — same identity check + ACL.

New `TransportError` code: `voice_unsupported` — adapter doesn't support voice (Direct CLI). Shown to the user as "voice replies aren't available on this channel." A profile-level `voice_mode = "always"` on a non-voice channel silently degrades to text rather than erroring per-turn.

## Edge cases & policies `[confirmed]`

- **Long replies.** See above. Cap = `channels.voice_max_reply_chars` (default 700, ~60s of speech). Above cap → text reply already streamed, plus a "(too long for voice)" note. No splitting.
- **Generated artifact + voice.** Agent calls `send_document` while in voice mode. Document goes through the existing `sendDocument` path; voice plays only the `result.text` preamble. No special case needed.
- **Mixed turn (voice in, image out).** Generated image + assistant text. Image goes through `sendPhoto`; text goes to TTS as voice. Three Telegram messages: streamed text, voice clip, photo. Same shape as today's image-in-stream pattern.
- **Voice in on a `never` profile.** STT still runs (we need the text); reply is text. No special "you sent voice but voice replies are off" hint — adds noise; the user's setting is the user's setting.
- **Voice config absent.** No voice_config row → `resolveVoiceMode` returns false unconditionally. Voice messages still arrive (they're content blocks); orchestrator's `transcribe-voice` step fails fast with a clear error → Inngest fails the turn → user gets the `conversation/errored` notify. (Operationally: if the wizard hasn't run, voice can't be in use either, so this is a misconfiguration path more than a runtime path.)
- **Cost runaway.** No automatic budget cap in slice 1. Operator's lever: shrink `channels.voice_max_reply_chars`, or `UPDATE profiles SET voice_mode = 'never'` to disable. Slice 2 can wire a per-day cost ceiling if needed.

## Telegram-specific encoding

Telegram's `sendVoice` requires OGG with Opus codec (other formats render as documents, not voice clips). OpenAI's TTS supports `response_format: "opus"` returning OGG/Opus directly — no ffmpeg dependency. ElevenLabs supports `output_format=opus_48000_192` similarly.

If a future provider doesn't support OGG (e.g. Deepgram Aura returns MP3), the adapter falls back to `sendAudio` which delivers as a regular audio file (still playable, just not the voice-bubble UI). Slice 1 doesn't bundle ffmpeg.

## Latency

TTS adds ~500–800ms after the agent finishes generating. Perceived latency is dominated by the agent loop (multi-second for any turn with tool calls). Voice mode doesn't slow the *agent*; it adds a fixed overhead to delivery.

For STT: `gpt-4o-mini-transcribe` is sub-second on Telegram-sized voice clips (typically <30s). The durable `step.run("transcribe-voice")` boundary adds ~50ms of Inngest overhead — negligible relative to the LLM call that follows.

## Tests

| Layer | Coverage |
|-|-|
| `OpenAIVoiceProvider.tts` | Happy path with mocked SDK; format pass-through; error mapping |
| `OpenAIVoiceProvider.stt` | Happy path; language hint passed; OGG input |
| `resolveVoiceMode` | All gates; auto/always/never matrix; profile fallback; lastInbound text vs voice |
| `contentToBlocks` voice branch | voice block → voice_ref; modality detection by content-block presence |
| `handle-message` transcribe-voice step | voice_ref resolves to text via step.run; STT mock; retry replays from step cache |
| Telegram inbound voice handler | Successful upload → emit voice block; missing file_path / non-OK fetch → no upload (existing helper) |
| Telegram outbound voice path | `voiceModeForTurn=true` → sendVoice with OGG; cap exceeded → text-only fallback note; `false` → existing text path |
| `/voice` command | All five flag values + bare; identity check; bare `/voice` shows mode |
| Transport `setVoiceMode` | Identity check; valid + invalid modes; null clears override; voice_unsupported error path |

**Integration testing for OpenAI voice** is **deferred**. `@copilotkit/aimock` speaks Anthropic Messages and OpenAI chat/embeddings — not `/v1/audio/speech` or `/v1/audio/transcriptions`. Slice 1 stays at unit-test level (mock the OpenAI SDK directly via `vi.mock("openai")`, same as `anthropic.test.ts`). When voice integration tests become valuable, build a `createOpenAIVoiceFetch` parallel to `createFalFetch` (`design/image-generation.md` → "fal-mock"): per-library fetch injection (the OpenAI SDK accepts a `fetch` option), record/replay fixtures keyed on `(model, sha256(text|audio_bytes), voice)`, strict-mode 503 on unmatched calls.

## Ecosystem context

The middleware-decides-modality / agent-stays-text-with-style-hint pattern matches the dominant 2025-2026 production pattern across **Pipecat**, **LiveKit Agents**, **Vapi**, **Retell**, **Bland**, and the **OpenAI MCP voice cookbook**. Cogmo's split-provider abstraction (TTS and STT independently swappable) follows what those frameworks expose as separate `tts:` and `stt:` config sections.

Realtime / WebSocket APIs (OpenAI Realtime, Gemini Live) are deliberately skipped — Telegram's Bot API only supports asynchronous voice clips, not bidirectional audio streams. If a future channel (web RTC, phone) needs realtime, that's a separate adapter shape, not a redesign.

Pricing (as of 2026-05): OpenAI `gpt-4o-mini-tts` ~$0.015 per 1k chars; `gpt-4o-mini-transcribe` $0.003/min. ElevenLabs Free tier 10k chars/month; paid tiers are subscription-based with no true PAYG.
