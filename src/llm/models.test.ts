import { describe, expect, it } from "vitest";
import { computeBudget, getModelLimits } from "./models.js";

describe("model registry", () => {
  it("returns limits for a known Anthropic model", () => {
    const limits = getModelLimits("claude-sonnet-4-6");
    expect(limits).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 64_000 });
  });

  it("returns limits for a known OpenAI model", () => {
    const limits = getModelLimits("gpt-4o");
    expect(limits).toEqual({ contextWindow: 128_000, maxOutputTokens: 16_384 });
  });

  it("throws on unknown model with helpful message", () => {
    expect(() => getModelLimits("unknown-model")).toThrow(
      'Unknown model "unknown-model" — add it to MODEL_REGISTRY in src/llm/models.ts',
    );
  });
});

describe("computeBudget", () => {
  it("returns contextWindow - maxOutputTokens - safetyBuffer", () => {
    // claude-sonnet-4-6: 1_000_000 - 64_000 - 10_000 = 926_000
    expect(computeBudget("claude-sonnet-4-6")).toBe(926_000);
  });

  it("accepts custom safety buffer", () => {
    // 1_000_000 - 64_000 - 5_000 = 931_000
    expect(computeBudget("claude-sonnet-4-6", 5_000)).toBe(931_000);
  });

  it("throws on unknown model", () => {
    expect(() => computeBudget("nonexistent")).toThrow("Unknown model");
  });
});
