import { describe, expect, it } from "vitest";
import {
  buildClassifiedMemorySchema,
  buildCompartmentDefinitions,
  buildCompartmentSchema,
  buildMemoryExtractionPrompt,
  buildMemoryExtractionSchema,
  buildPendingClassificationPrompt,
  CORE_COMPARTMENTS,
} from "./memory-extraction-schema.js";

describe("buildCompartmentSchema", () => {
  it("accepts every core compartment", () => {
    const schema = buildCompartmentSchema([]);
    for (const c of CORE_COMPARTMENTS) {
      expect(schema.parse(c)).toBe(c);
    }
  });

  it("accepts custom values when registered", () => {
    const schema = buildCompartmentSchema(["dnd", "music"]);
    expect(schema.parse("dnd")).toBe("dnd");
    expect(schema.parse("music")).toBe("music");
    // Core still works alongside customs.
    expect(schema.parse("personal")).toBe("personal");
  });

  it("rejects values that are neither core nor custom", () => {
    const schema = buildCompartmentSchema(["dnd"]);
    expect(() => schema.parse("music")).toThrow();
    expect(() => schema.parse("WORK")).toThrow();
    expect(() => schema.parse("")).toThrow();
  });
});

describe("buildCompartmentDefinitions", () => {
  it("returns the core block alone when no customs are supplied", () => {
    const out = buildCompartmentDefinitions([]);
    expect(out).toContain("**personal**");
    expect(out).toContain("**misc**");
    expect(out).not.toContain("Custom compartments");
  });

  it("appends custom blocks plus a core-preference rule when customs are supplied", () => {
    const out = buildCompartmentDefinitions([
      { name: "dnd", description: "tabletop campaign notes" },
      { name: "music", description: "music production sessions" },
    ]);
    expect(out).toContain("**personal**");
    expect(out).toContain("Custom compartments (configured for this user)");
    expect(out).toContain("**dnd**: tabletop campaign notes");
    expect(out).toContain("**music**: music production sessions");
    expect(out).toContain("pick the custom");
  });
});

describe("buildMemoryExtractionPrompt + buildPendingClassificationPrompt", () => {
  it("templates customs into both prompts so the classifier sees the same set", () => {
    const customs = [{ name: "dnd", description: "campaign notes" }];
    const extraction = buildMemoryExtractionPrompt(customs);
    const pending = buildPendingClassificationPrompt(customs);
    for (const p of [extraction, pending]) {
      expect(p).toContain("**dnd**: campaign notes");
      expect(p).toContain("Custom compartments");
    }
  });

  it("omits the custom block when customs are empty (single-user / pre-feature shape)", () => {
    const extraction = buildMemoryExtractionPrompt([]);
    expect(extraction).not.toContain("Custom compartments");
    expect(extraction).toContain("**misc**");
  });
});

describe("buildMemoryExtractionSchema + buildClassifiedMemorySchema", () => {
  it("locks the structured-output compartment field to core ∪ customs", () => {
    const extracted = buildMemoryExtractionSchema(["dnd"]);
    const ok = extracted.safeParse({
      memories: [
        {
          fact: "campaign uses Stars Without Number rules",
          network: "world",
          compartment: "dnd",
          trust: "first-party",
        },
      ],
    });
    expect(ok.success).toBe(true);
    const bad = extracted.safeParse({
      memories: [
        {
          fact: "x",
          network: "world",
          compartment: "music",
          trust: "first-party",
        },
      ],
    });
    expect(bad.success).toBe(false);
  });

  it("classified-memory schema mirrors the same set", () => {
    const classified = buildClassifiedMemorySchema(["music"]);
    expect(
      classified.safeParse({ network: "bank", compartment: "music", trust: "first-party" }).success,
    ).toBe(true);
    expect(
      classified.safeParse({ network: "bank", compartment: "dnd", trust: "first-party" }).success,
    ).toBe(false);
  });
});
