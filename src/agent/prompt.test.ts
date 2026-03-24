import { describe, expect, it, vi } from "vitest";
import { DefaultPromptSource } from "./prompt.js";

vi.mock("../db/index.js", () => ({ db: {} }));

function mockDb(options: { basePrompt?: string; rules?: Array<{ rule: string }> }) {
  const { basePrompt, rules = [] } = options;

  const profileResult = basePrompt ? [{ basePrompt }] : [];
  const profileLimit = vi.fn().mockResolvedValue(profileResult);
  const profileWhere = vi.fn().mockReturnValue({ limit: profileLimit });
  const profileFrom = vi.fn().mockReturnValue({ where: profileWhere });

  const rulesOrderBy = vi.fn().mockResolvedValue(rules);
  const rulesWhere = vi.fn().mockReturnValue({ orderBy: rulesOrderBy });
  const rulesFrom = vi.fn().mockReturnValue({ where: rulesWhere });

  let callCount = 0;
  const select = vi.fn().mockImplementation(() => {
    callCount++;
    return { from: callCount === 1 ? profileFrom : rulesFrom };
  });

  return { select } as any;
}

describe("DefaultPromptSource", () => {
  it("returns profile base prompt when no rules exist", async () => {
    const db = mockDb({ basePrompt: "You are a coder.", rules: [] });
    const source = new DefaultPromptSource();
    const prompt = await source.assemble(db, "profile-1");

    expect(prompt).toContain("You are a coder.");
    expect(prompt).not.toContain("Rules:");
  });

  it("appends rules as bullet list", async () => {
    const db = mockDb({
      basePrompt: "Base.",
      rules: [{ rule: "Be concise" }, { rule: "Use formal tone" }],
    });
    const source = new DefaultPromptSource();
    const prompt = await source.assemble(db, "profile-1");

    expect(prompt).toContain("Rules:");
    expect(prompt).toContain("- Be concise");
    expect(prompt).toContain("- Use formal tone");
  });

  it("uses default prompt when profile not found", async () => {
    const db = mockDb({ rules: [] });
    const source = new DefaultPromptSource();
    const prompt = await source.assemble(db, "nonexistent");

    expect(prompt).toContain("personal AI assistant");
  });

  it("includes base prompt even with rules", async () => {
    const db = mockDb({ basePrompt: "Custom base.", rules: [{ rule: "Rule 1" }] });
    const source = new DefaultPromptSource();
    const prompt = await source.assemble(db, "profile-1");

    expect(prompt).toContain("Custom base.");
    expect(prompt).toContain("- Rule 1");
  });
});
