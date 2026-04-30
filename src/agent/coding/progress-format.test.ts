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

  it("goal of exactly 80 chars is rendered verbatim (no ellipsis)", () => {
    const goal = "x".repeat(80);
    const out = formatProgressMessage({ goal, phase: "planning", body: "" });
    expect(out).toBe(`🧠 Planning — ${goal}`);
    expect(out).not.toContain("…");
  });

  it("goal of 81 chars triggers truncation (off-by-one canary)", () => {
    const goal = "x".repeat(81);
    const out = formatProgressMessage({ goal, phase: "planning", body: "" });
    // 79 retained chars + single ellipsis char.
    expect(out).toBe(`🧠 Planning — ${"x".repeat(79)}…`);
  });

  it("very long goal (5000 chars) does not blow up the header", () => {
    const out = formatProgressMessage({
      goal: "x".repeat(5000),
      phase: "planning",
      body: "",
    });
    const headerLine = out.split("\n")[0];
    expect(headerLine.length).toBeLessThanOrEqual("🧠 Planning — ".length + 80);
    expect(headerLine).toMatch(/…$/);
    // Whole message stays well under Telegram's 4096 cap.
    expect(out.length).toBeLessThan(4096);
  });

  it("goal containing newlines is passed through verbatim into the header", () => {
    // Pin observable behavior: the formatter does not strip or collapse
    // newlines in the goal preview. The goal is short enough to skip
    // truncation, so the embedded newline lands as-is and the rendered
    // output spans extra lines. Subscribers that need single-line headers
    // must sanitise upstream.
    const out = formatProgressMessage({
      goal: "line one\nline two",
      phase: "planning",
      body: "",
    });
    expect(out).toBe("🧠 Planning — line one\nline two");
  });

  it("goal with HTML special chars and emoji is not escaped (plain-text contract)", () => {
    // Per the module header, the formatter emits Telegram-safe plain text
    // and relies on the adapter to escape if it sets parse_mode. The
    // current progress subscriber sends without parse_mode, so raw
    // `<`/`>`/`&`/emoji round-trip through Telegram unparsed.
    const goal = '<script>alert(&"x")</script> 🎉';
    const out = formatProgressMessage({ goal, phase: "planning", body: "" });
    expect(out).toBe(`🧠 Planning — ${goal}`);
  });

  it("missing tokens field omits the status line entirely (no 'null tokens' literal)", () => {
    const out = formatProgressMessage({
      goal: "g",
      phase: "planning",
      body: "",
      tokens: undefined,
    });
    expect(out).toBe("🧠 Planning — g");
    expect(out).not.toMatch(/null|undefined|NaN/i);
    expect(out).not.toContain("tokens");
  });

  it("zero token counts render the status line and are distinct from missing", () => {
    const out = formatProgressMessage({
      goal: "g",
      phase: "executing",
      body: "",
      tokens: { input: 0, output: 0 },
    });
    expect(out).toContain("0 tokens (in 0 / out 0)");
  });

  it("failure reason containing newlines is rendered verbatim in the status line", () => {
    // Pin observable behavior: the formatter does not collapse or
    // pre-format multi-line failure reasons. Callers passing structured
    // errors get a multi-line status section.
    const out = formatProgressMessage({
      goal: "g",
      phase: "failed",
      body: "",
      failureReason: "exit 2\nstderr: boom",
    });
    expect(out).toContain("❌ Failed — g");
    expect(out).toContain("exit 2\nstderr: boom");
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
