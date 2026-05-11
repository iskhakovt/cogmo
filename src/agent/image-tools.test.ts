import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageModelWithProvider } from "../agent/store/index.js";
import type { ImageProvider } from "../llm/image-providers.js";
import type { AttachmentStore } from "../transport/attachment-store.js";
import { AbortError } from "../util/with-retry.js";
import {
  createImageTools,
  type GeneratedImagePayload,
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

function fakeFalProvider(): ImageProvider {
  return {
    kind: "fal",
    row: falModel().provider,
    provider: {
      image: vi.fn((modelString: string) => ({ kind: "fal-imgmodel", modelString })),
    } as never,
  };
}

function fakeOaiProvider(): ImageProvider {
  return {
    kind: "oai",
    row: {
      id: "provider-2",
      name: "venice",
      type: "openai_compatible",
      baseUrl: "https://api.venice.ai/api/v1",
      secretId: "sec-2",
      attrs: {},
    },
    provider: {
      imageModel: vi.fn((modelString: string) => ({ kind: "oai-imgmodel", modelString })),
    } as never,
  };
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

describe("createImageTools", () => {
  it("returns [] when no models are configured", () => {
    const tools = createImageTools({
      models: [],
      providers: new Map(),
      attachments: fakeAttachments(),
    });
    expect(tools).toEqual([]);
  });

  it("builds a single generate_image tool with names from the catalog", () => {
    const providers = new Map([["provider-1", fakeFalProvider()]]);
    const tools = createImageTools({
      models: [falModel()],
      providers,
      attachments: fakeAttachments(),
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("generate_image");
    expect(tools[0]?.description).toContain("fal/flux-dev");
    expect(tools[0]?.description).toContain("balanced default");
    expect(tools[0]?.description).toContain("ratios: 1:1, 16:9");
  });

  it('marks fixed-size models with "fixed size" in the description', () => {
    const providers = new Map([["provider-1", fakeFalProvider()]]);
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
    const falProvider = fakeFalProvider();
    const attachments = fakeAttachments();
    const [tool] = createImageTools({
      models: [falModel()],
      providers: new Map([["provider-1", falProvider]]),
      attachments,
    });
    const result = await tool!.handler(
      {
        prompt: "hello",
        model: "fal/flux-dev",
      } as never,
      FAKE_SERVICE,
    );

    expect(
      (falProvider.provider as unknown as { image: ReturnType<typeof vi.fn> }).image,
    ).toHaveBeenCalledWith("fal-ai/flux/dev");
    expect(attachments.upload).toHaveBeenCalled();
    expect(JSON.parse(result as string)).toMatchObject({
      path: "inbound/test.png",
      mediaType: "image/png",
      model: "fal/flux-dev",
    });
  });

  it("delegates to provider.imageModel() for openai_compatible models", async () => {
    mockGenerateImage.mockResolvedValueOnce({
      image: { uint8Array: new Uint8Array([4, 5, 6]), mediaType: "image/png" },
    });
    const oaiProvider = fakeOaiProvider();
    const model = falModel({
      providerId: "provider-2",
      name: "venice/flux",
      modelString: "flux-dev",
      provider: oaiProvider.row,
    });
    const [tool] = createImageTools({
      models: [model],
      providers: new Map([["provider-2", oaiProvider]]),
      attachments: fakeAttachments(),
    });
    await tool!.handler({ prompt: "x", model: "venice/flux" } as never, FAKE_SERVICE);

    expect(
      (oaiProvider.provider as unknown as { imageModel: ReturnType<typeof vi.fn> }).imageModel,
    ).toHaveBeenCalledWith("flux-dev");
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
      providers: new Map([["provider-1", fakeFalProvider()]]),
      attachments: fakeAttachments(),
    });
    const result = await tool!.handler(
      {
        prompt: "x",
        model: "fal/flux-dev",
        aspectRatio: "21:9",
      } as never,
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
      providers: new Map([["provider-1", fakeFalProvider()]]),
      attachments: fakeAttachments(),
    });
    const result = await tool!.handler(
      {
        prompt: "x",
        model: "fal/fixed",
        aspectRatio: "1:1",
      } as never,
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
      providers: new Map([["provider-1", fakeFalProvider()]]),
      attachments: fakeAttachments(),
    });
    await tool!.handler(
      {
        prompt: "x",
        model: "fal/no-seed",
        seed: 42,
      } as never,
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
      providers: new Map([["provider-1", fakeFalProvider()]]),
      attachments: fakeAttachments(),
    });
    await tool!.handler(
      {
        prompt: "x",
        model: "fal/flux-dev",
        seed: 42,
      } as never,
      FAKE_SERVICE,
    );
    const callArg = mockGenerateImage.mock.calls[0]?.[0];
    expect(callArg).toMatchObject({ seed: 42 });
  });

  it("promotes non-retryable APICallErrors to AbortError", async () => {
    mockGenerateImage.mockRejectedValueOnce(new FakeAPICallError("auth failed", false));
    const [tool] = createImageTools({
      models: [falModel()],
      providers: new Map([["provider-1", fakeFalProvider()]]),
      attachments: fakeAttachments(),
    });
    await expect(
      tool!.handler({ prompt: "x", model: "fal/flux-dev" } as never, FAKE_SERVICE),
    ).rejects.toBeInstanceOf(AbortError);
  });
});

describe("parseGeneratedImagePayload", () => {
  it("returns the payload for valid JSON", () => {
    const parsed = parseGeneratedImagePayload(
      JSON.stringify({ path: "inbound/x.png", mediaType: "image/png", model: "fal/flux-dev" }),
    );
    const expected: GeneratedImagePayload = {
      path: "inbound/x.png",
      mediaType: "image/png",
      model: "fal/flux-dev",
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
