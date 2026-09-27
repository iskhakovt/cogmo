import { afterEach, describe, expect, it, vi } from "vitest";
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

  describe("per-turn state", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("renders the same prompt at two different minutes", async () => {
      const source = new DefaultPromptSource({ serviceGuidance: ["Test memory guidance."] });
      const ctx = {
        profile: undefined,
        rules: [{ rule: "Be kind" }],
        coreMemory: [{ key: "user_profile", content: "Name: Tim" }],
        toolDefinitions: testTools,
      };

      vi.useFakeTimers({ now: new Date("2026-09-25T09:14:00Z") });
      const first = await source.assemble(ctx);
      vi.setSystemTime(new Date("2026-09-26T17:45:00Z"));
      const second = await source.assemble(ctx);

      expect(second).toBe(first);
      expect(first).not.toContain("Current time:");
    });

    it("always carries the voice guidance, keyed to the turn context's reply modality", async () => {
      const prompt = await new DefaultPromptSource().assemble({
        profile: undefined,
        rules: [],
        coreMemory: [],
      });

      expect(prompt).toContain("# Turn context");
      expect(prompt).toContain('When it says "Reply modality: voice"');
      expect(prompt).toContain("spoken aloud");
    });
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
    const turnContextIdx = prompt.indexOf("# Turn context");

    expect(userIdx).toBeGreaterThan(0);
    expect(toolsIdx).toBeGreaterThan(userIdx);
    expect(capsIdx).toBeGreaterThan(toolsIdx);
    expect(rulesIdx).toBeGreaterThan(capsIdx);
    expect(turnContextIdx).toBeGreaterThan(rulesIdx);
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
