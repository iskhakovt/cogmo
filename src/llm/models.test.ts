import { describe, expect, it } from "vitest";
import { computeBudget, getModelLimits } from "./models.js";

describe("model registry", () => {
  it("returns limits for a known Anthropic model", () => {
    const limits = getModelLimits("claude-sonnet-4-20250514");
    expect(limits).toEqual({ contextWindow: 200_000, maxOutputTokens: 16_384 });
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
    // claude-sonnet-4: 200_000 - 16_384 - 10_000 = 173_616
    expect(computeBudget("claude-sonnet-4-20250514")).toBe(173_616);
  });

  it("accepts custom safety buffer", () => {
    // 200_000 - 16_384 - 5_000 = 178_616
    expect(computeBudget("claude-sonnet-4-20250514", 5_000)).toBe(178_616);
  });

  it("throws on unknown model", () => {
    expect(() => computeBudget("nonexistent")).toThrow("Unknown model");
  });
});
