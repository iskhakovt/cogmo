import { describe, expect, it } from "vitest";
import type { Message } from "../llm/types.js";
import { computeHealPlan, isNoOp } from "./heal-plan.js";

function row(id: string, message: Message): { id: string; message: Message } {
  return { id, message };
}

describe("computeHealPlan", () => {
  it("returns a no-op when validated matches originals", () => {
    const originals = [
      row("m1", { role: "user", content: "hi" }),
      row("m2", { role: "assistant", content: [{ type: "text", text: "hello" }] }),
    ];
    const validated: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    const plan = computeHealPlan(originals, validated);
    expect(plan.supersededIds).toEqual([]);
    expect(plan.insertions).toEqual([]);
    expect(plan.divergenceIndex).toBe(2);
    expect(isNoOp(plan)).toBe(true);
  });

  // Production case: orphan tool_use followed by user text. Validator
  // synthesizes a tool_result and merges with the user message. Heal plan:
  // supersede m3 (the user "are you there?" row), insert one new row with
  // the merged content. m3's text "are you there?" survives in the new row.
  it("orphan + user text → supersede last row, insert merged replacement", () => {
    const originals = [
      row("m1", { role: "user", content: "hi" }),
      row("m2", {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "echo", input: {} }],
      }),
      row("m3", { role: "user", content: "are you there?" }),
    ];
    const validated: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "echo", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "t1",
            content: "tool execution did not complete (recovered)",
            isError: true,
          },
          { type: "text", text: "are you there?" },
        ],
      },
    ];
    const plan = computeHealPlan(originals, validated);
    expect(plan.supersededIds).toEqual(["m3"]);
    expect(plan.insertions).toHaveLength(1);
    expect(plan.divergenceIndex).toBe(2);
    // Content preservation: "are you there?" survives in the new merged row
    const replacement = plan.insertions[0]!;
    expect(replacement.role).toBe("user");
    expect(Array.isArray(replacement.content)).toBe(true);
    const blocks = replacement.content as Array<{ type: string; text?: string }>;
    expect(blocks.find((b) => b.type === "text")?.text).toBe("are you there?");
  });

  // Orphan with no answering message — assistant tool_use is the last row.
  // Validator appends a synthetic user tool_result. Heal plan: no supersede,
  // single insertion.
  it("orphan at tail → insert without superseding", () => {
    const originals = [
      row("m1", { role: "user", content: "go" }),
      row("m2", {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "echo", input: {} }],
      }),
    ];
    const validated: Message[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "echo", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "t1",
            content: "tool execution did not complete (recovered)",
            isError: true,
          },
        ],
      },
    ];
    const plan = computeHealPlan(originals, validated);
    expect(plan.supersededIds).toEqual([]);
    expect(plan.insertions).toHaveLength(1);
    expect(plan.divergenceIndex).toBe(2);
  });

  // Stray tool_result drop. m3 had `[stray_tool_result, "real text"]`;
  // validator strips the stray. Heal supersedes m3 and inserts a new row
  // with just "real text" — content preserved.
  it("stray tool_result drop preserves text content in replacement", () => {
    const originals = [
      row("m1", { role: "user", content: "hi" }),
      row("m2", { role: "assistant", content: [{ type: "text", text: "hello" }] }),
      row("m3", {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "ghost", content: "stray" },
          { type: "text", text: "real text" },
        ],
      }),
    ];
    const validated: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: [{ type: "text", text: "real text" }] },
    ];
    const plan = computeHealPlan(originals, validated);
    expect(plan.supersededIds).toEqual(["m3"]);
    expect(plan.insertions).toHaveLength(1);
    const blocks = plan.insertions[0]!.content as Array<{ type: string; text?: string }>;
    expect(blocks).toEqual([{ type: "text", text: "real text" }]);
  });

  // Empty content drop with no replacement. Validator drops a trailing
  // empty assistant message. Heal supersedes m3 with no insertion —
  // applyHeal will set superseded_at on m3 with superseded_by=null.
  it("trailing empty drop → supersede without insertion", () => {
    const originals = [
      row("m1", { role: "user", content: "hi" }),
      row("m2", { role: "assistant", content: [{ type: "text", text: "hello" }] }),
      row("m3", { role: "assistant", content: [] }),
    ];
    const validated: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    const plan = computeHealPlan(originals, validated);
    expect(plan.supersededIds).toEqual(["m3"]);
    expect(plan.insertions).toEqual([]);
    expect(plan.divergenceIndex).toBe(2);
  });

  // Mid-history empty drop — m1 (empty) gets dropped at the head. The valid
  // tail m2 survives. Heal supersedes everything from m1 onward and
  // re-inserts the validated tail (m2's content, freshly stamped).
  it("head empty drop → supersede all, re-insert validated tail", () => {
    const originals = [
      row("m1", { role: "user", content: "" }),
      row("m2", { role: "user", content: "hi" }),
    ];
    const validated: Message[] = [{ role: "user", content: "hi" }];
    const plan = computeHealPlan(originals, validated);
    expect(plan.supersededIds).toEqual(["m1", "m2"]);
    expect(plan.insertions).toEqual([{ role: "user", content: "hi" }]);
    expect(plan.divergenceIndex).toBe(0);
  });

  // Multiple repairs in series: orphan tool_use mid-history followed by
  // an unanswering second assistant. Validator inserts a synthetic user
  // tool_result between them, so divergence index 2 captures everything
  // from there onward.
  it("multi-repair tail rewrites everything from divergence onward", () => {
    const originals = [
      row("m1", { role: "user", content: "go" }),
      row("m2", {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "echo", input: {} }],
      }),
      row("m3", { role: "assistant", content: [{ type: "text", text: "i forgot" }] }),
    ];
    const validated: Message[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "echo", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "t1",
            content: "tool execution did not complete (recovered)",
            isError: true,
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "i forgot" }] },
    ];
    const plan = computeHealPlan(originals, validated);
    expect(plan.supersededIds).toEqual(["m3"]);
    expect(plan.insertions).toHaveLength(2);
    expect(plan.divergenceIndex).toBe(2);
    // m3's "i forgot" content survives as the second insertion
    const reinserted = plan.insertions[1]!.content as Array<{ type: string; text?: string }>;
    expect(reinserted).toEqual([{ type: "text", text: "i forgot" }]);
  });

  it("does not mutate input arrays", () => {
    const originals = [row("m1", { role: "user", content: "hi" })];
    const validated: Message[] = [{ role: "user", content: "hi" }];
    const beforeOrig = JSON.parse(JSON.stringify(originals));
    const beforeVal = JSON.parse(JSON.stringify(validated));
    computeHealPlan(originals, validated);
    expect(originals).toEqual(beforeOrig);
    expect(validated).toEqual(beforeVal);
  });
});

describe("isNoOp", () => {
  it("returns true when both arrays empty", () => {
    expect(isNoOp({ supersededIds: [], insertions: [], divergenceIndex: 0 })).toBe(true);
  });

  it("returns false when there are insertions", () => {
    expect(
      isNoOp({
        supersededIds: [],
        insertions: [{ role: "user", content: "hi" }],
        divergenceIndex: 0,
      }),
    ).toBe(false);
  });

  it("returns false when there are supersededIds", () => {
    expect(isNoOp({ supersededIds: ["m1"], insertions: [], divergenceIndex: 0 })).toBe(false);
  });
});
