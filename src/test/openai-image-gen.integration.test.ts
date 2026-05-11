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
const MODEL_STRING = "gpt-image-1";
const MODEL_NAME = "openai/gpt-image-1";
const PROVIDER_ID = "test-provider-openai-images";

const FAKE_TX: Transactor = async (cb) => cb({} as never);

describe("openai-compatible image gen — OpenAI gpt-image-1 (recorded)", () => {
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
      description: "OpenAI gpt-image-1 — photorealistic, supports custom sizes",
      // No `aspectRatios` in capabilities — gpt-image-1 takes `size`, not
      // OpenAI-style aspectRatio. The tool handler skips the field when
      // capabilities don't advertise it, and the SDK defaults to the
      // model's native size (1024x1024).
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

    const result = await tool!.handler(
      { prompt: PROMPT, model: MODEL_NAME } as never,
      {} as Service,
    );

    const parsed = parseGeneratedImagePayload(result);
    expect(parsed).not.toBeNull();
    const payload = parsed as GeneratedImagePayload;
    expect(payload.path).toMatch(/^generated\/openai-image-\d+\./);
    expect(payload.mediaType).toMatch(/^image\//);
    expect(payload.model).toBe(MODEL_NAME);

    // The recorded fixture must round-trip a non-empty image buffer. The
    // exact byte count drifts across re-records (different sampling) so we
    // only assert "got real bytes" — wire-shape coverage is the goal, not
    // pixel-level fidelity.
    expect(upload).toHaveBeenCalledTimes(1);
    expect(uploadedBuffers[0]?.byteLength).toBeGreaterThan(500);
  });
});
