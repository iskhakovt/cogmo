import { describe, expect, it } from "vitest";
import type { ConversationSummary, Profile } from "../../../agent/store/index.js";
import { renderModelList, renderProfileList, renderSessionsList } from "./sessions-ux.js";

function mkSummary(overrides: Partial<ConversationSummary> & { id: string }): ConversationSummary {
  return {
    profileName: "assistant",
    alias: null,
    lastMessagePreview: "hi there",
    lastMessageAt: new Date("2026-04-16T12:00:00Z"),
    ...overrides,
  };
}

function mkProfile(overrides: Partial<Profile> & { id: string; name: string }): Profile {
  return {
    userId: null,
    basePrompt: "",
    model: "claude-sonnet-4-6",
    summarizationModel: null,
    extractionModel: null,
    autoRecall: "heuristic",
    toolSet: [],
    ...overrides,
  };
}

describe("renderSessionsList", () => {
  it("returns keyboard with one button per conversation when below threshold", () => {
    const list = [
      mkSummary({ id: "c1", alias: "work" }),
      mkSummary({ id: "c2", lastMessagePreview: "grocery plan for Saturday" }),
    ];
    const rendered = renderSessionsList(list);
    expect(rendered.buttons).toBeDefined();
    expect(rendered.buttons).toHaveLength(2);
    expect(rendered.buttons?.[0]?.text).toBe("work");
    expect(rendered.buttons?.[0]?.callbackData).toBe("resume:work");
    expect(rendered.buttons?.[1]?.callbackData).toBe("resume:c2");
  });

  it("falls back to numbered text list when above threshold", () => {
    const list = Array.from({ length: 12 }, (_, i) =>
      mkSummary({ id: `c${i + 1}`, alias: `a${i + 1}` }),
    );
    const rendered = renderSessionsList(list);
    expect(rendered.buttons).toBeUndefined();
    // 12 lines
    expect(rendered.text.split("\n")).toHaveLength(12);
    expect(rendered.text).toContain("1. a1 — /resume a1");
    expect(rendered.text).toContain("12. a12 — /resume a12");
  });

  it("marks the current conversation with (current) in text mode", () => {
    const list = Array.from({ length: 12 }, (_, i) =>
      mkSummary({ id: `c${i + 1}`, alias: `a${i + 1}` }),
    );
    const rendered = renderSessionsList(list, { currentConversationId: "c3" });
    expect(rendered.text).toContain("3. a3 — /resume a3 (current)");
  });

  it("marks the current conversation inline in keyboard mode", () => {
    const list = [mkSummary({ id: "c1", alias: "work" }), mkSummary({ id: "c2", alias: "home" })];
    const rendered = renderSessionsList(list, { currentConversationId: "c2" });
    expect(rendered.buttons?.[1]?.text).toContain("← current");
  });

  it("honors a custom threshold", () => {
    const list = [mkSummary({ id: "c1" }), mkSummary({ id: "c2" })];
    const rendered = renderSessionsList(list, { threshold: 1 });
    expect(rendered.buttons).toBeUndefined();
  });

  it("returns empty-state message when list is empty", () => {
    expect(renderSessionsList([]).text).toContain("No other conversations");
  });
});

describe("renderProfileList", () => {
  it("shows scope + model + current marker", () => {
    const profiles = [
      mkProfile({ id: "p1", name: "assistant", userId: null }),
      mkProfile({ id: "p2", name: "coder", userId: "u1" }),
    ];
    const rendered = renderProfileList(profiles, { currentProfileId: "p2" });
    expect(rendered.text).toContain("• assistant (org, claude-sonnet-4-6)");
    expect(rendered.text).toContain("• coder (you, claude-sonnet-4-6) ← current");
  });

  it("annotates profiles with a memoryScope set; unscoped profiles render unchanged", () => {
    const profiles = [
      mkProfile({ id: "p1", name: "open", userId: "u1" }),
      mkProfile({
        id: "p2",
        name: "work",
        userId: "u1",
        memoryScope: { compartments: ["work", "technical"], trust: ["first-party"] },
      }),
    ];
    const rendered = renderProfileList(profiles);
    expect(rendered.text).toContain("• open (you, claude-sonnet-4-6)");
    // No annotation when scope is null.
    expect(rendered.text).not.toMatch(/open .*\[scope:/);
    // Inline annotation when scope is set.
    // Reuses the canonical `formatScope` so the list view never drifts
    // from the show-reply view.
    expect(rendered.text).toContain(
      "• work (you, claude-sonnet-4-6) [compartments: work, technical / trust: first-party]",
    );
  });

  it("handles empty list", () => {
    expect(renderProfileList([]).text).toContain("No profiles");
  });
});

describe("renderModelList", () => {
  it("marks current model", () => {
    const text = renderModelList(["claude-sonnet-4-6", "gpt-4o"], {
      currentModel: "gpt-4o",
    });
    expect(text).toContain("• claude-sonnet-4-6");
    expect(text).toContain("• gpt-4o ← current");
  });

  it("handles empty list", () => {
    expect(renderModelList([])).toContain("No user-selectable");
  });
});
