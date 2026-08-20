# Image Generation `[confirmed]`

How cogmo generates images on behalf of the user — provider-agnostic from day 0.

## Problem

The agent needs to generate images (illustrations, diagrams, creative visuals) when the user asks. The image generation landscape has no unified API standard (unlike text LLMs where OpenAI's chat completions became the de facto protocol). Every provider — fal.ai, Replicate, OpenAI, BFL, Stability AI — has a bespoke REST API with different request shapes, response formats, and async patterns. The system needs an abstraction that lets us swap providers without touching the tool or delivery layers.

## Architecture

```
Agent calls generate_image tool
  → tool calls generateImage() (Vercel AI SDK)
  → AI SDK adapter calls fal.ai (or future provider)
  → normalized result returned (base64 + mediaType)
  → tool uploads to AttachmentStore (generated/ prefix)
  → tool returns text result to LLM (path + metadata)
  → LLM responds with text
  → delivery path (two routes, per adapter type):
      Streaming adapters (Telegram): stream handle receives tool_result
        event, parses path, downloads from AttachmentStore, sendPhoto
        mid-stream
      Batch adapters (non-streaming channels): orchestrator extracts
        image paths from tool results after loop, resolves to Buffers,
        passes to deliverBatch alongside text
```

Three layers, each independent:

| Layer | Responsibility | Changes when... |
|-|-|-|
| Vercel AI SDK `generateImage()` + provider package | Call provider API, return normalized bytes | Switching/adding providers (swap `@ai-sdk/fal` → `@ai-sdk/openai`) |
| `generate_image` tool | Validate input, call SDK, store result, return text | Changing tool UX (params, description, model catalog) |
| Outbound delivery | Parse tool result, deliver alongside text | Adding channels |

## Why the Vercel AI SDK `[confirmed]`

The AI SDK's `generateImage()` is the industry standard TypeScript abstraction for image generation (12+ providers, single interface). We evaluated it for both image generation and text LLMs.

### Image generation: good fit

Image generation is a simple request/response pattern — send prompt, get bytes back. No streaming, no tool calling, no token counting, no prompt caching. The provider differences are purely request/response shapes — exactly what an abstraction layer is for. The AI SDK eliminates adapter code we'd otherwise write and maintain per provider.

```typescript
import { generateImage } from "ai";
import { fal } from "@ai-sdk/fal";

const { image } = await generateImage({
  model: fal.image("fal-ai/flux/dev"),
  prompt: "A serene mountain landscape",
  aspectRatio: "16:9",
  seed: 42,
  providerOptions: { fal: { numInferenceSteps: 40 } },
});
// image.base64, image.uint8Array, image.mediaType
```

Swap `fal.image(...)` for `openai.image("gpt-image-1")` — zero tool code changes.

### Text LLMs: not yet (two blockers)

We evaluated the AI SDK for replacing our `LlmProvider` interface (`AnthropicProvider` + `OpenAICompatibleProvider`). It covers 8 of 10 requirements — prompt caching via `providerOptions`, extended thinking, streaming with tool accumulation, custom headers, programmatic provider construction. But two gaps block adoption:

**1. `countTokens` — missing.** The AI SDK has no `countTokens` function. PR [#12176](https://github.com/vercel/ai/pull/12176) has been open since January 2026, not merged. Our context management pipeline calls `countTokens` before every agent turn to decide whether compaction is needed. Without it, we'd keep a parallel raw Anthropic SDK client just for token counting, defeating the abstraction benefit.

**2. Thinking block signatures — bug [#11602](https://github.com/vercel/ai/issues/11602).** During multi-step tool calls, `response.messages` can lose the `providerMetadata` containing Anthropic's cryptographic signatures for thinking blocks. Our agent loop preserves these signatures in conversation history for multi-turn thinking continuity. Partially fixed (PR #11688, #12433) but not fully resolved.

**Additionally:** the AI SDK uses its own content block model (`TextPart`, `ToolCallPart`, `ReasoningPart`) rather than Anthropic's native shape. Our canonical types (`ContentBlock`, `Message`) mirror Anthropic directly — adopting AI SDK types would require a mapping layer or a larger migration of our conversation history format.

**Decision:** Use the AI SDK where it's a clear win (image gen) and keep raw SDKs where we need features it doesn't yet support (text LLMs). Revisit when `countTokens` lands and the signature bug is resolved — the AI SDK would then eliminate ~400 lines of adapter code in `src/llm/`.

## Providers `[confirmed]`

Three provider types. Two go through Vercel AI SDK adapters; one is hand-rolled. The `type` column on `image_providers` is a `pgEnum` — adding a value is always a code change (new adapter branch in `buildImageProvider`) *and* a migration (`ALTER TYPE ... ADD VALUE`), both shipped together. The enum gives `switch(provider.type)` exhaustive checking with no `assertNever`.

| Type | Package | Used for |
|-|-|-|
| `fal` | `@ai-sdk/fal` | fal.ai (seeded by default when `fal_api_key` is configured) |
| `openai_compatible` | `@ai-sdk/openai-compatible` | OpenAI's `/images/generations`, custom inference servers, anything exposing an OpenAI-shaped images endpoint |
| `venice` | hand-rolled (`src/llm/venice.ts`) | Venice.ai's native `/api/v1/image/generate` — supports `safe_mode`, `negative_prompt`, response-header content-policy signals |

The `openai_compatible` adapter calls `provider.imageModel(modelString)` against `${baseURL}/images/generations`. Pin a version of `@ai-sdk/openai-compatible` that exposes `.imageModel()` — verify on upgrade. If a provider's API diverges from the OpenAI shape (bespoke async polling, non-standard size parameter), write a thin `ImageModelV2` (~100 LoC) instead of mangling it through openai-compatible.

### fal.ai (seeded default)

`@ai-sdk/fal`. fal.ai offers the broadest open-source model catalog (Flux, SDXL, Seedream, Ideogram, Qwen — 1000+ models total, with ~6 curated and seeded by default), reasonable pricing ($0.02–$0.04/image, no subscription), and a simple SDK. Seeded via `ensureFalImageDefaults` (`src/setup/seed.ts`) — runs from the wizard after the user provides a `fal_api_key`, and is manually re-runnable.

```typescript
import { fal } from "@ai-sdk/fal";

// Model construction — passed to generateImage()
const model = fal.image("fal-ai/flux/dev");
```

**Auth:** API key stored in `secrets` table (encrypted), referenced by `image_providers.secret_id`. Passed at provider construction via `createFal({ apiKey })`. The `@ai-sdk/fal` package also reads `FAL_KEY` env var as fallback for dev.

**Provider-specific params** go through `providerOptions.fal` at the SDK level:

| Param | Type | Notes |
|-|-|-|
| `numInferenceSteps` | number | Default 28 for Flux Dev |
| `guidanceScale` | number | Default 3.5 |
| `negativePrompt` | string | What to avoid |
| `enableSafetyChecker` | boolean | Default true |
| `outputFormat` | `"jpeg"` \| `"png"` | Default jpeg |

These are escape hatches — not exposed in the tool schema. The LLM shouldn't tune inference hyperparameters; the prompt is the lever.

### Venice.ai (native adapter) `[confirmed]`

Hand-rolled, not via the AI SDK. Venice exposes an OpenAI-compat path (`/v1/images/generations`) **and** a native path (`/api/v1/image/generate`). The OpenAI-compat path strict-rejects Venice's own bespoke knobs (`safe_mode`, `negative_prompt`) with HTTP 400 (`Unrecognized key(s) in object`) — using it would mean dropping Venice's additional parameters. The native path accepts them and surfaces content-policy outcomes via response headers. `VeniceImageProvider` (`src/llm/venice.ts`) wraps it.

**Provider-level defaults** live in `image_providers.attrs.imageGenerationDefaults` — operator policy, not LLM-controlled. The wizard prompts for `safe_mode` (Venice defaults to `true`); the other defaults are reachable via `cogmo image-provider` / direct SQL for finer control.

| Field | Type | Notes |
|-|-|-|
| `safe_mode` | boolean | Venice default `true` (applies a blur); pass `false` to disable blur. When `false`, an `x-venice-is-blurred: true` response is treated as a failed generation. |
| `cfg_scale` | number 0..20 | Classifier-free guidance strength. Lower = looser, higher = tighter. |
| `hide_watermark` | boolean | Strip the Venice watermark (model-dependent). |
| `style_preset` | string | Venice style preset name (e.g. `"Anime"`). Free-form; the upstream list evolves. |

**Negative prompt** is a per-call field on the `generate_image` tool input gated by `image_models.capabilities.negativePrompt`. Venice forwards it directly as the body's `negative_prompt`; fal forwards via `providerOptions.fal.negative_prompt` at the AI SDK boundary; `openai_compatible` drops it (the SDK has no documented surface). Capability-absent models silently drop the field at the tool handler so the LLM contract stays honest: ask for the field, it's forwarded; capability false, it's a no-op.

**Response-header content-policy signals.** Venice emits two boolean headers; the adapter classifies them:

| `x-venice-is-content-violation` | `x-venice-is-blurred` | `safe_mode` (provider default) | Adapter behaviour |
|-|-|-|-|
| `true` | any | any | Throw `ImageGenerationFailedError` (`kind: "moderation_blocked"`). Non-retryable. |
| not `true` | `true` | `true` (or unset → Venice default `true`) | Pass through — operator opted in to blur. |
| not `true` | `true` | explicitly `false` | Throw `ImageGenerationFailedError` (`kind: "blur_unexpected"`). Non-retryable. |
| not `true` | not `true` | any | Pass through — clean response. |

`ImageGenerationFailedError` extends `AbortError` so `withRetry` still treats it as fatal; the `failure` field carries the structured `{ kind, reason, provider }` the tool handler surfaces uniformly across all detection paths.

**Output format pinning.** Venice supports `webp` / `jpeg` / `png` — the adapter pins `png` for parity with fal so downstream (Telegram `sendPhoto`, AttachmentStore) doesn't change behaviour by provider. If a future provider-or-model wants a different output, lift the format into the catalog / tool surface; today it's a hand-tuned adapter invariant.

### Base URL validation

Two layers, for `openai_compatible` and `venice` providers:

- **DB CHECK** (`chk_image_providers_base_url`) enforces per-value implications: `openai_compatible ↔ NOT NULL`, `venice ↔ NOT NULL`, `fal ↔ NULL`. Atomic; can't be bypassed by ad-hoc psql or a future store implementer who forgets.
- **Store guard** (`addImageProvider`) adds URL hygiene the CHECK can't express: must be `https://`, no trailing slash, parseable as a URL. Throws `InvalidProviderConfigError` with a wizard-friendly message.

## Tool Definition `[confirmed]`

The catalog is loaded **per turn** from `image_models WHERE user_selectable = true`, joined with their `image_providers`. The `ImageToolsLoader` (`src/agent/image-tools-loader.ts`) re-queries on every `handle-message` invocation and rebuilds the Zod enum + tool description from the current rows — so wizard / CLI CRUD takes effect on the next message, not the next process restart. Provider adapter instances (`buildImageProvider` output) are memoized inside the loader by row id, so we only decrypt + construct each SDK client once per process; only the catalog rows themselves are re-read each turn (two cheap selects on small tables). The same hot-reload posture is on the roadmap for `LlmProviderResolver` and the voice provider — they share the same fix shape.

```typescript
// src/agent/image-tools.ts

import { generateImage } from "ai";

interface ImageModelRow {
  name: string;                          // LLM-facing key, unique
  modelString: string;                   // API-facing identifier
  description: string;                   // one-line "use when..."
  capabilities: ImageModelCapabilities;  // aspectRatios, seed, future knobs
  providerId: UUID;
}

type ImageProvider =
  | { kind: "fal"; provider: FalProvider }
  | { kind: "oai"; provider: OpenAICompatibleProvider };

function createImageTools(deps: {
  models: ReadonlyArray<ImageModelRow>;
  providers: ReadonlyMap<UUID, ImageProvider>;
  attachments: AttachmentStore;
}): ToolSpec[] {
  if (deps.models.length === 0) return [];   // no models configured → tool not registered

  const modelNames = deps.models.map(m => m.name);
  const modelByName = new Map(deps.models.map(m => [m.name, m]));

  // Union, not intersection — a fixed-size model would otherwise collapse
  // every other model's options. Per-model narrowing happens in the handler.
  const ratioUnion = new Set<string>();
  for (const m of deps.models) for (const r of m.capabilities.aspectRatios ?? []) ratioUnion.add(r);

  const description = buildToolDescription(deps.models);  // includes per-model ratios

  return [defineTool({
    name: "generate_image",
    description,
    durable: true,
    schema: z.object({
      prompt: z.string().min(1),
      model: z.enum(modelNames as [string, ...string[]])
        .default(modelNames[0])
        .describe("Model — choose based on task (see tool description)"),
      aspectRatio: ratioUnion.size > 0
        ? z.enum([...ratioUnion] as [string, ...string[]]).optional()
        : z.undefined(),
      seed: z.number().int().optional(),
    }),
    handler: async (input) => {
      const row = modelByName.get(input.model);
      if (!row) return `Error: unknown model ${input.model}`;
      // Treat absent and [] identically — both mean "model accepts no
      // aspectRatio". Both surface as a text error the LLM can recover from
      // (re-pick a ratio or pick a different model), not as silent drop.
      const supported = row.capabilities.aspectRatios ?? [];
      if (input.aspectRatio && !supported.includes(input.aspectRatio)) {
        const hint = supported.length > 0
          ? `Supported: ${supported.join(", ")}.`
          : "This model does not accept a custom aspect ratio.";
        return `Error: model ${row.name} does not support aspect ratio ${input.aspectRatio}. ${hint}`;
      }
      const provider = deps.providers.get(row.providerId)!;
      const imageModel = provider.kind === "fal"
        ? provider.provider.image(row.modelString)
        : provider.provider.imageModel(row.modelString);
      const shouldForwardAspect = input.aspectRatio && supported.includes(input.aspectRatio);
      const shouldForwardSeed = input.seed !== undefined && row.capabilities.seed === true;
      const { image } = await withRetry(
        () => generateImage({
          model: imageModel,
          prompt: input.prompt,
          ...(shouldForwardAspect && { aspectRatio: input.aspectRatio }),
          ...(shouldForwardSeed && { seed: input.seed }),
        }),
        { retries: 2, context: `image.generate.${row.name}` },
      );
      const path = await deps.attachments.upload(
        Buffer.from(image.uint8Array),
        image.mediaType,
        "generated",
      );
      return JSON.stringify({ path, mediaType: image.mediaType, model: row.name });
    },
  })];
}
```

**Retry semantics:** `generateImage` is wrapped in `withRetry({ retries: 2 })`. The handler classifies provider 4xx errors (400 bad request, 401 unauthorized, 403 forbidden, 422 validation) as `AbortError` via `APICallError.isRetryable === false` — these are futile to retry. 429 (rate limit) and 5xx fall through to the default exponential-backoff retry. This mirrors `web-tools.ts` for transport-level external API calls.

**Closure injection** (like `createWebTools`), not through `Service`. Image generation is a shared capability, not per-user scoped. The provider map and model catalog are loaded at bootstrap and reused across all turns.

**Single image per call.** The tool generates one image. For multiple images, the LLM calls the tool multiple times — it already handles this via the agentic loop. No `n` exposed in the tool schema.

**Tool exposes a small surface.** Only `prompt`, `model`, `aspectRatio`, `seed`. Advanced params (steps, guidance_scale, negative_prompt) are intentionally omitted — the LLM shouldn't tune inference hyperparameters. If the user asks for specific tuning, the prompt description is the right lever.

**Per-model capability narrowing.** The Zod `aspectRatio` enum is the union of `capabilities.aspectRatios` across all user-selectable models. The handler narrows per the picked model and returns text the LLM can act on (re-pick a ratio or a different model) — not an exception. `seed` similarly: handler drops it for models whose `capabilities.seed` is false/absent. The LLM sees per-model support inline in the tool description.

**Reference image (image-to-image / kontext).** Models that accept an existing image — fal/flux-kontext, future fal-2/edit variants — declare `capabilities.imageInput = "required" | "optional"`. The tool schema exposes a `referenceImage: string` field; the value is an `AttachmentStore` path (`inbound/<id>.png` from a user upload, or `generated/<id>.png` from a previous turn the LLM generated). The handler downloads the bytes via `attachments.download(path)` and forwards them through the AI SDK's `prompt: { text, images }` shape — only validated against `kind: "fal"` today (kontext line). For `kind: "oai"` the handler returns a text error pointing the LLM at a fal model; a dedicated `openai` provider type would unlock gpt-image-* edit support later (tracked separately in `todo.md`). Three text-recoverable error shapes are surfaced: required-but-missing (LLM re-calls with a path), supplied-but-unsupported (LLM picks a different model or drops the field), supplied-to-non-fal (LLM picks a fal-backed edit model).

**Storage prefix.** Generated images use the `"generated"` prefix via `attachments.upload(buffer, mediaType, "generated")`. The `AttachmentStore.upload()` signature accepts an optional `prefix` param (default `"inbound"` for backward compatibility).

### Failure detection `[confirmed]`

Image providers sometimes return success with a placeholder image — a solid-color, blurred, or otherwise degraded fallback — when the prompt trips a safety filter or the model produces noise. Surfacing that as a normal-looking image is worse than no image: the user receives garbage and the LLM has no signal to react.

All failure surfaces converge on a single `ImageFailure` shape. The error vocabulary (`ImageFailure`, `ImageFailureKind`, `ImageGenerationFailedError`, `ImageProviderKind`) lives in `src/llm/image-failure.ts` alongside the adapters that throw into it; the post-generation `detectImageFailure` inspector + size-canary live in `src/agent/image-failure.ts` and re-export the shared types so the tool handler and tests pull everything from one place.

```ts
interface ImageFailure {
  kind: "moderation_blocked" | "blur_unexpected" | "placeholder_size" | "provider_error";
  reason: string;          // LLM-facing message
  provider: "fal" | "oai" | "venice";
}
```

`ImageGenerationFailedError(failure, options?)` accepts `ErrorOptions` so adapter-thrown failures can chain the original SDK error as `cause` — matches the `NonRetriableError({ cause: err })` pattern used elsewhere for non-retryable wraps. The APICallError → ImageGenerationFailedError converter in the tool handler chains the wrapped error so its request URL, response body, and status code survive in stack traces.

Two surfaces produce it:

1. **Post-generation inspection** (`detectImageFailure`) runs against a successful `generateImage` response. Returns `{ ok: false, failure }` when:
   - `providerMetadata.fal.images[i].nsfw === true` for any returned image (fal's per-image NSFW flag) → `kind: "moderation_blocked"`. Concept names from `providerMetadata.fal.nsfw_concepts` ride in `reason` when available.
   - `image.uint8Array.byteLength < SUSPICIOUS_SIZE_THRESHOLD_BYTES` (2048 today — real photos are 50KB+; placeholder solids compress to a few hundred bytes) → `kind: "placeholder_size"`. Tunable from production data if false positives appear.

2. **Adapter-thrown** failures (`ImageGenerationFailedError extends AbortError`) come from protocols whose signals aren't in the SDK result object:
   - Venice's `x-venice-is-content-violation: true` response header → `kind: "moderation_blocked"`.
   - Venice's `x-venice-is-blurred: true` when `safe_mode` was explicitly `false` → `kind: "blur_unexpected"`.
   - Venice's non-retryable 4xx (other than 429) → `kind: "provider_error"`.
   - openai-compat 4xx whose body matches `content_policy_violation` / `safety system` (gpt-image-1) → `kind: "moderation_blocked"`. Other non-retryable 4xx → `kind: "provider_error"`.

Both paths converge in the tool handler's `surfaceFailure(failure, row, slug)` helper: it emits one `logger.warn` carrying `{ kind, provider, rowName, providerId, slug, reason }` for operator filtering, and returns `Error: ${reason}` to the LLM. The LLM sees one shape regardless of which surface detected the failure, and can rephrase, switch model, or report back to the user. No bytes touch the attachment store on failure; no Telegram delivery is attempted.

**Non-goal: pixel-level analysis.** No runtime image-processing dependency. Decoding bytes to inspect luminance variance or detect a known-stub bitmap is deferred until production traffic shows a real case the cheap signals miss — the heavy decode dep isn't worth carrying for hypothetical coverage.

**Graceful absence.** If `image_models` has zero `user_selectable` rows, the tool is not registered at all — no "configured but unavailable" middle state. Same intent as the prior `FAL_API_KEY`-missing branch, but cleaner now that the tool's presence is data-driven.

## Outbound Image Delivery `[proposed]`

Current delivery is text-only. Images need two delivery paths because the `DeliveryRouter` partitions sessions by adapter type:

- **Streaming adapters (Telegram):** sessions go through `streamHandles`. Images must be delivered via stream events — `deliverBatch` is never called for these sessions.
- **Batch adapters (non-streaming channels):** sessions go through `batchTargets`. Images delivered after the loop via `deliverBatch(text, images)`.

Both paths share the same extraction logic — a pure function that parses `generate_image` tool results.

### Shared extraction helper

```typescript
// src/agent/extract-images.ts — pure function, used by both paths
function extractGeneratedImages(messages: Message[]): OutboundImageRef[] {
  // Build toolUseId → toolName map first, then filter tool_results by originating tool name.
  // This avoids false positives from other tools that happen to return {path, mediaType} JSON.
  const toolNames = new Map<string, string>();
  for (const msg of messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") toolNames.set(block.id, block.name);
    }
  }

  const images: OutboundImageRef[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      if (toolNames.get(block.toolUseId) !== "generate_image") continue;
      try {
        const parsed = JSON.parse(block.content);
        if (parsed.path && parsed.mediaType) {
          images.push({ path: parsed.path, mediaType: parsed.mediaType });
        }
      } catch { /* not JSON — skip */ }
    }
  }
  return images;
}
```

**Why convention-based extraction over a side-channel:** Alternatives considered — extending `Service` with an output accumulator, extending `ToolHandler` return type to `{ text, images? }`, adding a new `StreamEvent`. All require interface changes across multiple layers. This is a pure function that reads existing data. Scoped to `generate_image` tool specifically (via the toolUseId→name map) — forward-compatible when other tools produce JSON output.

### Streaming delivery (Telegram — primary path)

The streaming adapter receives `tool_result` events during the loop. When the event is from `generate_image`, the stream handle uses the shared `parseGeneratedImagePayload` helper to parse the output JSON, downloads from AttachmentStore, and calls `sendPhoto` mid-stream — before the LLM's final text even arrives.

```typescript
// TelegramStreamHandle — extended
async push(event: StreamEvent): Promise<void> {
  if (event.type === "tool_result" && event.name === "generate_image" && !event.isError) {
    const payload = parseGeneratedImagePayload(event.output);
    if (!payload) return;
    const { path, mediaType } = payload;

    // Dedup on Inngest retry — same runId + path = already sent.
    // Only marked sent AFTER successful sendPhoto so a transient failure
    // leaves the next retry free to deliver.
    const dedupKey = `${this.#runId}:${path}`;
    if (this.#sentImages.has(dedupKey)) return;

    try {
      const bytes = await this.#attachments.download(path);
      await this.#bot.api.sendPhoto(
        this.#chatId,
        new InputFile(bytes, `image.${ext(mediaType)}`),
      );
      this.#sentImages.add(dedupKey);
      // Strip the "🔍 generate_image..." placeholder the tool_start event
      // added — otherwise it lingers in the final text edit alongside the
      // delivered image.
      this.#accumulated = this.#accumulated.replace(/\n?🔍 generate_image\.\.\.\n?/g, "");
    } catch (err) {
      // Per-image failure shouldn't crash the stream; next retry re-tries.
      logger.error({ err, path, runId: this.#runId }, "failed to send generated image");
    }
    return;
  }
  // ... existing text_delta / tool_start handling
}
```

Requires injecting `AttachmentStore` into the Telegram adapter setup. Retry dedup uses the existing `runId` pattern from streaming.md — the in-memory `#sentImages` set survives across Inngest retries in connect mode.

### Batch delivery (non-streaming channels)

For Direct and future batch adapters: `deliverBatch` gains an `images` param, `RenderedMessage` gains `images`.

```typescript
interface OutboundImage {
  data: Buffer;
  mediaType: string;
}

interface DeliveryHandle {
  push(event: StreamEvent): Promise<void>;
  finish(): Promise<void>;
  abort(error: string): Promise<void>;
  deliverBatch(content: string, images?: readonly OutboundImage[]): Promise<void>;
}

interface RenderedMessage {
  text: string;
  parseMode?: "HTML" | "MarkdownV2";
  images?: readonly OutboundImage[];
}
```

Orchestrator, after the agent loop — wrapped in a durable `step.run` so it's exactly-once on Inngest retry and observable in the Inngest UI. `DeliveryHandle.hasBatchTargets()` gates the whole block so streaming-only setups (e.g., Telegram-only) skip the S3 downloads entirely.

```typescript
if (delivery.hasBatchTargets()) {
  await step.run("batch-delivery", async () => {
    const imageRefs = extractGeneratedImages(result.newMessages);

    // Per-image resilience: one S3 miss shouldn't block the rest. Matches
    // the stream handle's swallow-and-log pattern.
    const settled = await Promise.allSettled(
      imageRefs.map(async (ref) => ({
        data: await attachments.download(ref.path),
        mediaType: ref.mediaType,
      })),
    );
    const fulfilled = settled
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value);

    await delivery.deliverBatch(
      result.text,
      fulfilled.length > 0 ? fulfilled : undefined,
    );
    // Return value is small — image bytes flow through the step body in
    // memory but never into Inngest state.
    return { delivered: fulfilled.length, failed: settled.length - fulfilled.length };
  });
}
```

**Why step-wrap this one.** Batch delivery runs *after* the streaming section completes and *after* the assistant message is persisted — a single self-contained side effect with a small JSON result, exactly what a step wants (see [crash-recovery.md](crash-recovery.md)). Wrapping it in `step.run` gives us:

- **Exactly-once semantics** on Inngest retry — no double `sendMessage` / `sendPhoto` to batch adapters
- **Observability** per delivery (timing, success/fail counts surface in the Inngest UI)
- **Small state payload** — the step returns `{ delivered, failed }`, image bytes flow through the body in memory only

Combined with `Promise.allSettled`, one slow/failed S3 download doesn't block the rest of the batch.

**Direct adapter** extends the `directOutbound` event payload with optional `images: Array<{ data: string /* base64 */; mediaType: string }>` — events must serialize, so bytes are base64-encoded. Console clients opt into rendering.

**Web UI (future):** Inline `<img>` tag with base64 data URI or served from AttachmentStore via signed URL.

## Configuration `[confirmed]`

| What | Where | Notes |
|-|-|-|
| Provider credentials | `secrets` table | Encrypted (AES-256-GCM). One row per provider — `fal_api_key`, `venice_api_key`, etc. |
| Provider routing | `image_providers` table | `(name, type, base_url, secret_id, attrs)`. `type` is `pgEnum image_provider_type`. CHECK constraint pins the `base_url` invariant: `openai_compatible ↔ NOT NULL`, `venice ↔ NOT NULL`, `fal ↔ NULL`. `attrs.imageGenerationDefaults` carries provider-level call defaults (`safe_mode`, `cfg_scale`, etc. — see ImageGenerationDefaultsSchema). |
| Model catalog | `image_models` table | `(name, model_string, description, capabilities, user_selectable, provider_id)`. `name` is the LLM-facing key (`UNIQUE`), `model_string` is the API-facing identifier, `description` is read by the LLM at every turn, `capabilities` validated by `ImageModelCapabilitiesSchema` at the store boundary. |
| fal defaults | `ensureFalImageDefaults` (`src/setup/seed.ts`) | Idempotent (`ON CONFLICT (name) DO NOTHING`). Wizard calls it after `fal_api_key` is provided; manually re-runnable. User edits to existing rows are preserved on re-run. |

### Why two tables instead of one

The same provider serves many models; routing (`type`, `base_url`, `secret_id`) changes for operational reasons (key rotation, base URL move) independently of the catalog. Splitting matches the `llm_providers` / `model_providers` precedent and lets the wizard rotate a key without re-entering every model.

### Why no `model_providers`-style routing table

Image gen has no fallback chain (see [Fallback decision](#decisions)). One model = one provider. The relationship lives directly on `image_models.provider_id` with no position column — adding a "second provider for the same model" is just adding another `image_models` row with a different `name` pointing at the alternate provider.

### Why `name` separate from `model_string`

The identifier the provider API expects is provider-specific (`fal-ai/flux/dev` for fal, `flux-dev` for Venice). The LLM-facing key needs to be (a) globally unique across the operator's catalog, (b) stable across `model_string` changes the provider might make, (c) self-describing in logs. Two columns gives the wizard freedom to pick a clean `name` (e.g. `fal/flux-dev`, `venice/flux-dev`) while `model_string` matches whatever the provider expects.

### Why `capabilities JSONB`, not separate columns

Aspect ratio support varies across providers (Venice's `image_size` presets, recraft-v3's fixed sizes, future 21:9 cinematic). Seed support varies. Future knobs (image-to-image, negative prompt, max prompt length, output mediaType) will land as new providers do. A `capabilities` JSONB bag validated by `ImageModelCapabilitiesSchema` absorbs all of these without further migrations — same pattern as `profiles.memory_scope`, `coding_tasks.worktree_assignment`.

### Adding a provider via the wizard

The wizard surfaces two distinct entry points:

- **`stepConfigureOptionalTools`** handles fal — a single `fal_api_key` prompt. The boot-time `ensureFalImageDefaults` seed wires the canonical 9-model catalog automatically, so the wizard doesn't ask the operator to pick fal models one by one.
- **`stepConfigureImageProviders`** (`src/setup/wizard.ts`) handles `openai_compatible` and `venice` providers — Venice.ai (native API), OpenAI dall-e, custom inference servers. Asks for the provider type first, then prompts for name + base URL + API key (+ `safe_mode` default when type=venice), then loops "add a model? (name, model_string, description, ratios, seed, image-input, negative-prompt)" until the operator declines. Same domain functions back the `cogmo image-provider` / `cogmo image-model` CLI commands — no behaviour drift between wizard and CLI.

Both surfaces are hot-reload-aware: changes take effect on the next message turn, not on process restart.

Deleting an `image_providers` row cascades to its `image_models`. Deleting an `image_models` row removes it from the live tool catalog without affecting historical messages — `messages.content` carries the tool call by `name` only, not by FK.

### Profile integration

Image generation is a tool — profiles control it via `tool_set`. If `generate_image` is in the profile's `toolSet` (or matched by a glob), the agent can generate images. If not, it can't. No new profile column needed.

## Adding more providers

Anything with an OpenAI-shaped `/images/generations` endpoint (OpenAI dall-e, custom inference servers) → wizard flow as `openai_compatible`. Venice.ai → `venice` (its native API ships features the OpenAI-compat path rejects). Anything bespoke (different async pattern, non-standard size parameter) → new `image_provider_type` enum value + adapter branch in `buildImageProvider`, then the same wizard flow.

## Testing `[confirmed]`

Three tiers, same pattern as the rest of the codebase.

| Tier | What | Mock strategy |
|-|-|-|
| **Unit** | `image-tools.ts`, `extract-images.ts`, Telegram stream handle image path | `vi.mock('ai')` returning a fixed fake `{ image: { uint8Array, mediaType } }`. Mock `AttachmentStore`. |
| **Integration** | `handle-message` with a `generate_image` tool_use fixture — orchestrator extracts, downloads, delivers | llmock fixture triggers the tool call; fal HTTP calls intercepted via **fal-mock** (see below) |
| **E2E** | Deferred — integration covers the full pipeline; e2e would duplicate without adding signal | — |

### fal-mock — scoped `fetch` interceptor for fal.ai

llmock (`@copilotkit/aimock`) is LLM-API-specific (Anthropic Messages, OpenAI chat/embeddings) — it doesn't support fal.ai's endpoints or CDN downloads. We add a mock that intercepts fal HTTP traffic specifically, **without patching global `fetch`**.

**Design:** `createFalFetch({ mode, fixturePath })` returns a function with fetch signature. Pass it to `createFal({ fetch })` via `BootstrapOptions.falFetchOverride` in tests. The wrapper handles fal endpoints; everything else delegates to `globalThis.fetch`, so the Anthropic SDK (through llmock), Hindsight, MinIO, Inngest — all untouched.

**Why not MSW:** MSW patches `globalThis.fetch` process-wide. When we tried it, `onUnhandledRequest: "bypass"` was not transparent for the Anthropic SDK's streaming requests going through llmock — auth headers came back mangled even with a valid key. A library-scoped `fetch` option eliminates this class of interaction. Prefer per-library fetch injection over global patching when the library supports it; MSW is the fallback when it doesn't.

**Layout:**
```
src/test/fal-mock.ts                     # createFalFetch() — record/replay
test/fixtures/fal/
  fal-ai-flux-dev-{hash}.json            # captured fal response (URL rewritten to mock CDN)
  fal-ai-flux-dev-{hash}.jpg             # captured image bytes
test/fixtures/recorded/
  anthropic-image-gen.json               # hand-written llmock fixture (multi-turn)
```

**Fixture key:** `{model-slug}-{sha256(model:prompt:image_size:seed):12}`. Stable across runs for same input, collision-safe across different inputs. `image_size` is fal's native request field (string preset like `"landscape_16_9"` or `{width, height}` object); we normalize to a stable string before hashing.

**Modes:**
- **Replay (default, CI):** handler loads `{key}.json` from disk, returns it (with pre-rewritten mock CDN URL `https://fal.media-mock.test/{key}.{ext}`). The SDK then fetches that URL, which routes back to the same handler and returns `{key}.{ext}` bytes. Unmatched fal URLs return 503 (strict).
- **Record (local, `RECORD=1 FAL_API_KEY=...`):** handler passes through to real fal, captures response, downloads CDN image bytes, writes both fixtures with URL rewritten, returns rewritten response to the SDK. Replay-ready immediately.

### Multi-turn tool flows via llmock's `sequenceIndex`

llmock's Anthropic→ChatCompletion conversion turns tool_result user messages into role=`tool`, so the **original user question remains the "last user message"** on every iteration. Without intervention this causes the tool fixture to match forever until the 20-iteration cap — producing 20 generate_image calls, 20 S3 uploads, and a 3 MB `directOutbound` event that exceeds Inngest's size limit.

**Fix:** hand-written fixture with `match.sequenceIndex` — fixtures with the same `userMessage` match in order of invocation:

```json
{
  "fixtures": [
    { "match": { "userMessage": "draw me a cat in a hat", "sequenceIndex": 0 },
      "response": { "toolCalls": [{ "name": "generate_image", "arguments": "...", "id": "..." }] } },
    { "match": { "userMessage": "draw me a cat in a hat", "sequenceIndex": 1 },
      "response": { "content": "Here's your cat in a hat!" } }
  ]
}
```

First call → tool_use. Second call → final text. Loop ends cleanly.

### Record workflow

```
# First time / after prompt changes (credentials live in .env):
pnpm test:record

# Subsequent (CI, normal dev):
pnpm test:integration
```

Commit `test/fixtures/fal/*` and `test/fixtures/recorded/*`. Embedding calls (Hindsight auto-recall) auto-record as OpenAI fixtures.

## Dependencies

| Package | Purpose | Size | Status |
|-|-|-|-|
| `ai` | Vercel AI SDK core (`generateImage`) | ~200KB | Required (runtime dep) |
| `@ai-sdk/fal` | fal.ai provider adapter | ~few KB | Required (runtime dep) |
| `@ai-sdk/openai-compatible` | OpenAI-shaped images endpoint adapter (OpenAI, custom inference servers) | ~few KB | Required (runtime dep). Pin a version that exposes `.imageModel()` — verify on upgrade. |
| (none — hand-rolled) | Venice.ai native adapter | — | Lives at `src/llm/venice.ts`. No external SDK because Venice's native shape (response-header content-policy signals, base64 inline images) doesn't fit a generic adapter. |

The `ai` package also exports `generateText`/`streamText` which we don't use for text LLMs (see rationale above). Tree-shaking eliminates unused code paths at build time.

## Decisions

| Decision | Choice | Rationale |
|-|-|-|
| Abstraction layer | Vercel AI SDK `generateImage()` | Image gen is simple request/response — no streaming, caching, or token counting. AI SDK covers 12+ providers with zero adapter code. Adding a provider = `pnpm add @ai-sdk/<name>`. Own interface would replicate what the SDK already does. |
| Not for text LLMs | Keep raw `LlmProvider` wrappers | Missing `countTokens` (PR #12176 open, not merged), thinking signature bug (#11602), different content block model requiring mapping layer. Revisit when these are resolved. |
| First provider | fal.ai via `@ai-sdk/fal` | 1000+ models, $0.02-$0.04/image, good SDK, queue system. Best breadth for open-source models. |
| Tool injection | Closure (`createImageTools(model, store)`) | Same as `createWebTools`. Not per-user scoped — no need for `Service` namespace. |
| Image extraction | Convention-based (parse tool results) | Pure function, no interface changes. Replace when a second tool produces non-text output. |
| Delivery — streaming channels | Mid-stream via `tool_result` event | Telegram is a streaming adapter — `DeliveryRouter` partitions its sessions into `streamHandles`, `deliverBatch` is never called. Mid-stream delivery via existing `tool_result` event (parsed by adapter) is the only path that reaches Telegram users. Dedup on `runId + path`. |
| Delivery — batch channels | `deliverBatch(text, images)` wrapped in `step.run("batch-delivery")` | Non-streaming adapters (Direct, future) get images via extended `deliverBatch`. Step-wrap gives exactly-once semantics on Inngest retry + observability; small return value (`{ delivered, failed }`) keeps state lean. `hasBatchTargets()` gate skips S3 downloads entirely for streaming-only setups. `Promise.allSettled` for per-image resilience. |
| No new `StreamEvent` type | Reuse existing `tool_result` event | Adapter recognizes `name === "generate_image"`, parses output JSON. Zero changes to agent loop or tool handler signatures. |
| Catalog storage | `image_providers` + `image_models` tables, `pgEnum` for `type` | User-defined models without redeploy. Mirrors `llm_providers` precedent. Wizard manages the rows. Adding a new provider type is always a code change *and* a migration anyway, so enum vs text costs the same and the enum gives exhaustive `switch` checking. |
| OpenAI-compat second provider type | `@ai-sdk/openai-compatible` with per-provider `baseURL` | Venice's image endpoint is OpenAI-shaped; the AI SDK adapter covers it without bespoke code. Custom `ImageModelV2` is the fallback for non-OAI-shaped endpoints. |
| Per-model capabilities | `capabilities JSONB` validated by `ImageModelCapabilitiesSchema` | Aspect ratio support varies across providers/models; future knobs (seed, image input, negative prompt, max prompt length) land without migrations. Tool description lists per-model ratios; handler narrows the LLM's pick per model and returns text errors the LLM can recover from. Zod-validated at the store boundary on read and write. |
| Tool surface | prompt, model (enum), aspectRatio, seed | LLM picks model per-call from the configured user-selectable catalog. Inference hyperparameters omitted — prompt is the lever. |
| Storage prefix | `generated/` for tool output | AttachmentStore `upload()` gains optional `prefix` param (default `"inbound"`). Backward compatible. |
| Test mock | Scoped `fetch` interceptor (`createFalFetch`) passed via `createFal({ fetch })` | llmock is LLM-API-specific and can't cover fal. MSW was tried first but `onUnhandledRequest: "bypass"` mangled Anthropic streaming auth headers through llmock. Per-library fetch injection via the SDK's own `fetch` option avoids that class of interaction and touches nothing outside fal. Record/replay fixtures follow llmock's spirit. |
