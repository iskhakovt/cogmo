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
  "fal-ai/flux/dev",
  "fal-ai/flux-pro/v1.1",
  "fal-ai/ideogram/v2",
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
        "- `fal-ai/flux/dev` — fast, cheap, general use (default)\n" +
        "- `fal-ai/flux-pro/v1.1` — high quality, detailed scenes/portraits\n" +
        "- `fal-ai/ideogram/v2` — best for images containing text, logos, typography\n" +
        "- `fal-ai/flux-pro/kontext` — image editing (requires reference image)\n\n" +
        "Be specific and detailed in the prompt — describe style, composition, colors, mood.",
      schema: z.object({
        prompt: z.string().describe("Detailed image description"),
        model: z.enum(MODEL_CATALOG).default("fal-ai/flux/dev")
          .describe("Model — choose based on task (see tool description)"),
        aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).optional()
          .describe("Aspect ratio. Default 1:1."),
        seed: z.number().optional().describe("Seed for reproducibility"),
      }),
      handler: async (input) => {
        if (!fal) return "Error: generate_image is not configured (FAL_API_KEY missing).";

        const { image } = await generateImage({
          model: fal.image(input.model),
          prompt: input.prompt,
          ...(input.aspectRatio && { aspectRatio: input.aspectRatio }),
          ...(input.seed !== undefined && { seed: input.seed }),
        });

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

The streaming adapter receives `tool_result` events during the loop. When the event is from `generate_image`, the stream handle parses the output JSON, downloads from AttachmentStore, and calls `sendPhoto` mid-stream — before the LLM's final text even arrives.

```typescript
// TelegramStreamHandle — extended
async push(event: StreamEvent): Promise<void> {
  if (event.type === "tool_result" && event.name === "generate_image" && !event.isError) {
    const { path, mediaType } = JSON.parse(event.output);

    // Dedup on Inngest retry — same runId + path = already sent
    const dedupKey = `${this.#runId}:${path}`;
    if (this.#sentImages.has(dedupKey)) return;
    this.#sentImages.add(dedupKey);

    const bytes = await this.#attachments.download(path);
    await this.#bot.api.sendPhoto(
      this.#chatId,
      new InputFile(bytes, `image.${ext(mediaType)}`),
    );
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

Orchestrator, after the agent loop:

```typescript
const generatedImageRefs = extractGeneratedImages(result.newMessages);
const outboundImages = await Promise.all(
  generatedImageRefs.map(async ({ path, mediaType }) => ({
    data: await attachments.download(path),
    mediaType,
  })),
);
await delivery.deliverBatch(result.text, outboundImages.length > 0 ? outboundImages : undefined);
```

The `deliverBatch` path is a no-op for streaming-only sessions (empty `batchTargets`). Images only fire for non-streaming adapters.

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

## Testing `[proposed]`

Three tiers, same pattern as the rest of the codebase.

| Tier | What | Mock strategy |
|-|-|-|
| **Unit** | `image-tools.ts`, `extract-images.ts`, Telegram stream handle image path | `vi.mock('ai')` returning a fixed fake `{ image: { uint8Array, mediaType } }`. Mock `AttachmentStore`. |
| **Integration** | `handle-message` with a `generate_image` tool_use fixture — orchestrator extracts, downloads, delivers | llmock fixture triggers the tool call; fal HTTP calls mocked via **fal-mock** (see below) |
| **E2E** | Real fal.ai call with recorded fixtures in CI, live key locally | fal-mock for CI, `FAL_API_KEY` for record mode |

### fal-mock — MSW fixtures for fal.ai

llmock (`@copilotkit/aimock`) is LLM-API-specific (Anthropic Messages, OpenAI chat/embeddings) — it doesn't support fal.ai's queue/subscribe endpoints or CDN downloads. We add a separate MSW-based mock that follows the same record/replay pattern.

**Layout:**
```
src/test/fal-mock.ts              # MSW handlers + record/replay logic
test/fixtures/fal/
  flux-dev-simple.json            # captured fal.run response (sans image)
  flux-dev-simple.png             # small reference image (~1-5 KB)
```

**Modes:**
- **Replay (default, CI):** MSW intercepts fal.ai + CDN URLs, serves from fixtures. Unmatched requests return 503 (strict mode — same guarantee as llmock).
- **Record (local):** `RECORD=1 FAL_API_KEY=... pnpm test:e2e` — real HTTP, captures response JSON + saves reference image, writes fixture.

**Why not extend aimock upstream:** fal.ai's async queue pattern + CDN-hosted image URLs don't map to aimock's LLM-specific abstractions. Contributing would be a real project (image/audio providers are a broader roadmap concern). Separate mock is shippable today; consider upstream contribution when non-LLM provider coverage grows.

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
| Delivery — batch channels | `deliverBatch(text, images)` | Non-streaming adapters (Direct, future) get images via extended `deliverBatch`. Shared `extractGeneratedImages` helper with streaming path. |
| No new `StreamEvent` type | Reuse existing `tool_result` event | Adapter recognizes `name === "generate_image"`, parses output JSON. Zero changes to agent loop or tool handler signatures. |
| Config (v0) | Secret + hardcoded model catalog | No table until operators need to customize. YAGNI. |
| Tool surface | prompt, model (enum), aspectRatio, seed | LLM picks model per-call from curated shortlist. Inference hyperparameters omitted — prompt is the lever. |
| Model selection | Per-call, curated enum in tool schema | fal.ai has 1000+ models — Flux Pro for portraits, Ideogram for text, etc. The LLM must choose per task. Hardcoded `MODEL_CATALOG` constant for v0; DB-backed when operator customization matters. |
| Storage prefix | `generated/` for tool output | AttachmentStore `upload()` gains optional `prefix` param (default `"inbound"`). Backward compatible. |
| Test mock | Separate MSW-based fal-mock | llmock is LLM-API-specific; extending it for fal's queue/CDN pattern is a larger project. Record/replay fixtures follow the same spirit. |
