import { describe, expect, it } from "vitest";
import { buildExtractionPrompt, CorrectionExtractionSchema } from "./extraction-schema.js";

describe("CorrectionExtractionSchema", () => {
  it("parses valid extraction with corrections", () => {
    const input = {
      corrections: [
        {
          rule: "Be more concise",
          category: "style",
          reasoning: "User asked for shorter responses",
          matchedExistingRuleId: null,
          action: "new",
        },
      ],
    };
    expect(CorrectionExtractionSchema.parse(input)).toEqual(input);
  });

  it("parses empty corrections array", () => {
    const input = { corrections: [] };
    expect(CorrectionExtractionSchema.parse(input)).toEqual(input);
  });

  it("accepts reinforcement with existing rule ID", () => {
    const input = {
      corrections: [
        {
          rule: "Be concise",
          category: "style",
          reasoning: "Same as before",
          matchedExistingRuleId: "rule-123",
          action: "reinforce",
        },
      ],
    };
    expect(CorrectionExtractionSchema.parse(input)).toEqual(input);
  });

  it("rejects invalid category", () => {
    const input = {
      corrections: [
        {
          rule: "test",
          category: "safety",
          reasoning: "test",
          matchedExistingRuleId: null,
          action: "new",
        },
      ],
    };
    expect(() => CorrectionExtractionSchema.parse(input)).toThrow();
  });

  it("rejects missing required fields", () => {
    const input = { corrections: [{ rule: "test" }] };
    expect(() => CorrectionExtractionSchema.parse(input)).toThrow();
  });
});

describe("buildExtractionPrompt", () => {
  it("includes existing rules when provided", () => {
    const prompt = buildExtractionPrompt([
      { id: "r1", rule: "Be concise", category: "style" },
      { id: "r2", rule: "Use tables", category: "style" },
    ]);
    expect(prompt).toContain("[r1]");
    expect(prompt).toContain("Be concise");
    expect(prompt).toContain("[r2]");
    expect(prompt).toContain("reinforce");
  });

  it("handles empty existing rules", () => {
    const prompt = buildExtractionPrompt([]);
    expect(prompt).toContain("No existing rules");
    expect(prompt).not.toContain("reinforce");
  });

  it("includes tool misuse guidance", () => {
    const prompt = buildExtractionPrompt([]);
    expect(prompt).toContain("Tool misuse");
    expect(prompt).toContain("[Tool:");
  });
});
