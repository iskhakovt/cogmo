import { describe, expect, it } from "vitest";
import type { CodingToolDecisionRow } from "./store/index.js";
import { canonicalPattern, patternMatches, replayDecisionLog } from "./tool-gate.js";

function row(
  pattern: string,
  decision: "allow" | "deny",
  scope: "once" | "task",
  createdAt: Date = new Date("2026-04-27T00:00:00Z"),
): CodingToolDecisionRow {
  return {
    id: `id-${Math.random()}`,
    taskId: "task-1",
    tool: "Bash",
    pattern,
    decision,
    scope,
    createdAt,
  };
}

describe("canonicalPattern", () => {
  it.each([
    [{ tool: "Read", input: { path: "/etc/passwd" } }, "Read"],
    [{ tool: "Edit", input: {} }, "Edit"],
    [{ tool: "mcp__github__create_pr", input: {} }, "mcp__github__create_pr"],
  ])("non-Bash tool returns the tool name", (call, expected) => {
    expect(canonicalPattern(call)).toBe(expected);
  });

  it.each([
    ["git push", "Bash(git push *)"],
    ["git push origin main", "Bash(git push *)"],
    ["git push --force-with-lease origin cogmo/abc", "Bash(git push *)"],
  ])("git push variants → %s", (cmd, expected) => {
    expect(canonicalPattern({ tool: "Bash", input: { command: cmd } })).toBe(expected);
  });

  it.each([
    ["gh pr create --draft", "Bash(gh pr create *)"],
    ["gh pr merge 123", "Bash(gh pr merge *)"],
    ["gh issue close 42", "Bash(gh issue close *)"],
    ["gh release create v1.0", "Bash(gh release create *)"],
    ["gh repo delete foo/bar", "Bash(gh repo delete *)"],
  ])("gh subcommand → %s", (cmd, expected) => {
    expect(canonicalPattern({ tool: "Bash", input: { command: cmd } })).toBe(expected);
  });

  it.each([
    ["npm publish", "Bash(npm publish *)"],
    ["pnpm publish --dry-run", "Bash(pnpm publish *)"],
    ["yarn unpublish foo", "Bash(yarn unpublish *)"],
    ["cargo publish --token x", "Bash(cargo publish *)"],
    ["cargo yank --version 1.0 foo", "Bash(cargo yank *)"],
    ["uv publish --token x", "Bash(uv publish *)"],
    ["twine upload dist/*", "Bash(twine upload *)"],
  ])("package publish %s", (cmd, expected) => {
    expect(canonicalPattern({ tool: "Bash", input: { command: cmd } })).toBe(expected);
  });

  it.each([
    ["curl -X POST https://example.com/api -d a=b", "Bash(curl *)"],
    ["wget --post-data=foo https://example.com/r", "Bash(wget *)"],
  ])("HTTP write %s", (cmd, expected) => {
    expect(canonicalPattern({ tool: "Bash", input: { command: cmd } })).toBe(expected);
  });

  it("compound commands canonicalise to the prompt-worthy sub-command (worst-case wins)", () => {
    // `pnpm test` alone would auto-allow; `git push` is prompt-worthy,
    // so the user's "Allow for task" tap must record the push pattern.
    expect(
      canonicalPattern({ tool: "Bash", input: { command: "pnpm test && git push origin main" } }),
    ).toBe("Bash(git push *)");
    // Same with `||` and `;` separators.
    expect(canonicalPattern({ tool: "Bash", input: { command: "pnpm test; npm publish" } })).toBe(
      "Bash(npm publish *)",
    );
  });

  it("skips auto-allowed sub-commands when picking the canonical pattern", () => {
    // `curl GET localhost` evaluates to allow, NOT prompt — so the
    // canonical pattern for `curl GET localhost && git push` must be
    // the push, not `Bash(curl *)`. Otherwise a user's "Allow for task"
    // on a localhost curl would silently auto-approve a future
    // unrelated `git push` via decision-log replay.
    expect(
      canonicalPattern({
        tool: "Bash",
        input: { command: "curl http://localhost:8080/x && git push" },
      }),
    ).toBe("Bash(git push *)");
    // Read-only git ops auto-allow → don't anchor the canonical here.
    expect(
      canonicalPattern({
        tool: "Bash",
        input: { command: "git status && git push origin main" },
      }),
    ).toBe("Bash(git push *)");
  });

  it("compound commands fall back to the first sub-head when no sub is prompt-worthy", () => {
    expect(canonicalPattern({ tool: "Bash", input: { command: "pnpm test && pnpm lint" } })).toBe(
      "Bash(pnpm *)",
    );
  });

  it("empty / missing command falls back to a stable string", () => {
    expect(canonicalPattern({ tool: "Bash", input: {} })).toBe("Bash()");
    expect(canonicalPattern({ tool: "Bash", input: { command: "" } })).toBe("Bash()");
  });

  it("unknown command keeps the head", () => {
    expect(canonicalPattern({ tool: "Bash", input: { command: "weird-tool --flag arg" } })).toBe(
      "Bash(weird-tool *)",
    );
  });
});

describe("replayDecisionLog", () => {
  it("returns null when log is empty", () => {
    expect(replayDecisionLog({ tool: "Bash", input: { command: "git push" } }, [])).toBeNull();
  });

  it("returns the matching task-scoped decision", () => {
    const log = [row("Bash(git push *)", "allow", "task")];
    const r = replayDecisionLog({ tool: "Bash", input: { command: "git push origin x" } }, log);
    expect(r?.decision).toBe("allow");
    expect(r?.pattern).toBe("Bash(git push *)");
  });

  it("ignores once-scoped rows", () => {
    const log = [row("Bash(git push *)", "allow", "once")];
    expect(replayDecisionLog({ tool: "Bash", input: { command: "git push" } }, log)).toBeNull();
  });

  it("walks newest-first so a later decision overrides an earlier one", () => {
    const log = [
      row("Bash(git push *)", "allow", "task", new Date("2026-04-26T00:00:00Z")),
      row("Bash(git push *)", "deny", "task", new Date("2026-04-27T00:00:00Z")),
    ];
    const r = replayDecisionLog({ tool: "Bash", input: { command: "git push" } }, log);
    expect(r?.decision).toBe("deny");
  });

  it("returns null when no pattern matches", () => {
    const log = [row("Bash(git push *)", "allow", "task")];
    expect(replayDecisionLog({ tool: "Bash", input: { command: "npm publish" } }, log)).toBeNull();
  });

  it("matches across compatible patterns (different curl URLs)", () => {
    const log = [row("Bash(curl *)", "allow", "task")];
    const a = replayDecisionLog(
      { tool: "Bash", input: { command: "curl -X POST https://a.com/x -d 1" } },
      log,
    );
    const b = replayDecisionLog(
      { tool: "Bash", input: { command: "curl -X DELETE https://b.com/y" } },
      log,
    );
    expect(a?.decision).toBe("allow");
    expect(b?.decision).toBe("allow");
  });
});

describe("patternMatches", () => {
  it("exact match", () => {
    expect(patternMatches("Bash(git push *)", "Bash(git push *)")).toBe(true);
  });

  it("escapes regex metacharacters in literals (parentheses)", () => {
    expect(patternMatches("Bash(git push *)", "Bash git push *")).toBe(false);
  });

  it("anchors both ends", () => {
    expect(patternMatches("Bash(git push *)", "Bash(git push *) extra")).toBe(false);
  });

  it("* matches multiple chars", () => {
    expect(patternMatches("Bash(*)", "Bash(anything in here)")).toBe(true);
  });
});
