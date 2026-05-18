import type { FalProvider } from "@ai-sdk/fal";
import type { OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageModelWithProvider } from "../agent/store/index.js";
import type { ImageProvider } from "../llm/image-providers.js";
import type { VeniceImageProvider } from "../llm/venice.js";
import type { AttachmentStore } from "../transport/attachment-store.js";
import { AbortError } from "../util/with-retry.js";
import {
  createImageTools,
  type GeneratedImagePayload,
  imageModelSlug,
  parseGeneratedImagePayload,
} from "./image-tools.js";
import type { Service } from "./service.js";

// Passthrough withRetry — tests exercise the handler's error classification
// without paying real backoff delays. Retry behaviour itself is covered in
// src/util/with-retry.test.ts.
vi.mock("../util/with-retry.js", async () => {
  const actual =
    await vi.importActual<typeof import("../util/with-retry.js")>("../util/with-retry.js");
  return {
    ...actual,
    withRetry: <T>(fn: () => Promise<T>) => fn(),
  };
});

const mockGenerateImage = vi.fn();
class FakeAPICallError extends Error {
  readonly isRetryable: boolean;
  constructor(message: string, isRetryable: boolean) {
    super(message);
    this.name = "AI_APICallError";
    this.isRetryable = isRetryable;
  }
}
vi.mock("ai", () => ({
  generateImage: (...args: unknown[]) => mockGenerateImage(...args),
  APICallError: {
    isInstance: (err: unknown): err is FakeAPICallError => err instanceof FakeAPICallError,
  },
}));

afterEach(() => {
  mockGenerateImage.mockReset();
});

function falModel(overrides: Partial<ImageModelWithProvider> = {}): ImageModelWithProvider {
  return {
    id: "model-1",
    providerId: "provider-1",
    name: "fal/flux-dev",
    modelString: "fal-ai/flux/dev",
    description: "balanced default",
    capabilities: { aspectRatios: ["1:1", "16:9"], seed: true },
    userSelectable: true,
    provider: {
      id: "provider-1",
      name: "fal",
      type: "fal",
      baseUrl: null,
      secretId: "sec-1",
      attrs: {},
    },
    ...overrides,
  };
}

/**
 * Provider stubs return the spy alongside the `ImageProvider` so assertions
 * can reference the mock function directly. The `as unknown as FalProvider`
 * / `OpenAICompatibleProvider` casts bridge the minimal stub to the SDK's
 * full type — only `.image()` / `.imageModel()` is exercised by the handler.
 */
function fakeFalProvider(): { imageFn: ReturnType<typeof vi.fn>; provider: ImageProvider } {
  const imageFn = vi.fn((modelString: string) => ({ kind: "fal-imgmodel", modelString }));
  const provider: ImageProvider = {
    kind: "fal",
    row: falModel().provider,
    provider: { image: imageFn } as unknown as FalProvider,
  };
  return { imageFn, provider };
}

function fakeOaiProvider(): {
  imageModelFn: ReturnType<typeof vi.fn>;
  provider: ImageProvider;
} {
  const imageModelFn = vi.fn((modelString: string) => ({
    kind: "oai-imgmodel",
    modelString,
  }));
  const provider: ImageProvider = {
    kind: "oai",
    row: {
      id: "provider-2",
      name: "venice-oai",
      type: "openai_compatible",
      baseUrl: "https://api.venice.ai/api/v1",
      secretId: "sec-2",
      attrs: {},
    },
    provider: { imageModel: imageModelFn } as unknown as OpenAICompatibleProvider,
  };
  return { imageModelFn, provider };
}

function fakeVeniceProvider(): {
  generateFn: ReturnType<typeof vi.fn>;
  provider: ImageProvider;
} {
  const generateFn = vi.fn(async () => ({
    uint8Array: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    mediaType: "image/png" as const,
  }));
  const provider: ImageProvider = {
    kind: "venice",
    row: {
      id: "provider-3",
      name: "venice",
      type: "venice",
      baseUrl: "https://api.venice.ai/api/v1",
      secretId: "sec-3",
      attrs: {},
    },
    // Minimal stub conforming to the surface the tool handler calls
    // (`generate`). The adapter's full constructor takes apiKey/baseUrl/etc.
    // and is exercised in venice.test.ts.
    provider: { generate: generateFn } as unknown as VeniceImageProvider,
  };
  return { generateFn, provider };
}

function fakeAttachments(): AttachmentStore {
  return {
    upload: vi.fn().mockResolvedValue("inbound/test.png"),
    download: vi.fn(),
    delete: vi.fn(),
    has: vi.fn().mockResolvedValue(true),
    sign: vi.fn(),
  } as unknown as AttachmentStore;
}

// Image tools never read from `service` — they're closure-injected (like
// createWebTools). Any sentinel value works as long as we satisfy the
// handler arity.
const FAKE_SERVICE = {} as Service;

describe("imageModelSlug", () => {
  it("strips the provider prefix from a single-slash name", () => {
    expect(imageModelSlug("fal-ai/flux-pro")).toBe("flux-pro");
    expect(imageModelSlug("fal/flux-dev")).toBe("flux-dev");
  });

  it("strips up to the last slash on multi-segment names", () => {
    expect(imageModelSlug("openrouter/x-ai/grok-4.3")).toBe("grok-4.3");
    expect(imageModelSlug("fal-ai/flux-pro/kontext")).toBe("kontext");
  });

  it("returns the input unchanged when there is no slash", () => {
    expect(imageModelSlug("flux-dev")).toBe("flux-dev");
  });
});

describe("createImageTools", () => {
  it("returns [] when no models are configured", () => {
    const tools = createImageTools({
      models: [],
      providers: new Map(),
      attachments: fakeAttachments(),
    });
    expect(tools).toEqual([]);
  });

  it("emits a slash-free `model` enum in the tool schema (xAI grammar guard)", () => {
    // Regression: xAI's grok-* family rejects tool parameter enum values
    // containing `/` because its grammar compiler treats the character
    // specially. Stripping the provider prefix to a slug keeps the same
    // identifier safe across providers — see imageModelSlug for the link
    // back to the upstream issues.
    const [tool] = createImageTools({
      models: [
        falModel({ name: "fal-ai/flux-pro" }),
        falModel({
          id: "model-2",
          name: "fal-ai/recraft-v3",
          modelString: "fal-ai/recraft-v3",
        }),
      ],
      providers: new Map([["provider-1", fakeFalProvider().provider]]),
      attachments: fakeAttachments(),
    });
    const schema = tool!.inputSchema as unknown as {
      properties: { model: { enum: string[] } };
    };
    expect(schema.properties.model.enum).toEqual(["flux-pro", "recraft-v3"]);
    for (const value of schema.properties.model.enum) {
      expect(value).not.toContain("/");
    }
  });

  it("throws at registration when two model names share a slug", () => {
    // Two providers both serve a model with the same last-path-segment name.
    // Catch the collision at boot, not at the LLM's first tool call.
    expect(() =>
      createImageTools({
        models: [
          falModel({ name: "fal-ai/flux-pro" }),
          falModel({
            id: "model-2",
            providerId: "provider-2",
            name: "replicate/flux-pro",
            modelString: "replicate/flux-pro",
          }),
        ],
        providers: new Map([["provider-1", fakeFalProvider().provider]]),
        attachments: fakeAttachments(),
      }),
    ).toThrow(/collision after slug normalisation/);
  });

  it("builds a single generate_image tool with names from the catalog", () => {
    const providers = new Map([["provider-1", fakeFalProvider().provider]]);
    const tools = createImageTools({
      models: [falModel()],
      providers,
      attachments: fakeAttachments(),
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("generate_image");
    // Description uses slug, not the canonical "fal/flux-dev" path — the
    // LLM-facing identifier must be slash-free (see imageModelSlug).
    expect(tools[0]?.description).toContain("flux-dev");
    expect(tools[0]?.description).not.toContain("fal/flux-dev");
    expect(tools[0]?.description).toContain("balanced default");
    expect(tools[0]?.description).toContain("ratios: 1:1, 16:9");
  });

  it('marks fixed-size models with "fixed size" in the description', () => {
    const providers = new Map([["provider-1", fakeFalProvider().provider]]);
    const tools = createImageTools({
      models: [
        falModel({
          name: "fal/fixed-only",
          modelString: "fal-ai/fixed",
          description: "no custom ratios",
          capabilities: {},
        }),
      ],
      providers,
      attachments: fakeAttachments(),
    });
    expect(tools[0]?.description).toContain("(fixed size)");
  });

  it("delegates to provider.image() for fal models", async () => {
    mockGenerateImage.mockResolvedValueOnce({
      image: { uint8Array: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
    });
    const { imageFn, provider } = fakeFalProvider();
    const attachments = fakeAttachments();
    const [tool] = createImageTools({
      models: [falModel()],
      providers: new Map([["provider-1", provider]]),
      attachments,
    });
    const result = await tool!.handler({ prompt: "hello", model: "flux-dev" }, FAKE_SERVICE);

    expect(imageFn).toHaveBeenCalledWith("fal-ai/flux/dev");
    expect(attachments.upload).toHaveBeenCalled();
    // The payload's `model` is the canonical row name (operator/log-facing),
    // not the LLM-facing slug. See GeneratedImagePayload.
    expect(JSON.parse(result)).toMatchObject({
      path: "inbound/test.png",
      mediaType: "image/png",
      model: "fal/flux-dev",
    });
  });

  it("delegates to provider.imageModel() for openai_compatible models", async () => {
    mockGenerateImage.mockResolvedValueOnce({
      image: { uint8Array: new Uint8Array([4, 5, 6]), mediaType: "image/png" },
    });
    const { imageModelFn, provider } = fakeOaiProvider();
    const model = falModel({
      providerId: "provider-2",
      name: "venice/flux",
      modelString: "flux-dev",
      provider: provider.row,
    });
    const [tool] = createImageTools({
      models: [model],
      providers: new Map([["provider-2", provider]]),
      attachments: fakeAttachments(),
    });
    await tool!.handler({ prompt: "x", model: "flux" }, FAKE_SERVICE);

    expect(imageModelFn).toHaveBeenCalledWith("flux-dev");
  });

  it("returns a text error for an unsupported aspect ratio (per-model narrowing)", async () => {
    // Per-model narrowing: the Zod enum is the union across all models. Here
    // model A supports 1:1/16:9 and model B supports 21:9 — the LLM can pick
    // 21:9 from the union, but if it lands on model A the handler returns a
    // text error rather than letting the provider reject it.
    const [tool] = createImageTools({
      models: [
        falModel(), // supports 1:1, 16:9
        falModel({
          name: "fal/cinematic",
          modelString: "fal-ai/cinematic",
          description: "21:9 only",
          capabilities: { aspectRatios: ["21:9"] },
        }),
      ],
      providers: new Map([["provider-1", fakeFalProvider().provider]]),
      attachments: fakeAttachments(),
    });
    const result = await tool!.handler(
      {
        prompt: "x",
        model: "flux-dev",
        aspectRatio: "21:9",
      },
      FAKE_SERVICE,
    );
    expect(result).toMatch(/does not support aspect ratio 21:9/);
    expect(result).toMatch(/Supported: 1:1, 16:9/);
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });

  it('returns "no custom aspect ratio" error for fixed-size models when the LLM still passes one', async () => {
    // Union must be non-empty for the Zod field to accept any value; second
    // model contributes 1:1 to the union. The first model is fixed-size and
    // should reject the LLM's pick via the handler's narrowing branch.
    const [tool] = createImageTools({
      models: [
        falModel({
          name: "fal/fixed",
          capabilities: {},
        }),
        falModel({
          name: "fal/standard",
          modelString: "fal-ai/standard",
          capabilities: { aspectRatios: ["1:1"] },
        }),
      ],
      providers: new Map([["provider-1", fakeFalProvider().provider]]),
      attachments: fakeAttachments(),
    });
    const result = await tool!.handler(
      {
        prompt: "x",
        model: "fixed",
        aspectRatio: "1:1",
      },
      FAKE_SERVICE,
    );
    expect(result).toMatch(/does not accept a custom aspect ratio/);
  });

  it("silently drops `seed` for models that don't honor it", async () => {
    mockGenerateImage.mockResolvedValueOnce({
      image: { uint8Array: new Uint8Array([7, 8]), mediaType: "image/png" },
    });
    const [tool] = createImageTools({
      models: [
        falModel({
          name: "fal/no-seed",
          capabilities: { aspectRatios: ["1:1"] },
        }),
      ],
      providers: new Map([["provider-1", fakeFalProvider().provider]]),
      attachments: fakeAttachments(),
    });
    await tool!.handler(
      {
        prompt: "x",
        model: "no-seed",
        seed: 42,
      },
      FAKE_SERVICE,
    );
    expect(mockGenerateImage).toHaveBeenCalledTimes(1);
    const callArg = mockGenerateImage.mock.calls[0]?.[0];
    expect(callArg).not.toHaveProperty("seed");
  });

  it("forwards `seed` for models with capabilities.seed=true", async () => {
    mockGenerateImage.mockResolvedValueOnce({
      image: { uint8Array: new Uint8Array([9]), mediaType: "image/png" },
    });
    const [tool] = createImageTools({
      models: [falModel()], // seed: true
      providers: new Map([["provider-1", fakeFalProvider().provider]]),
      attachments: fakeAttachments(),
    });
    await tool!.handler(
      {
        prompt: "x",
        model: "flux-dev",
        seed: 42,
      },
      FAKE_SERVICE,
    );
    const callArg = mockGenerateImage.mock.calls[0]?.[0];
    expect(callArg).toMatchObject({ seed: 42 });
  });

  it("rejects a call to a model with imageInput:required when referenceImage is missing", async () => {
    const [tool] = createImageTools({
      models: [
        falModel({
          name: "fal/flux-kontext",
          modelString: "fal-ai/flux-pro/kontext",
          description: "image editing",
          capabilities: { aspectRatios: ["1:1"], imageInput: "required" },
        }),
      ],
      providers: new Map([["provider-1", fakeFalProvider().provider]]),
      attachments: fakeAttachments(),
    });
    const result = await tool!.handler(
      { prompt: "make it sepia", model: "flux-kontext" },
      FAKE_SERVICE,
    );
    expect(result).toMatch(/requires `referenceImage`/);
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });

  it("rejects referenceImage when the picked model is text-only", async () => {
    const [tool] = createImageTools({
      models: [falModel()],
      providers: new Map([["provider-1", fakeFalProvider().provider]]),
      attachments: fakeAttachments(),
    });
    const result = await tool!.handler(
      {
        prompt: "x",
        model: "flux-dev",
        referenceImage: "inbound/photo.png",
      },
      FAKE_SERVICE,
    );
    expect(result).toMatch(/does not accept a reference image/);
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });

  it("rejects referenceImage for non-fal providers (today)", async () => {
    const { provider } = fakeOaiProvider();
    const model = falModel({
      providerId: "provider-2",
      name: "venice/edit",
      modelString: "edit-model",
      capabilities: { imageInput: "optional" },
      provider: provider.row,
    });
    const [tool] = createImageTools({
      models: [model],
      providers: new Map([["provider-2", provider]]),
      attachments: fakeAttachments(),
    });
    const result = await tool!.handler(
      {
        prompt: "make changes",
        model: "edit",
        referenceImage: "inbound/photo.png",
      },
      FAKE_SERVICE,
    );
    expect(result).toMatch(/only supported by fal providers today/);
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });

  it("forwards reference image bytes via the `prompt` object shape on fal", async () => {
    mockGenerateImage.mockResolvedValueOnce({
      image: { uint8Array: new Uint8Array([1]), mediaType: "image/png" },
    });
    const refBytes = Buffer.from([0xff, 0xd8, 0xff]); // first JPEG bytes
    const attachments = fakeAttachments();
    attachments.download = vi.fn().mockResolvedValue(refBytes);
    const [tool] = createImageTools({
      models: [
        falModel({
          name: "fal/flux-kontext",
          modelString: "fal-ai/flux-pro/kontext",
          capabilities: { aspectRatios: ["1:1"], imageInput: "required" },
        }),
      ],
      providers: new Map([["provider-1", fakeFalProvider().provider]]),
      attachments,
    });
    await tool!.handler(
      {
        prompt: "make it watercolor",
        model: "flux-kontext",
        referenceImage: "inbound/cat.png",
      },
      FAKE_SERVICE,
    );
    expect(attachments.download).toHaveBeenCalledWith("inbound/cat.png");
    const callArg = mockGenerateImage.mock.calls[0]?.[0];
    expect(callArg).toMatchObject({
      prompt: {
        text: "make it watercolor",
        images: [refBytes],
      },
    });
  });

  it("surfaces AttachmentStore download failures as text errors", async () => {
    const attachments = fakeAttachments();
    attachments.download = vi.fn().mockRejectedValue(new Error("no such key"));
    const [tool] = createImageTools({
      models: [
        falModel({
          name: "fal/flux-kontext",
          modelString: "fal-ai/flux-pro/kontext",
          capabilities: { aspectRatios: ["1:1"], imageInput: "required" },
        }),
      ],
      providers: new Map([["provider-1", fakeFalProvider().provider]]),
      attachments,
    });
    const result = await tool!.handler(
      {
        prompt: "x",
        model: "flux-kontext",
        referenceImage: "inbound/missing.png",
      },
      FAKE_SERVICE,
    );
    expect(result).toMatch(/couldn't load referenceImage/);
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });

  it("annotates the tool description with imageInput hints", () => {
    const [tool] = createImageTools({
      models: [
        falModel(),
        falModel({
          name: "fal/flux-kontext",
          capabilities: { aspectRatios: ["1:1"], imageInput: "required" },
        }),
      ],
      providers: new Map([["provider-1", fakeFalProvider().provider]]),
      attachments: fakeAttachments(),
    });
    expect(tool!.description).toMatch(/\[needs reference image\]/);
    expect(tool!.description).toMatch(/referenceImage/);
  });

  it("delegates to provider.generate() for venice models", async () => {
    const { generateFn, provider } = fakeVeniceProvider();
    const attachments = fakeAttachments();
    const model = falModel({
      providerId: "provider-3",
      name: "venice/flux-dev-uncensored",
      modelString: "flux-dev-uncensored",
      capabilities: { aspectRatios: ["1:1", "16:9"], seed: true, negativePrompt: true },
      provider: provider.row,
    });
    const [tool] = createImageTools({
      models: [model],
      providers: new Map([["provider-3", provider]]),
      attachments,
    });

    const result = await tool!.handler(
      {
        prompt: "a painted dragon",
        model: "flux-dev-uncensored",
        aspectRatio: "16:9",
        seed: 42,
        negativePrompt: "low quality, blurry",
      },
      FAKE_SERVICE,
    );

    expect(generateFn).toHaveBeenCalledTimes(1);
    expect(generateFn.mock.calls[0]?.[0]).toMatchObject({
      model: "flux-dev-uncensored",
      prompt: "a painted dragon",
      aspectRatio: "16:9",
      seed: 42,
      negativePrompt: "low quality, blurry",
    });
    expect(attachments.upload).toHaveBeenCalled();
    const parsed = JSON.parse(result) as GeneratedImagePayload;
    expect(parsed).toMatchObject({
      path: "inbound/test.png",
      mediaType: "image/png",
      model: "venice/flux-dev-uncensored",
    });
  });

  it("rejects referenceImage for venice (non-fal) providers", async () => {
    const { provider } = fakeVeniceProvider();
    const model = falModel({
      providerId: "provider-3",
      name: "venice/flux-edit",
      modelString: "flux-edit",
      capabilities: { imageInput: "optional" },
      provider: provider.row,
    });
    const [tool] = createImageTools({
      models: [model],
      providers: new Map([["provider-3", provider]]),
      attachments: fakeAttachments(),
    });
    const result = await tool!.handler(
      { prompt: "x", model: "flux-edit", referenceImage: "inbound/photo.png" },
      FAKE_SERVICE,
    );
    expect(result).toMatch(/only supported by fal providers today/);
  });

  it("does NOT forward negativePrompt when the model's capability is absent", async () => {
    const { generateFn, provider } = fakeVeniceProvider();
    const model = falModel({
      providerId: "provider-3",
      name: "venice/text-only",
      modelString: "text-only",
      capabilities: { aspectRatios: ["1:1"] }, // negativePrompt absent
      provider: provider.row,
    });
    const [tool] = createImageTools({
      models: [model],
      providers: new Map([["provider-3", provider]]),
      attachments: fakeAttachments(),
    });
    await tool!.handler(
      {
        prompt: "x",
        model: "text-only",
        negativePrompt: "blurry",
      },
      FAKE_SERVICE,
    );
    expect(generateFn.mock.calls[0]?.[0]).not.toHaveProperty("negativePrompt");
  });

  it("forwards negativePrompt to openai_compatible via providerOptions[providerName].negative_prompt", async () => {
    // Canonical OpenAI rejects with HTTP 400, but openai-shaped servers
    // (Together, Replicate's shim, custom inference) accept the field —
    // the capability flag is the operator's declaration of "my server
    // takes this." The handler forwards via the @ai-sdk/openai-compatible
    // passthrough keyed by provider name, matching how the SDK was
    // constructed in `image-providers.ts`.
    mockGenerateImage.mockResolvedValueOnce({
      image: { uint8Array: new Uint8Array(8192), mediaType: "image/png" },
    });
    const { provider } = fakeOaiProvider();
    const oaiModel: ImageModelWithProvider = {
      id: "model-oai-1",
      providerId: "provider-2",
      name: "venice-oai/sd35",
      modelString: "venice-sd35",
      description: "openai-compat with negativePrompt",
      capabilities: { negativePrompt: true },
      userSelectable: true,
      provider: provider.row,
    };
    const [tool] = createImageTools({
      models: [oaiModel],
      providers: new Map([["provider-2", provider]]),
      attachments: fakeAttachments(),
    });
    await tool!.handler(
      {
        prompt: "x",
        model: "sd35",
        negativePrompt: "low quality",
      },
      FAKE_SERVICE,
    );
    const callArg = mockGenerateImage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg.providerOptions).toMatchObject({
      "venice-oai": { negative_prompt: "low quality" },
    });
  });

  it("forwards negativePrompt to fal via providerOptions.fal.negative_prompt", async () => {
    mockGenerateImage.mockResolvedValueOnce({
      image: { uint8Array: new Uint8Array([1]), mediaType: "image/png" },
    });
    const [tool] = createImageTools({
      models: [
        falModel({
          capabilities: { aspectRatios: ["1:1", "16:9"], seed: true, negativePrompt: true },
        }),
      ],
      providers: new Map([["provider-1", fakeFalProvider().provider]]),
      attachments: fakeAttachments(),
    });
    await tool!.handler(
      {
        prompt: "x",
        model: "flux-dev",
        negativePrompt: "extra fingers",
      },
      FAKE_SERVICE,
    );
    const callArg = mockGenerateImage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg.providerOptions).toMatchObject({
      fal: { negative_prompt: "extra fingers" },
    });
  });

  it("advertises [supports negativePrompt] in the tool description for capable models", () => {
    const { provider } = fakeVeniceProvider();
    const [tool] = createImageTools({
      models: [
        falModel({
          providerId: "provider-3",
          name: "venice/flux-uncensored",
          modelString: "flux-dev-uncensored",
          capabilities: { aspectRatios: ["1:1"], negativePrompt: true },
          provider: provider.row,
        }),
      ],
      providers: new Map([["provider-3", provider]]),
      attachments: fakeAttachments(),
    });
    expect(tool!.description).toMatch(/\[supports negativePrompt\]/);
    expect(tool!.description).toMatch(/negativePrompt/);
  });

  it("promotes non-retryable APICallErrors to AbortError", async () => {
    mockGenerateImage.mockRejectedValueOnce(new FakeAPICallError("auth failed", false));
    const [tool] = createImageTools({
      models: [falModel()],
      providers: new Map([["provider-1", fakeFalProvider().provider]]),
      attachments: fakeAttachments(),
    });
    await expect(
      tool!.handler({ prompt: "x", model: "flux-dev" }, FAKE_SERVICE),
    ).rejects.toBeInstanceOf(AbortError);
  });
});

describe("parseGeneratedImagePayload", () => {
  it("returns the payload for valid JSON", () => {
    const parsed = parseGeneratedImagePayload(
      JSON.stringify({ path: "inbound/x.png", mediaType: "image/png", model: "flux-dev" }),
    );
    const expected: GeneratedImagePayload = {
      path: "inbound/x.png",
      mediaType: "image/png",
      model: "flux-dev",
    };
    expect(parsed).toEqual(expected);
  });

  it("returns null on non-JSON input", () => {
    expect(parseGeneratedImagePayload("not json")).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(parseGeneratedImagePayload(JSON.stringify({ path: "x" }))).toBeNull();
    expect(parseGeneratedImagePayload(JSON.stringify({ mediaType: "image/png" }))).toBeNull();
  });

  it("returns null when required fields are wrong-typed", () => {
    expect(
      parseGeneratedImagePayload(JSON.stringify({ path: 1, mediaType: "image/png" })),
    ).toBeNull();
  });

  it("omits `model` from the result when wrong-typed", () => {
    const parsed = parseGeneratedImagePayload(
      JSON.stringify({ path: "x", mediaType: "image/png", model: 42 }),
    );
    expect(parsed).toEqual({ path: "x", mediaType: "image/png" });
  });
});
