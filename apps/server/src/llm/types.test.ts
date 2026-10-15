import { describe, expect, it } from "vitest";
import { ContentBlockSchema } from "./types.js";

describe("ContentBlockSchema", () => {
  const image = { type: "image", source: "base64", data: "aW1n", mediaType: "image/png" };

  it("keeps an image's pixel size", () => {
    expect(ContentBlockSchema.parse({ ...image, width: 640, height: 480 })).toEqual({
      ...image,
      width: 640,
      height: 480,
    });
  });

  it.each([{ width: 0 }, { height: -1 }, { width: 1.5 }])(
    "rejects an image size that isn't a positive integer: %o",
    (size) => {
      expect(ContentBlockSchema.safeParse({ ...image, ...size }).success).toBe(false);
    },
  );
});
