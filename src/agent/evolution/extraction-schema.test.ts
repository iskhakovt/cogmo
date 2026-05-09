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
          channelType: null,
        },
      ],
    };
    expect(CorrectionExtractionSchema.parse(input)).toEqual(input);
  });

  it("parses new correction with explicit channelType", () => {
    const input = {
      corrections: [
        {
          rule: "Avoid markdown headings",
          category: "style",
          reasoning: "Preference scoped to chat medium",
          matchedExistingRuleId: null,
          action: "new",
          channelType: "telegram",
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
          channelType: null,
        },
      ],
    };
    expect(() => CorrectionExtractionSchema.parse(input)).toThrow();
  });

  it("rejects missing required fields", () => {
    const input = { corrections: [{ rule: "test" }] };
    expect(() => CorrectionExtractionSchema.parse(input)).toThrow();
  });

  it("rejects new correction missing channelType", () => {
    const input = {
      corrections: [
        {
          rule: "test",
          category: "style",
          reasoning: "test",
          matchedExistingRuleId: null,
          action: "new",
        },
      ],
    };
    expect(() => CorrectionExtractionSchema.parse(input)).toThrow();
  });

  it("rejects reinforce with null matchedExistingRuleId", () => {
    const input = {
      corrections: [
        {
          rule: "Be concise",
          category: "style",
          reasoning: "test",
          matchedExistingRuleId: null,
          action: "reinforce",
        },
      ],
    };
    expect(() => CorrectionExtractionSchema.parse(input)).toThrow();
  });

  it("rejects contradiction with null matchedExistingRuleId", () => {
    const input = {
      corrections: [
        {
          rule: "Be verbose",
          category: "style",
          reasoning: "test",
          matchedExistingRuleId: null,
          action: "contradiction",
        },
      ],
    };
    expect(() => CorrectionExtractionSchema.parse(input)).toThrow();
  });
});

describe("buildExtractionPrompt", () => {
  it("includes existing rules when provided", () => {
    const prompt = buildExtractionPrompt(
      [
        { id: "r1", rule: "Be concise", category: "style", channelType: null },
        { id: "r2", rule: "Use tables", category: "style", channelType: null },
      ],
      [],
    );
    expect(prompt).toContain("[r1]");
    expect(prompt).toContain("Be concise");
    expect(prompt).toContain("[r2]");
    expect(prompt).toContain("reinforce");
  });

  it("renders channel scope alongside each existing rule", () => {
    const prompt = buildExtractionPrompt(
      [
        { id: "r1", rule: "Be concise", category: "style", channelType: null },
        {
          id: "r2",
          rule: "No long voice notes",
          category: "style",
          channelType: "telegram",
        },
      ],
      ["telegram"],
    );
    expect(prompt).toContain("[r1] (style, all channels) Be concise");
    expect(prompt).toContain("[r2] (style, channel:telegram) No long voice notes");
  });

  it("handles empty existing rules", () => {
    const prompt = buildExtractionPrompt([], []);
    expect(prompt).toContain("No existing rules");
    expect(prompt).not.toContain("reinforce");
  });

  it("includes tool misuse guidance", () => {
    const prompt = buildExtractionPrompt([], []);
    expect(prompt).toContain("Tool misuse");
    expect(prompt).toContain("[Tool:");
  });

  it("lists active channel types and instructs the LLM how to scope new rules", () => {
    const prompt = buildExtractionPrompt([], ["telegram", "direct"]);
    expect(prompt).toContain("`telegram`");
    expect(prompt).toContain("`direct`");
    expect(prompt).toContain("Default to `null` when in doubt");
  });

  it("falls back to a no-channels message when no active channel types resolved", () => {
    const prompt = buildExtractionPrompt([], []);
    expect(prompt).toContain("No active channels were resolved");
  });
});
