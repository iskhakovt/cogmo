import { describe, expect, it } from "vitest";
import { computeBudget, DEFAULT_LIMITS, resolveLimits } from "./models.js";

describe("resolveLimits", () => {
  describe("source: db (full row override)", () => {
    it("returns db override when both columns are set", () => {
      const result = resolveLimits("anything-goes", {
        contextWindow: 500_000,
        maxOutputTokens: 16_000,
      });
      expect(result).toEqual({
        contextWindow: 500_000,
        maxOutputTokens: 16_000,
        source: "db",
      });
    });

    it("ignores LiteLLM data when row override is fully populated", () => {
      // claude-sonnet-4-6 is in LiteLLM with 1M/64k. Row override wins.
      const result = resolveLimits("claude-sonnet-4-6", {
        contextWindow: 200_000,
        maxOutputTokens: 8_000,
      });
      expect(result.contextWindow).toBe(200_000);
      expect(result.maxOutputTokens).toBe(8_000);
      expect(result.source).toBe("db");
    });
  });

  describe("source: litellm", () => {
    it("falls through to LiteLLM when no row override is provided", () => {
      const result = resolveLimits("claude-sonnet-4-6");
      expect(result.contextWindow).toBe(1_000_000);
      expect(result.maxOutputTokens).toBe(64_000);
      expect(result.source).toBe("litellm");
    });

    it("falls through to LiteLLM with explicit null row columns", () => {
      const result = resolveLimits("claude-sonnet-4-6", {
        contextWindow: null,
        maxOutputTokens: null,
      });
      expect(result.source).toBe("litellm");
    });

    it("normalizes openrouter slugs through the alias ladder (x-ai/ → xai/)", () => {
      // LiteLLM stores it under `xai/grok-4.3`, not `x-ai/grok-4.3`.
      const result = resolveLimits("x-ai/grok-4.3");
      expect(result.source).toBe("litellm");
      expect(result.contextWindow).toBeGreaterThan(0);
      expect(result.maxOutputTokens).toBeGreaterThan(0);
    });
  });

  describe("source: db (partial override + LiteLLM)", () => {
    it("merges a single row column with LiteLLM for the other and tags as db", () => {
      // claude-sonnet-4-6 LiteLLM = 1M/64k. Override only maxOutputTokens.
      const result = resolveLimits("claude-sonnet-4-6", {
        contextWindow: null,
        maxOutputTokens: 8_000,
      });
      expect(result.contextWindow).toBe(1_000_000); // from LiteLLM
      expect(result.maxOutputTokens).toBe(8_000); // from row
      expect(result.source).toBe("db");
    });
  });

  describe("source: default", () => {
    it("returns the conservative default when neither row nor LiteLLM has data", () => {
      const result = resolveLimits("totally-made-up-model-xyz-2099");
      expect(result).toEqual({
        contextWindow: DEFAULT_LIMITS.contextWindow,
        maxOutputTokens: DEFAULT_LIMITS.maxOutputTokens,
        source: "default",
      });
    });

    it("merges a partial row override with the default when LiteLLM also misses", () => {
      const result = resolveLimits("totally-made-up-model-xyz-2099", {
        contextWindow: 500_000,
        maxOutputTokens: null,
      });
      expect(result.contextWindow).toBe(500_000); // from row
      expect(result.maxOutputTokens).toBe(DEFAULT_LIMITS.maxOutputTokens);
      expect(result.source).toBe("db"); // any row contribution → db source
    });

    it("never throws on unknown models — returns default instead", () => {
      expect(() => resolveLimits("does-not-exist")).not.toThrow();
    });
  });
});

describe("computeBudget", () => {
  it("returns contextWindow - maxOutputTokens - safetyBuffer", () => {
    expect(computeBudget({ contextWindow: 1_000_000, maxOutputTokens: 64_000 })).toBe(926_000);
  });

  it("accepts custom safety buffer", () => {
    expect(computeBudget({ contextWindow: 1_000_000, maxOutputTokens: 64_000 }, 5_000)).toBe(
      931_000,
    );
  });

  it("works on the conservative default", () => {
    // 128_000 - 4_096 - 10_000 = 113_904
    expect(computeBudget(DEFAULT_LIMITS)).toBe(113_904);
  });
});
