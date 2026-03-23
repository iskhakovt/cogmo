import { describe, expect, it, vi } from "vitest";
import { assembleSystemPrompt } from "./prompt.js";

// Mock the db module — we don't want real database calls
vi.mock("../db/index.js", () => ({ db: {} }));

function mockDb(rules: Array<{ rule: string }>) {
  // Build a chainable query mock: db.select().from().where().orderBy() → rules
  const orderBy = vi.fn().mockResolvedValue(rules);
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select } as any;
}

describe("assembleSystemPrompt", () => {
  it("returns base prompt when no rules exist", async () => {
    const db = mockDb([]);
    const prompt = await assembleSystemPrompt(db);

    expect(prompt).toContain("personal AI assistant");
    expect(prompt).not.toContain("Rules:");
  });

  it("appends rules as bullet list", async () => {
    const db = mockDb([{ rule: "Be concise" }, { rule: "Use formal tone" }]);
    const prompt = await assembleSystemPrompt(db);

    expect(prompt).toContain("Rules:");
    expect(prompt).toContain("- Be concise");
    expect(prompt).toContain("- Use formal tone");
  });

  it("includes base prompt even with rules", async () => {
    const db = mockDb([{ rule: "Rule 1" }]);
    const prompt = await assembleSystemPrompt(db);

    expect(prompt).toContain("personal AI assistant");
    expect(prompt).toContain("- Rule 1");
  });
});
