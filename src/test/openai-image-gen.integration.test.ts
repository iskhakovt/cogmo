/// <reference path="../../test/vitest.d.ts" />

/**
 * OpenAI `gpt-image-1` via the `openai_compatible` adapter — recorded fixture replay.
 *
 * Pins our `buildImageProvider` + `createImageTools` handler against an
 * actual recorded OpenAI Images API response. Same shape as
 * `src/test/xai-grok.integration.test.ts` (PR #219) — the request is
 * routed through the shared llmock (`inject("llmockBaseUrl")`) which already
 * supports `/v1/images/generations` natively (see
 * `@copilotkit/aimock/dist/images.cjs`). No new mock infrastructure needed.
 *
 * **Recording the fixture** (run once locally; commit the result):
 *
 * ```bash
 * RECORD=1 OPENAI_API_KEY=sk-... \
 *   pnpm test:integration src/test/openai-image-gen.integration.test.ts
 * ```
 *
 * llmock's `record.providers.openai` mapping proxies through to
 * `https://api.openai.com` and journals the response to
 * `test/fixtures/recorded/openai-*.json`. Subsequent CI runs replay against
 * the captured fixture — no API key, no cost, no network.
 *
 * The wire-format coverage is the point: if the AI SDK's
 * `@ai-sdk/openai-compatible` adapter ever changes how it builds the
 * `POST /v1/images/generations` request body, or how it parses the
 * `data[0].b64_json` response, this test catches it on the next refresh.
 */

import { describe, expect, inject, it, vi } from "vitest";
import {
  createImageTools,
  type GeneratedImagePayload,
  imageModelSlug,
  parseGeneratedImagePayload,
} from "../agent/image-tools.js";
import type { Service } from "../agent/service.js";
import type { ImageModelWithProvider, ImageProviderRow } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import { buildImageProvider } from "../llm/image-providers.js";
import type { SecretsStore } from "../secrets/store/index.js";
import type { AttachmentStore } from "../transport/attachment-store.js";

/**
 * Keep this prompt stable across re-records — llmock matches fixtures by
 * `(model, prompt)` after `requestTransform` normalization, so changing the
 * string here means the existing fixture stops matching.
 */
const PROMPT = "A serene watercolor mountain landscape at golden hour, soft brushstrokes.";
// dall-e-3 (not gpt-image-1/2): `@ai-sdk/openai-compatible` sends
// `response_format` on every image request — a dall-e-era field. The
// gpt-image-* line uses `output_format` instead and rejects unknown
// params with HTTP 400 ("Unknown parameter: 'response_format'"). dall-e-3
// accepts the SDK's defaults, is still publicly available, and exercises
// the same wire shape this test exists to pin (POST
// /v1/images/generations + `data[0].b64_json` response). When operators
// want gpt-image-* they should configure a dedicated `openai` adapter
// rather than the generic `openai_compatible` one — tracked separately.
const MODEL_STRING = "dall-e-3";
const MODEL_NAME = "openai/dall-e-3";
const PROVIDER_ID = "test-provider-openai-images";

const FAKE_TX: Transactor = async (cb) => cb({} as never);

describe("openai-compatible image gen — OpenAI dall-e-3 (recorded)", () => {
  it("generates an image end-to-end through buildImageProvider → llmock fixture", async () => {
    const llmockBaseUrl = inject("llmockBaseUrl");
    // Real key forwarded only in record mode — replay never touches the
    // network. Same convention as `pipeline.integration.test.ts`'s voice +
    // anthropic key handling.
    const apiKey =
      process.env.RECORD === "1" ? (process.env.OPENAI_API_KEY ?? "") : "test-openai-key";
    if (process.env.RECORD === "1" && !apiKey) {
      throw new Error("RECORD=1 requires OPENAI_API_KEY to capture image fixtures");
    }

    const providerRow: ImageProviderRow = {
      id: PROVIDER_ID,
      name: "openai",
      type: "openai_compatible",
      // llmock URLs end with `/v1` — the shared integration setup wires the
      // suffix on so OpenAI-shape SDKs hit `/v1/images/generations` directly.
      baseUrl: `${llmockBaseUrl}/v1`,
      secretId: "sec-test",
      attrs: {},
    };

    const secretsStore: SecretsStore = {
      getSecretById: vi.fn().mockResolvedValue(apiKey),
    } as unknown as SecretsStore;

    const provider = await buildImageProvider(providerRow, {
      runInTx: FAKE_TX,
      secretsStore,
    });
    expect(provider.kind).toBe("oai");

    const modelEntry: ImageModelWithProvider = {
      id: "model-test",
      providerId: PROVIDER_ID,
      name: MODEL_NAME,
      modelString: MODEL_STRING,
      description: "OpenAI dall-e-3 — photorealistic, supports custom sizes",
      // No `aspectRatios` in capabilities — the tool handler skips
      // `aspectRatio` when capabilities don't advertise it, and the SDK
      // defaults to dall-e-3's native 1024x1024 size.
      capabilities: {},
      userSelectable: true,
      provider: providerRow,
    };

    const uploadedBuffers: Buffer[] = [];
    const upload = vi.fn(async (buffer: Buffer, mediaType: string, _prefix?: string) => {
      uploadedBuffers.push(buffer);
      return `generated/openai-image-${uploadedBuffers.length}.${mediaType.split("/")[1] ?? "png"}`;
    });
    const attachments: AttachmentStore = {
      upload,
      download: vi.fn(),
      delete: vi.fn(),
      has: vi.fn().mockResolvedValue(true),
      sign: vi.fn(),
    } as unknown as AttachmentStore;

    const [tool] = createImageTools({
      models: [modelEntry],
      providers: new Map([[PROVIDER_ID, provider]]),
      attachments,
    });
    expect(tool).toBeDefined();

    // The tool's `model` enum exposes the slug (slash-free, for xAI
    // grammar-compiler compatibility); the payload's `model` field carries
    // the canonical row name. See PR #240.
    const result = await tool!.handler(
      { prompt: PROMPT, model: imageModelSlug(MODEL_NAME) },
      {} as Service,
    );

    const parsed = parseGeneratedImagePayload(result);
    expect(parsed).not.toBeNull();
    const payload = parsed as GeneratedImagePayload;
    expect(payload.path).toMatch(/^generated\/openai-image-\d+\./);
    expect(payload.mediaType).toMatch(/^image\//);
    expect(payload.model).toBe(MODEL_NAME);

    // Fixture round-trips a non-empty image buffer. The committed fixture is
    // a stubbed 1x1 transparent PNG (~70 bytes) — wire-shape pinning is the
    // goal here, not pixel-level fidelity. A fresh recording via
    // `RECORD=1 OPENAI_API_KEY=…` captures the real ~2MB PNG; trim it back
    // to the 1x1 stub before committing to keep git history small.
    expect(upload).toHaveBeenCalledTimes(1);
    expect(uploadedBuffers[0]?.byteLength).toBeGreaterThan(50);
  });
});
