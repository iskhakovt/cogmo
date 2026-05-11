# Image Generation `[proposed]`

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

## Provider: fal.ai `[proposed]`

First provider via `@ai-sdk/fal`. fal.ai offers the best combination of model breadth (1000+ models including Flux, SDXL, Seedream, Ideogram, Qwen), speed, simple SDK, and reasonable pricing ($0.02–$0.04/image, no subscription).

```typescript
import { fal } from "@ai-sdk/fal";

// Model construction — passed to generateImage()
const model = fal.image("fal-ai/flux/dev");
```

**Auth:** fal.ai API key stored in `secrets` table (encrypted). Passed at provider construction via `createFal({ apiKey })`. The `@ai-sdk/fal` package also reads `FAL_KEY` env var as fallback for dev.

**Provider-specific params** go through `providerOptions.fal`:

| Param | Type | Notes |
|-|-|-|
| `numInferenceSteps` | number | Default 28 for Flux Dev |
| `guidanceScale` | number | Default 3.5 |
| `negativePrompt` | string | What to avoid |
| `enableSafetyChecker` | boolean | Default true |
| `outputFormat` | `"jpeg"` \| `"png"` | Default jpeg |

These are available as escape hatches but not exposed in the tool schema — the LLM shouldn't tune inference hyperparameters.

## Tool Definition `[proposed]`

```typescript
// src/agent/image-tools.ts

import { generateImage } from "ai";
import type { FalProvider } from "@ai-sdk/fal";

/** Curated model catalog — hardcoded for v0, promote to DB when operators need it. */
const MODEL_CATALOG = [
  "fal-ai/flux/schnell",
  "fal-ai/flux/dev",
  "fal-ai/flux-pro/v1.1",
  "fal-ai/flux-pro/v1.1-ultra",
  "fal-ai/imagen4/preview",
  "fal-ai/recraft/v3/text-to-image",
  "fal-ai/ideogram/character",
  "fal-ai/qwen-image",
  "fal-ai/flux-pro/kontext",
] as const;

function createImageTools(
  fal: FalProvider | undefined,
  attachments: AttachmentStore,
): ToolSpec[] {
  return [
    defineTool({
      name: "generate_image",
      description:
        "Generate an image from a text description. Returns the image to the user.\n\n" +
        "Choose the model based on task:\n" +
        "- `fal-ai/flux/schnell` — fastest, cheapest, drafts\n" +
        "- `fal-ai/flux/dev` — balanced speed/quality (default)\n" +
        "- `fal-ai/flux-pro/v1.1` / `-ultra` — high quality scenes and portraits\n" +
        "- `fal-ai/imagen4/preview` — Google Imagen 4, photorealism + typography\n" +
        "- `fal-ai/recraft/v3/text-to-image` — readable text, logos, vector/illustration, brand colors\n" +
        "- `fal-ai/ideogram/character` — character consistency across images, strong typography\n" +
        "- `fal-ai/qwen-image` — autoregressive, complex text rendering and prompt adherence\n" +
        "- `fal-ai/flux-pro/kontext` — image editing (requires reference image)\n\n" +
        "Be specific and detailed in the prompt — describe style, composition, colors, mood.",
      schema: z.object({
        prompt: z.string().min(1).describe("Detailed image description"),
        model: z.enum(MODEL_CATALOG).default("fal-ai/flux/dev")
          .describe("Model — choose based on task (see tool description)"),
        aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).optional()
          .describe("Aspect ratio. Default 1:1."),
        seed: z.number().int().optional().describe("Seed for reproducibility"),
      }),
      handler: async (input) => {
        if (!fal) return "Error: generate_image is not configured (FAL_API_KEY missing).";

        // Wrap in withRetry — fal returns transient 5xx and 429s. 4xx
        // (400/401/403/422) are classified as AbortError so withRetry
        // stops immediately rather than burning the retry budget.
        const { image } = await withRetry(
          () => generateImage({
            model: fal.image(input.model),
            prompt: input.prompt,
            ...(input.aspectRatio && { aspectRatio: input.aspectRatio }),
            ...(input.seed !== undefined && { seed: input.seed }),
          }),
          { retries: 2, context: "fal.generateImage" },
        );

        const buffer = Buffer.from(image.uint8Array);
        const path = await attachments.upload(buffer, image.mediaType, "generated");

        return JSON.stringify({
          path,
          mediaType: image.mediaType,
          model: input.model,
        });
      },
    }),
  ];
}
```

**Retry semantics:** `generateImage` is wrapped in `withRetry({ retries: 2 })`. The handler classifies fal's 4xx errors (400 bad request, 401 unauthorized, 403 forbidden, 422 validation) as `AbortError` — these are futile to retry. 429 (rate limit) and 5xx fall through to the default exponential-backoff retry. This mirrors `web-tools.ts` for transport-level external API calls.

**Closure injection** (like `createWebTools`), not through `Service`. Image generation is a shared capability, not per-user scoped. The fal provider factory and attachment store are injected at bootstrap, reused across all turns.

**Single image per call.** The tool generates one image. For multiple images, the LLM calls the tool multiple times — it already handles this via the agentic loop. No `n` exposed in the tool schema.

**Tool exposes a small surface.** Only `prompt`, `model`, `aspectRatio`, `seed`. Advanced params (steps, guidance_scale, negative_prompt) are intentionally omitted — the LLM shouldn't tune inference hyperparameters. If the user asks for specific tuning, the prompt description is the right lever.

**Model selection per-call from a curated enum.** fal.ai has 1000+ models — we expose 4-6 curated choices via a Zod enum, with one-line "use when..." guidance in the tool description. The LLM picks per-request based on task (text rendering → Ideogram, detailed portrait → Flux Pro). Hardcoded `MODEL_CATALOG` constant for v0; promote to DB when operator-level customization matters. The constructed `fal.image(modelId)` call happens inside the handler, not at bootstrap.

**Storage prefix.** Generated images use the `"generated"` prefix via `attachments.upload(buffer, mediaType, "generated")`. The `AttachmentStore.upload()` signature gains an optional `prefix` param (default `"inbound"` for backward compatibility).

**Graceful degradation.** If `FAL_API_KEY` is missing, the tool is still registered but the handler returns a helpful error. Same pattern as `web_search`/`web_answer` — keeps the LLM informed about what's unavailable rather than silently lacking the capability.

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

**Why step-wrap this one.** The streaming section of `handle-message` is explicitly non-durable (you can't stream out of `step.run`) — see [crash-recovery.md](crash-recovery.md). Batch delivery runs *after* the streaming section completes and *after* the assistant message is persisted, so it doesn't inherit the streaming constraint. Wrapping it in `step.run` gives us:

- **Exactly-once semantics** on Inngest retry — no double `sendMessage` / `sendPhoto` to batch adapters
- **Observability** per delivery (timing, success/fail counts surface in the Inngest UI)
- **Small state payload** — the step returns `{ delivered, failed }`, image bytes flow through the body in memory only

Combined with `Promise.allSettled`, one slow/failed S3 download doesn't block the rest of the batch.

**Direct adapter** extends the `directOutbound` event payload with optional `images: Array<{ data: string /* base64 */; mediaType: string }>` — events must serialize, so bytes are base64-encoded. Console clients opt into rendering.

**Web UI (future):** Inline `<img>` tag with base64 data URI or served from AttachmentStore via signed URL.

## Configuration `[proposed]`

### v0: minimal

| What | Where | Notes |
|-|-|-|
| fal.ai API key | `secrets` table | Encrypted. Referenced by name during bootstrap. |
| Default model | Environment or hardcoded | `fal-ai/flux/dev` as default. |
| Provider package | Code-level | Only `@ai-sdk/fal` installed. No runtime dispatch needed. |

No `image_providers` table for v0. The `ImageModel` is constructed at bootstrap from a secret lookup + hardcoded model string. Table earns its keep when a second provider arrives.

### Future: provider table

When multiple image providers are needed, follow the `llm_providers` pattern:

```sql
image_providers (
  id            UUID v7 PK,
  name          TEXT NOT NULL UNIQUE,       -- 'fal', 'openai', 'bfl'
  type          TEXT NOT NULL,              -- adapter discriminator
  base_url      TEXT,                       -- NULL = SDK default
  secret_id     UUID NOT NULL FK -> secrets,
  attrs         JSONB NOT NULL,             -- provider-specific config (default model, etc.)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

No `model_providers`-style routing table for images — image model selection is per-call (the LLM or user chooses), not per-profile. A simple default model in `attrs` suffices.

### Profile integration

Image generation is a tool — profiles control it via `tool_set`. If `generate_image` is in the profile's `toolSet`, the agent can generate images. If not, it can't. No new profile column needed.

## Future Providers

Adding a provider = `pnpm add @ai-sdk/<provider>`, construct the model, pass to `createImageTools`. Tool and delivery layers unchanged.

| Provider | AI SDK Package | Notes |
|-|-|-|
| fal.ai (v0) | `@ai-sdk/fal` | 1000+ models. Flux, SDXL, Seedream, Ideogram, Qwen. |
| OpenAI | `@ai-sdk/openai` | gpt-image-1. `openai.image("gpt-image-1")`. |
| Black Forest Labs | `@ai-sdk/black-forest-labs` | FLUX models direct. flux-kontext, flux-pro. |
| Together AI | `@ai-sdk/togetherai` | Flux variants, SDXL. |
| Google (Imagen) | `@ai-sdk/google` | Imagen 4 via Vertex AI. |
| Replicate | `@ai-sdk/replicate` | flux-schnell, recraft-v3. |
| xAI | `@ai-sdk/xai` | Grok Imagine. |

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
| `ai` | Vercel AI SDK core (`generateImage`) | ~200KB | Required (new runtime dep) |
| `@ai-sdk/fal` | fal.ai provider adapter | ~few KB | Required (new runtime dep) |

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
| Config (v0) | Secret + hardcoded model catalog | No table until operators need to customize. YAGNI. |
| Tool surface | prompt, model (enum), aspectRatio, seed | LLM picks model per-call from curated shortlist. Inference hyperparameters omitted — prompt is the lever. |
| Model selection | Per-call, curated enum in tool schema | fal.ai has 1000+ models — Flux Pro for portraits, Ideogram for text, etc. The LLM must choose per task. Hardcoded `MODEL_CATALOG` constant for v0; DB-backed when operator customization matters. |
| Storage prefix | `generated/` for tool output | AttachmentStore `upload()` gains optional `prefix` param (default `"inbound"`). Backward compatible. |
| Test mock | Scoped `fetch` interceptor (`createFalFetch`) passed via `createFal({ fetch })` | llmock is LLM-API-specific and can't cover fal. MSW was tried first but `onUnhandledRequest: "bypass"` mangled Anthropic streaming auth headers through llmock. Per-library fetch injection via the SDK's own `fetch` option avoids that class of interaction and touches nothing outside fal. Record/replay fixtures follow llmock's spirit. |
