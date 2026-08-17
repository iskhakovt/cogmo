/**
 * Wire-shape pin for the `openai_compatible` image path.
 *
 * The rest of `image-tools.test.ts` mocks the `ai` module, so it can only
 * assert the arguments we hand `generateImage` — one layer above the HTTP
 * request. This file runs the real `ai` + `@ai-sdk/openai-compatible`
 * stack against a captured `fetch` and asserts the JSON body that reaches
 * the provider.
 *
 * That's the layer that matters for `response_format`: the adapter parses
 * `/images/generations` responses with a schema requiring
 * `data[].b64_json` but leaves `response_format` out of the body it
 * builds, and the Images API defaults to `url`. A request missing the
 * field produces a generated, billed image the adapter then rejects. The
 * gpt-image family is the mirror case — it answers in base64 either way
 * and returns HTTP 400 when the field is present at all. Both directions
 * are decided per model, and only an assertion on the outgoing body
 * catches a wrong call — a recorded-fixture replay can't, because the mock
 * server emits `b64_json` regardless of what the request asked for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { ImageModelWithProvider, ImageProviderRow } from "../agent/store/index.js";
import { buildImageProvider } from "../llm/image-providers.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { fakeRunInTx } from "../test/factories.js";
import type { AttachmentStore } from "../transport/attachment-store.js";
import { createImageTools } from "./image-tools.js";
import type { Service } from "./service.js";

/** 1x1 transparent PNG — the smallest valid `data[].b64_json` payload. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const PROVIDER_ID = "provider-oai";

function providerRowNamed(name: string): ImageProviderRow {
  return {
    id: PROVIDER_ID,
    name,
    type: "openai_compatible",
    baseUrl: "https://images.acme.test/v1",
    secretId: "sec-1",
    attrs: {},
  };
}

/** Image tools never read from `service` — deps are closure-injected. */
const FAKE_SERVICE = {} as Service;

interface CapturedRequest {
  url: string;
  /** Parsed JSON body — asserted with `toMatchObject`, never destructured. */
  body: unknown;
}

/**
 * Build the tool over a real `@ai-sdk/openai-compatible` provider whose
 * `fetch` is replaced by a capturing stub. Returns the captured requests
 * alongside the tool so assertions can read the exact JSON body.
 */
async function buildCapturingTool(args: {
  capabilities: ImageModelWithProvider["capabilities"];
  /** Provider `name` — drives the `providerOptions` key the adapter reads. */
  providerName?: string;
  /**
   * API-facing model id. Drives the per-model `response_format` decision
   * (see `openAiCompatibleResponseFormat`) and, via the row `name`, the
   * LLM-facing slug callers pass as `model`.
   */
  modelString?: string;
}): Promise<{
  requests: CapturedRequest[];
  handler: (input: Record<string, unknown>) => Promise<string>;
}> {
  const providerRow = providerRowNamed(args.providerName ?? "acme-images");
  const modelString = args.modelString ?? "dall-e-3";
  const requests: CapturedRequest[] = [];
  const fetchOverride = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push({
      url: input instanceof URL ? input.href : typeof input === "string" ? input : input.url,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response(JSON.stringify({ created: 0, data: [{ b64_json: PNG_B64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const secretsStore = mock<SecretsStore>();
  secretsStore.getSecretById.mockResolvedValue("test-key");

  const provider = await buildImageProvider(providerRow, {
    runInTx: fakeRunInTx,
    secretsStore,
    fetchOverrides: { openai_compatible: fetchOverride },
  });

  const attachments = mock<AttachmentStore>();
  attachments.upload.mockResolvedValue("generated/wire.png");

  const [tool] = createImageTools({
    models: [
      {
        id: "model-1",
        providerId: PROVIDER_ID,
        name: `${providerRow.name}/${modelString}`,
        modelString,
        description: "openai-compatible test model",
        capabilities: args.capabilities,
        userSelectable: true,
        provider: providerRow,
      },
    ],
    providers: new Map([[PROVIDER_ID, provider]]),
    attachments,
    // The 1x1 stub is far below the production size canary; this test
    // pins the request shape, not the moderation path.
    detectImageFailure: () => ({ ok: true }),
  });
  if (!tool) throw new Error("expected createImageTools to register generate_image");
  return { requests, handler: (input) => tool.handler(input, FAKE_SERVICE) };
}

describe("openai_compatible image request body", () => {
  // The handler's provider call is wrapped in withRetry; disabling it keeps
  // a broken assertion a fast failure instead of a backoff-padded one.
  beforeEach(() => {
    vi.stubEnv("RETRY_DISABLED", "true");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("carries response_format: b64_json to /images/generations", async () => {
    const { requests, handler } = await buildCapturingTool({ capabilities: {} });

    const result = await handler({ prompt: "a lighthouse at dusk", model: "dall-e-3" });

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe("https://images.acme.test/v1/images/generations");
    expect(request?.body).toMatchObject({
      model: "dall-e-3",
      prompt: "a lighthouse at dusk",
      response_format: "b64_json",
    });
    // The adapter only decodes `data[].b64_json`, so a body that asked for
    // the right format round-trips all the way to an uploaded attachment.
    expect(JSON.parse(result)).toMatchObject({ path: "generated/wire.png" });
  });

  it("leaves response_format out of a gpt-image-* body", async () => {
    // OpenAI's gpt-image line rejects the parameter outright — `HTTP 400
    // unknown_parameter: "Unknown parameter: 'response_format'."` — and
    // returns base64 with no `url` mode to opt out of, so the adapter's
    // `data[].b64_json` schema is satisfied without asking. A body
    // carrying the field makes every gpt-image model a hard failure.
    const { requests, handler } = await buildCapturingTool({
      capabilities: {},
      modelString: "gpt-image-1",
    });

    const result = await handler({ prompt: "a lighthouse at dusk", model: "gpt-image-1" });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({ model: "gpt-image-1" });
    expect(requests[0]?.body).not.toHaveProperty("response_format");
    expect(JSON.parse(result)).toMatchObject({ path: "generated/wire.png" });
  });

  it("keeps response_format alongside an operator-enabled negative_prompt", async () => {
    const { requests, handler } = await buildCapturingTool({
      capabilities: { negativePrompt: true },
    });

    await handler({
      prompt: "a lighthouse at dusk",
      model: "dall-e-3",
      negativePrompt: "blurry, low quality",
    });

    expect(requests[0]?.body).toMatchObject({
      response_format: "b64_json",
      negative_prompt: "blurry, low quality",
    });
  });

  // The adapter normalises the `providerOptions` key it reads (camelCase,
  // and only the segment before the first `.`), so a provider name that
  // isn't already in that form has to be normalised on our side too — an
  // unread key means an image that generates, bills, and then fails to
  // parse. `openAiCompatibleOptionsKey` owns that; these pin it against the
  // real adapter rather than against our own copy of the rule.
  it.each(["acme_images", "images.acme.test", "acme"])(
    "reaches the request body for a provider named %s",
    async (providerName) => {
      const { requests, handler } = await buildCapturingTool({ capabilities: {}, providerName });

      await handler({ prompt: "a lighthouse at dusk", model: "dall-e-3" });

      expect(requests[0]?.body).toMatchObject({ response_format: "b64_json" });
    },
  );
});
