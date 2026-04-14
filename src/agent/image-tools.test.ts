import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentStore } from "../transport/attachment-store.js";
import { createImageTools, type FalProvider } from "./image-tools.js";

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
vi.mock("ai", () => ({
  generateImage: (...args: unknown[]) => mockGenerateImage(...args),
}));

afterEach(() => {
  mockGenerateImage.mockReset();
});

function stubService() {
  return {
    memory: {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
      retain: vi.fn().mockResolvedValue(undefined),
    },
    files: {
      read: vi.fn(),
      write: vi.fn(),
      list: vi.fn(),
    },
    coreMemory: {
      get: vi.fn(),
      update: vi.fn(),
    },
  };
}

function fakeFalProvider(): FalProvider {
  // fal.image(modelId) returns an ImageModel — we don't use the return value
  // since generateImage is mocked. Only need the call shape.
  return {
    image: vi.fn().mockReturnValue({ modelId: "stub" }),
  } as unknown as FalProvider;
}

function fakeAttachments(uploadedPath = "generated/abc.jpg"): AttachmentStore {
  return {
    upload: vi.fn().mockResolvedValue(uploadedPath),
    download: vi.fn(),
  };
}

describe("createImageTools", () => {
  it("returns a single generate_image tool", () => {
    const tools = createImageTools(fakeFalProvider(), fakeAttachments());
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("generate_image");
  });

  it("generates an image, uploads it with 'generated' prefix, returns JSON metadata", async () => {
    const fal = fakeFalProvider();
    const attachments = fakeAttachments("generated/abc.jpg");
    const [tool] = createImageTools(fal, attachments);
    if (!tool) throw new Error("tool missing");

    mockGenerateImage.mockResolvedValueOnce({
      image: {
        uint8Array: new Uint8Array([1, 2, 3]),
        mediaType: "image/jpeg",
        base64: "AQID",
      },
    });

    const result = await tool.handler(
      { prompt: "a sunset", model: "fal-ai/flux/dev" },
      stubService(),
    );

    expect(fal.image).toHaveBeenCalledWith("fal-ai/flux/dev");
    expect(attachments.upload).toHaveBeenCalledWith(
      Buffer.from([1, 2, 3]),
      "image/jpeg",
      "generated",
    );

    expect(JSON.parse(result)).toEqual({
      path: "generated/abc.jpg",
      mediaType: "image/jpeg",
      model: "fal-ai/flux/dev",
    });
  });

  it("passes aspectRatio and seed through to generateImage", async () => {
    const fal = fakeFalProvider();
    const [tool] = createImageTools(fal, fakeAttachments());
    if (!tool) throw new Error("tool missing");

    mockGenerateImage.mockResolvedValueOnce({
      image: {
        uint8Array: new Uint8Array([]),
        mediaType: "image/png",
        base64: "",
      },
    });

    await tool.handler(
      {
        prompt: "forest",
        model: "fal-ai/flux-pro/v1.1",
        aspectRatio: "16:9",
        seed: 42,
      },
      stubService(),
    );

    expect(mockGenerateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "forest",
        aspectRatio: "16:9",
        seed: 42,
      }),
    );
  });

  it("returns error string when fal provider is undefined", async () => {
    const [tool] = createImageTools(undefined, fakeAttachments());
    if (!tool) throw new Error("tool missing");

    const result = await tool.handler({ prompt: "x", model: "fal-ai/flux/dev" }, stubService());

    expect(result).toMatch(/not configured/i);
    expect(result).toMatch(/FAL_API_KEY/);
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });

  it("rejects empty prompt via schema validation", async () => {
    const [tool] = createImageTools(fakeFalProvider(), fakeAttachments());
    if (!tool) throw new Error("tool missing");

    await expect(
      tool.handler({ prompt: "", model: "fal-ai/flux/dev" }, stubService()),
    ).rejects.toThrow();
  });

  it("rejects unknown model via enum", async () => {
    const [tool] = createImageTools(fakeFalProvider(), fakeAttachments());
    if (!tool) throw new Error("tool missing");

    await expect(
      tool.handler({ prompt: "x", model: "fal-ai/bogus/model" }, stubService()),
    ).rejects.toThrow();
  });

  it("applies default model when not specified", async () => {
    const fal = fakeFalProvider();
    const [tool] = createImageTools(fal, fakeAttachments());
    if (!tool) throw new Error("tool missing");

    mockGenerateImage.mockResolvedValueOnce({
      image: { uint8Array: new Uint8Array([]), mediaType: "image/jpeg", base64: "" },
    });

    await tool.handler({ prompt: "x" }, stubService());

    expect(fal.image).toHaveBeenCalledWith("fal-ai/flux/dev");
  });
});
