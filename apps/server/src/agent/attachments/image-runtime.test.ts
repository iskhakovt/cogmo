import { err } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkImageRuntime, loadSharp } from "./image-runtime.js";
import { normalizeImage } from "./normalize-image.js";

describe("loadSharp", () => {
  it("loads and configures sharp once", async () => {
    const sharp = await loadSharp();
    expect(await loadSharp()).toBe(sharp);
    expect(sharp.concurrency()).toBe(1);
    expect(sharp.cache().items.max).toBe(0);
  });
});

describe("checkImageRuntime", () => {
  afterEach(() => {
    vi.doUnmock("sharp");
    vi.resetModules();
  });

  it("passes when a 1 × 1 JPEG normalizes", async () => {
    await expect(checkImageRuntime(normalizeImage)).resolves.toBeUndefined();
  });

  it("fails when the round trip is refused", async () => {
    const normalize = vi.fn().mockResolvedValue(err("undecodable"));
    await expect(checkImageRuntime(normalize)).rejects.toThrow(
      "sharp could not normalize a 1 × 1 JPEG (undecodable)",
    );
  });

  it("fails naming the platform packages when sharp doesn't load", async () => {
    vi.resetModules();
    vi.doMock("sharp", () => {
      throw new Error("ERR_DLOPEN_FAILED: libvips-cpp.so.8.18.7");
    });
    const fresh = await import("./image-runtime.js");
    const normalize = vi.fn();
    await expect(fresh.checkImageRuntime(normalize)).rejects.toThrow(
      /sharp failed to load.*@img\/sharp-libvips-<platform>/,
    );
    expect(normalize).not.toHaveBeenCalled();
  });
});
