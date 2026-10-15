import { describe, expect, it } from "vitest";
import { estimateImageTokens } from "./image-tokens.js";

describe("estimateImageTokens", () => {
  it.each([
    // Claude: 28-px patches, at most 4,784.
    ["claude-sonnet-4-6", 1000, 500, 36 * 18],
    ["anthropic/claude-opus-4.6", 2000, 2000, 4_784],
    ["~anthropic/claude-sonnet-latest", 28, 29, 2],
    // Gemini: at least 1,120; else tiles of 258 at a unit of ⌊short side / 1.5⌋.
    ["gemini-3-pro", 1000, 1000, 1_120],
    ["google/gemini-3-flash", 1500, 300, 8 * 2 * 258],
    // OpenAI patch-based: 32-px patches times the model's multiplier.
    ["gpt-5.4", 1000, 500, Math.ceil(32 * 16 * 1.2)],
    ["openai/gpt-5.6-mini", 1000, 500, Math.ceil(32 * 16 * 1.2)],
    ["gpt-5.5", 100, 100, Math.ceil(16 * 1.2)],
    ["gpt-5.2", 100, 100, Math.ceil(16 * 1.2)],
    ["gpt-6-astra", 100, 100, Math.ceil(16 * 1.2)],
    ["gpt-4.1-mini", 100, 100, Math.ceil(16 * 1.62)],
    ["gpt-4.1-nano", 100, 100, Math.ceil(16 * 2.46)],
    ["o4-mini", 100, 100, Math.ceil(16 * 1.72)],
    // OpenAI tile-based: fit 2048 px, then a 768-px short side, then 512-px tiles.
    ["gpt-4o", 1000, 500, 85 + 170 * 2],
    // 2048 × 512, its short side already under 768.
    ["gpt-4o", 4000, 1000, 85 + 170 * 4],
    // 1920 × 768.
    ["gpt-4o", 2000, 800, 85 + 170 * 4 * 2],
    ["openai/gpt-4.1", 2000, 2000, 85 + 170 * 4],
    ["gpt-4o-mini", 2000, 2000, 2_833 + 5_667 * 4],
    ["gpt-5.1", 512, 512, 70 + 140],
    ["gpt-5", 3000, 3000, 70 + 140 * 4],
    ["gpt-5-mini", 100, 100, 70 + 140],
    // Any other: the larger of Claude and Gemini.
    ["deepseek/deepseek-chat", 280, 280, 1_120],
    ["grok-4", 2000, 1000, Math.max(72 * 36, 4 * 2 * 258)],
  ])("estimates %s at %i × %i as %i", (model, width, height, tokens) => {
    expect(estimateImageTokens(model, { width, height })).toBe(tokens);
  });

  it.each([
    ["claude-sonnet-4-6", 4_784],
    ["gemini-3-pro", 1_120],
    ["gpt-5.4", Math.ceil(63 * 63 * 1.2)],
    ["gpt-4.1-nano", Math.ceil(63 * 63 * 2.46)],
    ["gpt-4o", 85 + 170 * 8],
    ["gpt-4o-mini", 2_833 + 5_667 * 8],
    ["gpt-5", 70 + 140 * 8],
    ["grok-4", 4_784],
  ])("counts an image without dimensions to %s at %i", (model, tokens) => {
    expect(estimateImageTokens(model, {})).toBe(tokens);
  });

  it("counts an image with one dimension as one with none", () => {
    expect(estimateImageTokens("claude-sonnet-4-6", { width: 28 })).toBe(4_784);
  });

  it("keeps the Gemini unit positive for a 1-px side", () => {
    expect(estimateImageTokens("gemini-3-pro", { width: 3, height: 1 })).toBe(1_120);
  });
});
