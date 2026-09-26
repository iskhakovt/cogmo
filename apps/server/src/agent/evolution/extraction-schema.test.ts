import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toObjectJsonSchema } from "../../llm/json-schema.js";
import { expectDefined } from "../../test/assertions.js";
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

  it("parses a new correction that omits channelType as global", () => {
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
    expect(CorrectionExtractionSchema.parse(input).corrections[0]).toMatchObject({
      action: "new",
      channelType: null,
    });
  });

  it("parses a new correction that omits matchedExistingRuleId as unmatched", () => {
    const input = {
      corrections: [
        {
          rule: "test",
          category: "style",
          reasoning: "test",
          action: "new",
          channelType: "telegram",
        },
      ],
    };
    expect(CorrectionExtractionSchema.parse(input).corrections[0]).toMatchObject({
      action: "new",
      matchedExistingRuleId: null,
      channelType: "telegram",
    });
  });

  it("rejects a new correction that names an existing rule", () => {
    const input = {
      corrections: [
        {
          rule: "test",
          category: "style",
          reasoning: "test",
          matchedExistingRuleId: "rule-123",
          action: "new",
          channelType: null,
        },
      ],
    };
    expect(() => CorrectionExtractionSchema.parse(input)).toThrow();
  });

  it("still asks the model for every field of a new correction", () => {
    // The tolerance is parse-side only: the schema the model is handed keeps
    // both fields required, so omitting them stays off the happy path.
    const json = toObjectJsonSchema(CorrectionExtractionSchema);
    const variants = z
      .object({
        properties: z.object({
          corrections: z.object({
            items: z.object({
              oneOf: z.array(
                z.object({
                  properties: z.object({ action: z.object({ const: z.string() }) }),
                  required: z.array(z.string()),
                }),
              ),
            }),
          }),
        }),
      })
      .parse(json).properties.corrections.items.oneOf;
    const newVariant = expectDefined(
      variants.find((v) => v.properties.action.const === "new"),
      "new-correction variant",
    );
    expect(newVariant.required).toEqual(
      expect.arrayContaining(["matchedExistingRuleId", "channelType"]),
    );
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
  it("includes existing rules when provided, each under its label", () => {
    const prompt = buildExtractionPrompt(
      [
        { rule: "Be concise", category: "style", channelType: null },
        { rule: "Use tables", category: "style", channelType: null },
      ],
      [],
    );
    expect(prompt).toContain("[R1]");
    expect(prompt).toContain("Be concise");
    expect(prompt).toContain("[R2]");
    expect(prompt).toContain("reinforce");
  });

  it("renders channel scope alongside each existing rule", () => {
    const prompt = buildExtractionPrompt(
      [
        { rule: "Be concise", category: "style", channelType: null },
        {
          rule: "No long voice notes",
          category: "style",
          channelType: "telegram",
        },
      ],
      ["telegram"],
    );
    expect(prompt).toContain("[R1] (style, all channels) Be concise");
    expect(prompt).toContain("[R2] (style, channel:telegram) No long voice notes");
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
