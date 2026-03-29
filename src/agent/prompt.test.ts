import { describe, expect, it, vi } from "vitest";
import { mockAgentStore } from "../test/factories.js";
import { DefaultPromptSource } from "./prompt.js";

describe("DefaultPromptSource", () => {
  it("returns profile base prompt when no rules exist", async () => {
    const store = mockAgentStore({
      getProfile: vi
        .fn()
        .mockResolvedValue({ id: "p1", basePrompt: "You are a coder.", model: "m", toolSet: [] }),
      getActiveRules: vi.fn().mockResolvedValue([]),
    });
    const prompt = await new DefaultPromptSource().assemble(store, "p1");

    expect(prompt).toContain("You are a coder.");
    expect(prompt).not.toContain("Rules:");
  });

  it("appends rules as bullet list", async () => {
    const store = mockAgentStore({
      getProfile: vi
        .fn()
        .mockResolvedValue({ id: "p1", basePrompt: "Base.", model: "m", toolSet: [] }),
      getActiveRules: vi
        .fn()
        .mockResolvedValue([{ rule: "Be concise" }, { rule: "Use formal tone" }]),
    });
    const prompt = await new DefaultPromptSource().assemble(store, "p1");

    expect(prompt).toContain("Rules:");
    expect(prompt).toContain("- Be concise");
    expect(prompt).toContain("- Use formal tone");
  });

  it("uses default prompt when profile not found", async () => {
    const store = mockAgentStore({
      getProfile: vi.fn().mockResolvedValue(null),
      getActiveRules: vi.fn().mockResolvedValue([]),
    });
    const prompt = await new DefaultPromptSource().assemble(store, "nonexistent");

    expect(prompt).toContain("personal AI assistant");
  });

  it("includes base prompt even with rules", async () => {
    const store = mockAgentStore({
      getProfile: vi
        .fn()
        .mockResolvedValue({ id: "p1", basePrompt: "Custom base.", model: "m", toolSet: [] }),
      getActiveRules: vi.fn().mockResolvedValue([{ rule: "Rule 1" }]),
    });
    const prompt = await new DefaultPromptSource().assemble(store, "p1");

    expect(prompt).toContain("Custom base.");
    expect(prompt).toContain("- Rule 1");
  });
});
