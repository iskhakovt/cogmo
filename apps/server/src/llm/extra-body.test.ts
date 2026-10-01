import { describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import {
  ExtraBodySchema,
  parseExtraBody,
  RESERVED_EXTRA_BODY_KEYS,
  StoredExtraBodySchema,
} from "./extra-body.js";

describe("parseExtraBody", () => {
  it("reads a JSON object, nested objects and arrays intact", () => {
    const text = JSON.stringify({
      reasoning: { enabled: false, effort: null },
      venice_parameters: { disable_thinking: true, strip_thinking_response: false },
      stop: ["</answer>"],
      top_p: 0.8,
    });

    expect(parseExtraBody(text)).toEqual({
      reasoning: { enabled: false, effort: null },
      venice_parameters: { disable_thinking: true, strip_thinking_response: false },
      stop: ["</answer>"],
      top_p: 0.8,
    });
  });

  it.each(RESERVED_EXTRA_BODY_KEYS)("refuses %s, which the adapter sets", (key) => {
    expect(() => parseExtraBody(JSON.stringify({ [key]: "x", top_p: 1 }))).toThrow(
      new RegExp(`^"${key}" is set by the adapter and can't be overridden \\(reserved: model, `),
    );
  });

  it("names every reserved key it finds", () => {
    expect(() => parseExtraBody('{"model":"m","stream":false,"top_p":1}')).toThrow(
      /^"model", "stream" are set by the adapter/,
    );
  });

  it("refuses a reserved key only at the top level", () => {
    expect(parseExtraBody('{"venice_parameters":{"model":"x"}}')).toEqual({
      venice_parameters: { model: "x" },
    });
  });

  it.each([
    ["[1, 2]", /expected a JSON object, got an array/],
    ["null", /expected a JSON object, got null/],
    ['"reasoning"', /expected a JSON object, got string/],
    ["7", /expected a JSON object, got number/],
    ["true", /expected a JSON object, got boolean/],
  ])("refuses %s, which is not an object", (text, message) => {
    expect(() => parseExtraBody(text)).toThrow(message);
  });

  it("refuses text that isn't JSON, saying so", () => {
    expect(() => parseExtraBody("{reasoning: {enabled: false}}")).toThrow(
      /^expected a JSON object, got text that doesn't parse: /,
    );
  });

  it("refuses an empty object, which would add nothing", () => {
    expect(() => parseExtraBody("{}")).toThrow(/an empty object adds nothing/);
  });
});

describe("ExtraBodySchema", () => {
  it.each(RESERVED_EXTRA_BODY_KEYS)("refuses %s on the stored value too", (key) => {
    expect(ExtraBodySchema.safeParse({ [key]: 1 }).success).toBe(false);
  });

  it("refuses a value JSON can't carry", () => {
    expect(ExtraBodySchema.safeParse({ when: new Date(0) }).success).toBe(false);
    expect(ExtraBodySchema.safeParse({ n: Number.NaN }).success).toBe(false);
  });

  it("accepts an object of JSON values", () => {
    expect(ExtraBodySchema.parse({ reasoning: { enabled: false } })).toEqual({
      reasoning: { enabled: false },
    });
  });
});

describe("StoredExtraBodySchema", () => {
  it("reads a stored object as it is", () => {
    expect(StoredExtraBodySchema.parse({ reasoning: { enabled: false } })).toEqual({
      reasoning: { enabled: false },
    });
  });

  it("drops a reserved key written outside the store, with a warning, and keeps the rest", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(StoredExtraBodySchema.parse({ model: "x", stream: false, top_p: 0.5 })).toEqual({
        top_p: 0.5,
      });
      expect(warn).toHaveBeenCalledWith(
        { reserved: ["model", "stream"] },
        expect.stringMatching(/ignoring model_providers.extra_body keys/),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("still refuses a value that isn't a JSON object", () => {
    expect(StoredExtraBodySchema.safeParse([1]).success).toBe(false);
    expect(StoredExtraBodySchema.safeParse("x").success).toBe(false);
  });
});
