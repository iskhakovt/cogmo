import { describe, expect, it } from "vitest";
import { computeBudget, DEFAULT_LIMITS, resolveLimits } from "./models.js";

describe("resolveLimits — full DB override", () => {
  it("returns row values for both columns when both are set", () => {
    const result = resolveLimits("anything-goes", {
      contextWindow: 500_000,
      maxOutputTokens: 16_000,
    });
    expect(result).toEqual({
      contextWindow: 500_000,
      maxOutputTokens: 16_000,
      contextWindowSource: "db",
      maxOutputTokensSource: "db",
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
    expect(result.contextWindowSource).toBe("db");
    expect(result.maxOutputTokensSource).toBe("db");
  });
});

describe("resolveLimits — LiteLLM fallback", () => {
  it("falls through to LiteLLM when no row override is provided", () => {
    const result = resolveLimits("claude-sonnet-4-6");
    expect(result.contextWindow).toBe(1_000_000);
    expect(result.maxOutputTokens).toBe(64_000);
    expect(result.contextWindowSource).toBe("litellm");
    expect(result.maxOutputTokensSource).toBe("litellm");
  });

  it("falls through to LiteLLM with explicit null row columns", () => {
    const result = resolveLimits("claude-sonnet-4-6", {
      contextWindow: null,
      maxOutputTokens: null,
    });
    expect(result.contextWindowSource).toBe("litellm");
    expect(result.maxOutputTokensSource).toBe("litellm");
  });

  it("normalizes openrouter slugs through the alias ladder (x-ai/ → xai/)", () => {
    // LiteLLM stores it under `xai/grok-4.3`, not `x-ai/grok-4.3`.
    const result = resolveLimits("x-ai/grok-4.3");
    expect(result.contextWindowSource).toBe("litellm");
    expect(result.maxOutputTokensSource).toBe("litellm");
    expect(result.contextWindow).toBeGreaterThan(0);
    expect(result.maxOutputTokens).toBeGreaterThan(0);
  });
});

describe("resolveLimits — partial DB override (per-column source attribution)", () => {
  it("reports cw=litellm + mo=db when only maxOutputTokens is pinned", () => {
    // The whole point of per-column sources — the LiteLLM contribution
    // for `contextWindow` would have been hidden by the previous flat
    // `source: db` tag.
    const result = resolveLimits("claude-sonnet-4-6", {
      contextWindow: null,
      maxOutputTokens: 8_000,
    });
    expect(result.contextWindow).toBe(1_000_000); // from LiteLLM
    expect(result.maxOutputTokens).toBe(8_000); // from row
    expect(result.contextWindowSource).toBe("litellm");
    expect(result.maxOutputTokensSource).toBe("db");
  });

  it("reports cw=db + mo=litellm when only contextWindow is pinned", () => {
    const result = resolveLimits("claude-sonnet-4-6", {
      contextWindow: 200_000,
      maxOutputTokens: null,
    });
    expect(result.contextWindow).toBe(200_000); // from row
    expect(result.maxOutputTokens).toBe(64_000); // from LiteLLM
    expect(result.contextWindowSource).toBe("db");
    expect(result.maxOutputTokensSource).toBe("litellm");
  });
});

describe("resolveLimits — conservative default", () => {
  it("returns the conservative default when neither row nor LiteLLM has data", () => {
    const result = resolveLimits("totally-made-up-model-xyz-2099");
    expect(result).toEqual({
      contextWindow: DEFAULT_LIMITS.contextWindow,
      maxOutputTokens: DEFAULT_LIMITS.maxOutputTokens,
      contextWindowSource: "default",
      maxOutputTokensSource: "default",
    });
  });

  it("merges a partial row override with the default when LiteLLM also misses", () => {
    const result = resolveLimits("totally-made-up-model-xyz-2099", {
      contextWindow: 500_000,
      maxOutputTokens: null,
    });
    expect(result.contextWindow).toBe(500_000);
    expect(result.maxOutputTokens).toBe(DEFAULT_LIMITS.maxOutputTokens);
    expect(result.contextWindowSource).toBe("db");
    expect(result.maxOutputTokensSource).toBe("default");
  });

  it("never throws on unknown models — returns default instead", () => {
    expect(() => resolveLimits("does-not-exist")).not.toThrow();
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
