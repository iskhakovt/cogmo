import { describe, expect, it } from "vitest";
import type { ConversationSummary, Profile } from "../../../agent/store/index.js";
import type { ConversationStatusSummary } from "../../transport.js";
import {
  renderConversationStatus,
  renderModelList,
  renderProfileList,
  renderSessionsList,
} from "./sessions-ux.js";

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

describe("renderConversationStatus", () => {
  function mkStatus(overrides: Partial<ConversationStatusSummary> = {}): ConversationStatusSummary {
    return {
      conversationId: "11111111-2222-3333-4444-aaaaaaaabbbb",
      alias: "work",
      status: "active",
      createdAt: new Date("2026-04-16T10:00:00Z"),
      lastMessageAt: new Date("2026-04-16T11:30:00Z"),
      messageCount: 7,
      profile: {
        id: "p1",
        name: "main",
        model: "claude-sonnet-4-6",
        toolCount: 4,
        autoRecall: "heuristic",
        memoryScope: null,
        voiceMode: "auto",
      },
      voiceMode: null,
      lastTurn: { inputTokens: 23_400, outputTokens: 412 },
      contextBudget: 180_000,
      steeringRulesCount: 2,
      mcp: { enabledServers: 3, approvedTools: 14, toolBudget: 25 },
      ...overrides,
    };
  }
  const NOW = new Date("2026-04-16T13:00:00Z"); // 3h after createdAt, 1h30m after last msg

  it("renders alias and includes profile, last-turn, steering, and MCP lines", () => {
    const text = renderConversationStatus(mkStatus(), NOW);
    expect(text).toContain("work · status: active · age: 3h");
    expect(text).toContain("messages: 7 · idle: 1h");
    expect(text).toContain("main · claude-sonnet-4-6 · tools: 4 · auto-recall: heuristic");
    expect(text).toContain("scope: unrestricted");
    expect(text).toContain("last turn — in: 23.4k · out: 412 · budget: 180k (13%)");
    expect(text).toContain("steering: 2 rules");
    expect(text).toContain("MCP: 3 servers · 14/25 tools");
  });

  it("falls back to id tail when no alias is set", () => {
    const text = renderConversationStatus(mkStatus({ alias: null }), NOW);
    expect(text).toContain("id aaaabbbb");
  });

  it("renders 'no turns yet' when lastTurn is null", () => {
    const text = renderConversationStatus(
      mkStatus({ lastTurn: null, messageCount: 0, lastMessageAt: null }),
      NOW,
    );
    expect(text).toContain("no turns yet · budget: 180k");
    // No idle line when there are no messages.
    expect(text).not.toContain("idle:");
  });

  it("masks the -1 output sentinel as '-' (pre-migration row)", () => {
    const text = renderConversationStatus(
      mkStatus({ lastTurn: { inputTokens: 9000, outputTokens: -1 } }),
      NOW,
    );
    expect(text).toContain("out: -");
    expect(text).not.toContain("-1");
  });

  it("renders 'in: -' when persisted inputTokens is null and skips the percent", () => {
    const text = renderConversationStatus(
      mkStatus({ lastTurn: { inputTokens: null, outputTokens: 200 } }),
      NOW,
    );
    expect(text).toContain("in: - · out: 200 · budget: 180k");
    expect(text).not.toMatch(/\(\d+%\)/);
  });

  it("omits the budget number when contextBudget is null", () => {
    const text = renderConversationStatus(mkStatus({ contextBudget: null }), NOW);
    expect(text).not.toContain("budget:");
  });

  it("omits the MCP line when mcp is null (disabled)", () => {
    const text = renderConversationStatus(mkStatus({ mcp: null }), NOW);
    expect(text).not.toContain("MCP:");
    expect(text).toContain("steering: 2 rules");
  });

  it("renders only the override label when override differs from profile default", () => {
    const text = renderConversationStatus(
      mkStatus({ voiceMode: "always", profile: { ...mkStatus().profile, voiceMode: "auto" } }),
      NOW,
    );
    expect(text).toContain("voice: always (override; profile default auto)");
  });

  it("renders the profile default line when override is null and default is non-auto", () => {
    const text = renderConversationStatus(
      mkStatus({ voiceMode: null, profile: { ...mkStatus().profile, voiceMode: "always" } }),
      NOW,
    );
    expect(text).toContain("voice: always (profile default)");
  });

  it("hides the voice line in the unsurprising case (override=null, default=auto)", () => {
    const text = renderConversationStatus(mkStatus(), NOW);
    expect(text).not.toMatch(/voice:/);
  });

  it("surfaces an explicit override even when it equals the profile default", () => {
    // Regression: an earlier version hid the override when override === default,
    // which lost the fact that the user had explicitly pinned the value (and
    // that `/voice clear` would still change semantics on a future default flip).
    const text = renderConversationStatus(
      mkStatus({ voiceMode: "always", profile: { ...mkStatus().profile, voiceMode: "always" } }),
      NOW,
    );
    expect(text).toContain("voice: always (override matches profile default)");
  });

  it("surfaces an explicit auto override even when the profile default is also auto", () => {
    // Same regression — profile default `auto` is the case that was hidden
    // entirely, dropping the "explicitly overridden" signal on the floor.
    const text = renderConversationStatus(mkStatus({ voiceMode: "auto" }), NOW);
    expect(text).toContain("voice: auto (override matches profile default)");
  });

  it("annotates a set memory scope via formatScope", () => {
    const text = renderConversationStatus(
      mkStatus({
        profile: {
          ...mkStatus().profile,
          memoryScope: { compartments: ["work", "technical"], trust: ["first-party"] },
        },
      }),
      NOW,
    );
    expect(text).toContain("scope: compartments: work, technical / trust: first-party");
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
