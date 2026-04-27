import { describe, expect, it } from "vitest";
import { describeToolCall, describeToolResult, formatProgressMessage } from "./progress-format.js";

describe("formatProgressMessage", () => {
  it("planning phase: header + truncated goal + body", () => {
    const out = formatProgressMessage({
      goal: "refactor steering rules to support per-channel scoping",
      phase: "planning",
      body: "## Plan\n1. Step",
    });
    expect(out).toContain("🧠 Planning");
    expect(out).toContain("refactor steering rules");
    expect(out).toContain("## Plan\n1. Step");
  });

  it("awaiting_approval header signals plan-ready state", () => {
    const out = formatProgressMessage({
      goal: "g",
      phase: "awaiting_approval",
      body: "## Plan",
    });
    expect(out).toMatch(/Plan ready/);
  });

  it("executing phase shows last activity line", () => {
    const out = formatProgressMessage({
      goal: "g",
      phase: "executing",
      body: "Adding foo()...\n",
      lastActivity: "Edit ✓ — wrote foo.ts",
    });
    expect(out).toContain("⚙️ Executing");
    expect(out).toContain("↻ Edit ✓");
  });

  it("activity line is suppressed outside executing", () => {
    const out = formatProgressMessage({
      goal: "g",
      phase: "planning",
      body: "",
      lastActivity: "Read foo.ts",
    });
    expect(out).not.toContain("Read foo.ts");
  });

  it("renders token counter once provided", () => {
    const out = formatProgressMessage({
      goal: "g",
      phase: "executing",
      body: "",
      tokens: { input: 1234, output: 567 },
    });
    expect(out).toContain("1,801 tokens");
    expect(out).toContain("in 1,234");
    expect(out).toContain("out 567");
  });

  it("failed phase surfaces the failure reason in the status line", () => {
    const out = formatProgressMessage({
      goal: "g",
      phase: "failed",
      body: "",
      failureReason: "claude exit code 2",
    });
    expect(out).toContain("❌ Failed");
    expect(out).toContain("claude exit code 2");
  });

  it("truncates the goal preview at 80 chars", () => {
    const out = formatProgressMessage({
      goal: "x".repeat(200),
      phase: "planning",
      body: "",
    });
    const headerLine = out.split("\n")[0];
    // header plus goal preview (≤80 chars) plus the trailing ellipsis.
    expect(headerLine.length).toBeLessThanOrEqual("🧠 Planning — ".length + 80);
    expect(headerLine).toMatch(/…$/);
  });

  it("truncates a body that exceeds the cap, keeping the tail", () => {
    const tail = "TAIL CONTENT";
    const long = `${"x".repeat(5000)}\n${tail}`;
    const out = formatProgressMessage({
      goal: "g",
      phase: "executing",
      body: long,
    });
    expect(out).toContain(tail);
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(4096);
  });

  it("omits the body section when empty", () => {
    const out = formatProgressMessage({
      goal: "g",
      phase: "planning",
      body: "",
    });
    // No blank-line-then-body: just the header line(s).
    expect(out).toBe("🧠 Planning — g");
  });
});

describe("describeToolCall / describeToolResult", () => {
  it("describeToolCall is short and ends with ellipsis", () => {
    expect(describeToolCall("Read")).toBe("Read…");
  });

  it("describeToolResult marks success and failure visually", () => {
    expect(describeToolResult("Edit", true)).toContain("✓");
    expect(describeToolResult("Bash", false)).toContain("✗");
  });

  it("describeToolResult truncates the inline summary", () => {
    const long = "x".repeat(200);
    const out = describeToolResult("Read", true, long);
    expect(out.length).toBeLessThan(80);
    expect(out).toContain("…");
  });

  it("describeToolResult omits the dash when no summary is provided", () => {
    expect(describeToolResult("Edit", true)).toBe("Edit ✓");
  });
});
