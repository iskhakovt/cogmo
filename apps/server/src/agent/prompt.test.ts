import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../llm/types.js";
import { DefaultPromptSource, formatUserContext } from "./prompt.js";
import type { Profile } from "./store/index.js";

const testTools: ToolDefinition[] = [
  { name: "web_search", description: "Search the web", parameters: { type: "object" } },
  { name: "memory_recall", description: "Search memory", parameters: { type: "object" } },
];

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "p1",
    userId: null,
    name: "default",
    basePrompt: "",
    model: "m",
    summarizationModel: null,
    extractionModel: null,
    autoRecall: "heuristic",
    voiceMode: "auto",
    toolSet: [],
    memoryScope: null,
    profileClass: null,
    streamChunkChars: 4000,
    streamEdits: true,
    codingAutoapproveMode: "off",
    ...overrides,
  };
}

describe("DefaultPromptSource", () => {
  it("uses profile base prompt as identity section", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: profile({ basePrompt: "You are a coder." }),
      rules: [],
      coreMemory: [],
    });

    expect(prompt).toContain("You are a coder.");
  });

  it("uses default identity when profile is undefined", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: undefined,
      rules: [],
      coreMemory: [],
    });

    expect(prompt).toContain("personal AI assistant");
  });

  it("appends rules as bullet list", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: undefined,
      rules: [{ rule: "Be concise" }, { rule: "Use formal tone" }],
      coreMemory: [],
    });

    expect(prompt).toContain("# Rules");
    expect(prompt).toContain("- Be concise");
    expect(prompt).toContain("- Use formal tone");
  });

  it("auto-generates tools section from definitions", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: undefined,
      rules: [],
      coreMemory: [],
      toolDefinitions: testTools,
    });

    expect(prompt).toContain("# Tools");
    expect(prompt).toContain("**web_search**: Search the web");
    expect(prompt).toContain("**memory_recall**: Search memory");
    expect(prompt).toContain("use them proactively");
  });

  it("omits tools section when no tools registered", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: undefined,
      rules: [],
      coreMemory: [],
      toolDefinitions: [],
    });

    expect(prompt).not.toContain("# Tools");
  });

  it("omits tools section when toolDefinitions is undefined", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: undefined,
      rules: [],
      coreMemory: [],
    });

    expect(prompt).not.toContain("# Tools");
  });

  it("includes service guidance for active namespaces", async () => {
    const prompt = await new DefaultPromptSource({
      serviceGuidance: ["Test memory guidance.", "Test files guidance."],
    }).assemble({ profile: undefined, rules: [], coreMemory: [] });

    expect(prompt).toContain("# Capabilities");
    expect(prompt).toContain("Test memory guidance.");
    expect(prompt).toContain("Test files guidance.");
  });

  it("omits capabilities section when no services active", async () => {
    const prompt = await new DefaultPromptSource({ serviceGuidance: [] }).assemble({
      profile: undefined,
      rules: [],
      coreMemory: [],
    });

    expect(prompt).not.toContain("# Capabilities");
  });

  it("includes current time with timezone", async () => {
    const prompt = await new DefaultPromptSource({ timezone: "UTC" }).assemble({
      profile: undefined,
      rules: [],
      coreMemory: [],
    });

    expect(prompt).toContain("Current time:");
    expect(prompt).toContain("(UTC)");
  });

  it("shows onboarding prompt when there are no core memory blocks", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: undefined,
      rules: [],
      coreMemory: [],
    });

    expect(prompt).toContain("don't know your user yet");
    // Onboarding saves to core memory, so the first block written ends it.
    expect(prompt).toContain("core_memory_update");
    expect(prompt).not.toContain("memory_retain");
  });

  it("renders the core memory blocks it is given as the user section", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: undefined,
      rules: [],
      coreMemory: [{ key: "user_profile", content: "Name: Tim\nTimezone: Europe/Moscow" }],
    });

    expect(prompt).toContain("# User");
    expect(prompt).toContain("Name: Tim");
    expect(prompt).not.toContain("don't know your user yet");
  });

  it("omits rules section when no rules exist", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: undefined,
      rules: [],
      coreMemory: [],
    });

    expect(prompt).not.toContain("# Rules");
  });

  it("assembles sections in correct order", async () => {
    const prompt = await new DefaultPromptSource({
      timezone: "UTC",
      serviceGuidance: ["Test memory guidance."],
    }).assemble({
      profile: undefined,
      rules: [{ rule: "Be kind" }],
      coreMemory: [{ key: "user_profile", content: "Name: Tim" }],
      toolDefinitions: testTools,
    });

    const userIdx = prompt.indexOf("# User");
    const toolsIdx = prompt.indexOf("# Tools");
    const capsIdx = prompt.indexOf("# Capabilities");
    const rulesIdx = prompt.indexOf("# Rules");
    const timeIdx = prompt.indexOf("Current time:");

    expect(userIdx).toBeGreaterThan(0);
    expect(toolsIdx).toBeGreaterThan(userIdx);
    expect(capsIdx).toBeGreaterThan(toolsIdx);
    expect(rulesIdx).toBeGreaterThan(capsIdx);
    expect(timeIdx).toBeGreaterThan(rulesIdx);
  });

  it("appends voice-mode hint when voiceMode is true", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: undefined,
      rules: [],
      coreMemory: [],
      voiceMode: true,
    });

    expect(prompt).toContain("# Voice mode");
    expect(prompt).toContain("spoken aloud");
  });
});

describe("formatUserContext", () => {
  it("is null with no blocks, so the prompt shows the onboarding text", () => {
    expect(formatUserContext([])).toBeNull();
  });

  it("renders each block as a keyed subsection, in order", () => {
    expect(
      formatUserContext([
        { key: "user_profile", content: "Name: Sam" },
        { key: "preferences", content: "- British English" },
      ]),
    ).toBe("## user_profile\nName: Sam\n\n## preferences\n- British English");
  });
});
