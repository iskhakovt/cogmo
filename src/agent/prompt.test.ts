import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../llm/types.js";
import { mockAgentStore } from "../test/factories.js";
import { DefaultPromptSource } from "./prompt.js";

const testTools: ToolDefinition[] = [
  { name: "web_search", description: "Search the web", parameters: { type: "object" } },
  { name: "memory_recall", description: "Search memory", parameters: { type: "object" } },
];

describe("DefaultPromptSource", () => {
  it("uses profile base prompt as identity section", async () => {
    const store = mockAgentStore({
      getProfile: vi
        .fn()
        .mockResolvedValue({ id: "p1", basePrompt: "You are a coder.", model: "m", toolSet: [] }),
      getActiveRules: vi.fn().mockResolvedValue([]),
    });
    const prompt = await new DefaultPromptSource().assemble(store, "p1");

    expect(prompt).toContain("You are a coder.");
  });

  it("uses default identity when profile has no base prompt", async () => {
    const store = mockAgentStore({
      getProfile: vi.fn().mockResolvedValue(null),
      getActiveRules: vi.fn().mockResolvedValue([]),
    });
    const prompt = await new DefaultPromptSource().assemble(store, "nonexistent");

    expect(prompt).toContain("personal AI assistant");
  });

  it("appends rules as bullet list", async () => {
    const store = mockAgentStore({
      getProfile: vi.fn().mockResolvedValue(null),
      getActiveRules: vi
        .fn()
        .mockResolvedValue([{ rule: "Be concise" }, { rule: "Use formal tone" }]),
    });
    const prompt = await new DefaultPromptSource().assemble(store, "p1");

    expect(prompt).toContain("# Rules");
    expect(prompt).toContain("- Be concise");
    expect(prompt).toContain("- Use formal tone");
  });

  it("auto-generates tools section from definitions", async () => {
    const store = mockAgentStore({
      getProfile: vi.fn().mockResolvedValue(null),
      getActiveRules: vi.fn().mockResolvedValue([]),
    });
    const prompt = await new DefaultPromptSource({
      toolDefinitions: () => testTools,
    }).assemble(store, "p1");

    expect(prompt).toContain("# Tools");
    expect(prompt).toContain("**web_search**: Search the web");
    expect(prompt).toContain("**memory_recall**: Search memory");
    expect(prompt).toContain("use them proactively");
  });

  it("omits tools section when no tools registered", async () => {
    const store = mockAgentStore({
      getProfile: vi.fn().mockResolvedValue(null),
      getActiveRules: vi.fn().mockResolvedValue([]),
    });
    const prompt = await new DefaultPromptSource({
      toolDefinitions: () => [],
    }).assemble(store, "p1");

    expect(prompt).not.toContain("# Tools");
  });

  it("includes service guidance for active namespaces", async () => {
    const store = mockAgentStore({
      getProfile: vi.fn().mockResolvedValue(null),
      getActiveRules: vi.fn().mockResolvedValue([]),
    });
    const prompt = await new DefaultPromptSource({
      activeServices: ["memory", "files"],
    }).assemble(store, "p1");

    expect(prompt).toContain("# Capabilities");
    expect(prompt).toContain("persistent memory");
    expect(prompt).toContain("file workspace");
  });

  it("omits capabilities section when no services active", async () => {
    const store = mockAgentStore({
      getProfile: vi.fn().mockResolvedValue(null),
      getActiveRules: vi.fn().mockResolvedValue([]),
    });
    const prompt = await new DefaultPromptSource({
      activeServices: [],
    }).assemble(store, "p1");

    expect(prompt).not.toContain("# Capabilities");
  });

  it("includes current time with timezone", async () => {
    const store = mockAgentStore({
      getProfile: vi.fn().mockResolvedValue(null),
      getActiveRules: vi.fn().mockResolvedValue([]),
    });
    const prompt = await new DefaultPromptSource({ timezone: "UTC" }).assemble(store, "p1");

    expect(prompt).toContain("Current time:");
    expect(prompt).toContain("(UTC)");
  });

  it("shows onboarding prompt when user context is not available", async () => {
    const store = mockAgentStore({
      getProfile: vi.fn().mockResolvedValue(null),
      getActiveRules: vi.fn().mockResolvedValue([]),
    });
    const prompt = await new DefaultPromptSource({
      getUserContext: async () => null,
    }).assemble(store, "p1");

    expect(prompt).toContain("don't know your user yet");
  });

  it("injects user context when available", async () => {
    const store = mockAgentStore({
      getProfile: vi.fn().mockResolvedValue(null),
      getActiveRules: vi.fn().mockResolvedValue([]),
    });
    const prompt = await new DefaultPromptSource({
      getUserContext: async () => "Name: Tim\nTimezone: Europe/Moscow",
    }).assemble(store, "p1");

    expect(prompt).toContain("# User");
    expect(prompt).toContain("Name: Tim");
    expect(prompt).not.toContain("don't know your user yet");
  });

  it("omits rules section when no rules exist", async () => {
    const store = mockAgentStore({
      getProfile: vi.fn().mockResolvedValue(null),
      getActiveRules: vi.fn().mockResolvedValue([]),
    });
    const prompt = await new DefaultPromptSource().assemble(store, "p1");

    expect(prompt).not.toContain("# Rules");
  });
});
