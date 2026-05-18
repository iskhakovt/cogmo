/// <reference path="../../test/vitest.d.ts" />

/**
 * Venice.ai's native `/image/generate` endpoint via the hand-rolled
 * `VeniceImageProvider` — recorded fixture replay.
 *
 * Pins our adapter against an actual recorded Venice response so a regression
 * in the request body shape, response decoding, or censorship header
 * handling fails this test loudly. Same shape as
 * `src/test/openai-image-gen.integration.test.ts` (PR #220) — different
 * mock infrastructure because Venice's wire shape is bespoke (base64 body
 * + headers).
 *
 * **Recording the fixture** (run once locally; commit the result):
 *
 * ```bash
 * RECORD=1 VENICE_INFERENCE_KEY=sk-... \
 *   pnpm test:record src/test/venice-image-gen.integration.test.ts
 * ```
 *
 * Subsequent CI runs replay against `test/fixtures/venice/*.json` — no
 * API key, no cost, no network.
 *
 * Without `VENICE_INFERENCE_KEY` set, the test skips itself in record mode
 * (no key → no value to capture) — but in default replay mode, the fixture
 * suffices on its own.
 */

import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
import { createVeniceFetch } from "./venice-mock.js";

const PROMPT = "A watercolor painting of a fox curled up in a forest clearing at dusk.";
const MODEL_STRING = "flux-dev-uncensored";
const MODEL_NAME = "venice/flux-dev-uncensored";
const MODEL_SLUG = "flux-dev-uncensored";
const PROVIDER_ID = "test-provider-venice";

const FAKE_TX: Transactor = async (cb) => cb({} as never);

const FIXTURE_PATH = join(process.cwd(), "test/fixtures/venice");

describe("venice native image gen (recorded)", () => {
  it("generates an image end-to-end via the venice adapter + recorded fixture", async () => {
    const recording = process.env.RECORD === "1";
    const apiKey = recording ? (process.env.VENICE_INFERENCE_KEY ?? "") : "test-venice-key";
    if (recording && !apiKey) {
      // No live key → nothing to capture. Skip silently rather than failing
      // local `RECORD=1` runs that just wanted to refresh fal/openai
      // fixtures.
      console.warn(
        "venice-image-gen: VENICE_INFERENCE_KEY not set, skipping record. " +
          "Replay-mode runs of this test still pass against the committed fixture.",
      );
      return;
    }

    const veniceFetch = createVeniceFetch({
      mode: recording ? "record" : "replay",
      fixturePath: FIXTURE_PATH,
    });

    const providerRow: ImageProviderRow = {
      id: PROVIDER_ID,
      name: "venice",
      type: "venice",
      baseUrl: "https://api.venice.ai/api/v1",
      secretId: "sec-test",
      attrs: {
        // Opt in to safe_mode true so the recording captures the default
        // (most uncontroversial) censorship posture. A separate test exists
        // in venice.test.ts for the safe_mode=false → blur-error branch.
        imageGenerationDefaults: { safe_mode: true },
      },
    };

    const secretsStore: SecretsStore = {
      getSecretById: vi.fn().mockResolvedValue(apiKey),
    } as unknown as SecretsStore;

    const provider = await buildImageProvider(providerRow, {
      runInTx: FAKE_TX,
      secretsStore,
      fetchOverrides: { venice: veniceFetch },
    });
    expect(provider.kind).toBe("venice");

    const modelEntry: ImageModelWithProvider = {
      id: "model-test",
      providerId: PROVIDER_ID,
      name: MODEL_NAME,
      modelString: MODEL_STRING,
      description: "Venice flux-dev-uncensored — supports negativePrompt",
      capabilities: { aspectRatios: ["1:1"], negativePrompt: true },
      userSelectable: true,
      provider: providerRow,
    };

    const uploadedBuffers: Buffer[] = [];
    const upload = vi.fn(async (buffer: Buffer, mediaType: string, _prefix?: string) => {
      uploadedBuffers.push(buffer);
      return `generated/venice-image-${uploadedBuffers.length}.${mediaType.split("/")[1] ?? "png"}`;
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
      { prompt: PROMPT, model: MODEL_SLUG, aspectRatio: "1:1" },
      {} as Service,
    );

    const parsed = parseGeneratedImagePayload(result);
    expect(parsed).not.toBeNull();
    const payload = parsed as GeneratedImagePayload;
    expect(payload.path).toMatch(/^generated\/venice-image-\d+\./);
    expect(payload.mediaType).toBe("image/png");
    expect(payload.model).toBe(MODEL_NAME);

    // Round-tripped image carries non-empty bytes. The committed fixture
    // uses a stubbed tiny PNG to keep git history small — a fresh recording
    // produces the real ~MB-scale PNG; trim back before committing.
    expect(upload).toHaveBeenCalledTimes(1);
    expect(uploadedBuffers[0]?.byteLength).toBeGreaterThan(50);
  });
});
