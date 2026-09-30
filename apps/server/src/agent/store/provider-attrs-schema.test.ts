import { describe, expect, it } from "vitest";
import { ProviderAttrsSchema } from "./schema.js";

describe("ProviderAttrsSchema", () => {
  it("reads attrs in the current shape unchanged", () => {
    const attrs = { cacheDialect: "xai", headers: { "x-test": "1" } };

    expect(ProviderAttrsSchema.parse(attrs)).toEqual(attrs);
  });

  it.each(["openrouter", "openai", "xai", "none"])("accepts the %s dialect", (cacheDialect) => {
    expect(ProviderAttrsSchema.parse({ cacheDialect })).toEqual({ cacheDialect });
  });

  it("reads a row with no dialect, as Anthropic rows are", () => {
    expect(ProviderAttrsSchema.parse({})).toEqual({});
  });

  it("reads a row that still holds promptCaching, dropping the key", () => {
    // The shape rows had before migration 0057; one written afterwards by an
    // older binary still parses, and reads as having no dialect.
    expect(ProviderAttrsSchema.parse({ promptCaching: true, headers: { a: "b" } })).toEqual({
      headers: { a: "b" },
    });
  });

  it("rejects a dialect it doesn't know", () => {
    expect(() => ProviderAttrsSchema.parse({ cacheDialect: "anthropic" })).toThrow();
  });

  it.each(["drop_block", "error"])("accepts the %s prefix mismatch behaviour", (behavior) => {
    expect(ProviderAttrsSchema.parse({ prefixMismatchBehavior: behavior })).toEqual({
      prefixMismatchBehavior: behavior,
    });
  });

  it("rejects a prefix mismatch behaviour the API doesn't take", () => {
    expect(() => ProviderAttrsSchema.parse({ prefixMismatchBehavior: "drop" })).toThrow();
  });
});
