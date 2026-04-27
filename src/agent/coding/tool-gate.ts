/**
 * Tool-gate orchestration helpers — pure functions that turn a Claude Code
 * `permission_request` into a canonical pattern (used as the matcher in
 * `coding_tool_decisions`) and replay the decision log against the
 * incoming request.
 *
 * The orchestrator wires them up:
 *   request → canonicalPattern → decision-log replay → policy → user prompt
 *
 * Pure on purpose so the test surface is just input → output. The store
 * read + Telegram round trip live in the orchestrator.
 */

import type { CodingToolDecisionRow } from "./store/index.js";

export interface ToolCallInput {
  tool: string;
  input: Record<string, unknown>;
}

/**
 * Build the canonical matcher form for a tool call. Used both as the
 * pattern stored against an `Allow for task` decision and as the lookup
 * key when replaying the log.
 *
 * - `Bash` calls: extract the first sub-command head (`git push`, `gh pr
 *   create`, `npm publish`, `curl`) and produce a glob form. Trailing
 *   arguments are wildcarded so a future `git push origin foo` matches
 *   the user's prior tap on `git push origin bar`.
 * - Non-Bash tools: just the tool name. File ops are default-allowed at
 *   the policy layer so they rarely show up in the log; if a custom
 *   policy ever wants per-tool task-scoped allow, this is the matcher.
 *
 * Mirrors the verb set in `policy.ts` so log replay and policy evaluation
 * agree on what "the same kind of action" means.
 */
export function canonicalPattern(call: ToolCallInput): string {
  if (call.tool !== "Bash") {
    return call.tool;
  }
  const command = typeof call.input.command === "string" ? call.input.command.trim() : "";
  if (command.length === 0) return "Bash()";
  // Take the first sub-command — compound chains have multiple, but the
  // policy already prompts on the worst-case sub, and the user's tap
  // applies to the whole compound. Storing the head sub-command keeps
  // the matcher simple.
  const firstSub = command.split(/&&|\|\||;|\|/)[0]?.trim() ?? command;
  const tokens = firstSub.split(/\s+/).filter((t) => t.length > 0);
  const head = tokens[0] ?? "";

  // Two-word verbs we recognise — keep the verb in the pattern.
  if (head === "git" && tokens[1] === "push") return "Bash(git push *)";
  if (head === "gh" && tokens[1] === "pr" && tokens[2]) return `Bash(gh pr ${tokens[2]} *)`;
  if (head === "gh" && tokens[1] === "issue" && tokens[2]) {
    return `Bash(gh issue ${tokens[2]} *)`;
  }
  if (head === "gh" && (tokens[1] === "release" || tokens[1] === "repo") && tokens[2]) {
    return `Bash(gh ${tokens[1]} ${tokens[2]} *)`;
  }
  if (
    (head === "npm" || head === "pnpm" || head === "yarn") &&
    (tokens[1] === "publish" || tokens[1] === "unpublish")
  ) {
    return `Bash(${head} ${tokens[1]} *)`;
  }
  if (head === "cargo" && (tokens[1] === "publish" || tokens[1] === "yank")) {
    return `Bash(cargo ${tokens[1]} *)`;
  }
  if ((head === "twine" || head === "uv") && tokens[1]) {
    return `Bash(${head} ${tokens[1]} *)`;
  }
  if (head === "curl" || head === "wget") {
    // Don't try to encode the URL — it's variable per request. The
    // user's tap on `curl POST https://api.foo.com/x` allows future
    // `curl` calls to non-localhost. Coarse, but matches the design
    // (single-user; user re-prompted is a feature not a bug).
    return `Bash(${head} *)`;
  }

  return `Bash(${head} *)`;
}

/**
 * Replay the decision log: find the most recent task-scoped decision whose
 * pattern matches the incoming request's canonical pattern. `once`-scoped
 * rows are ignored — they're audit-only.
 *
 * Returns the matching decision and its scope, or null if no match.
 */
export function replayDecisionLog(
  call: ToolCallInput,
  log: ReadonlyArray<CodingToolDecisionRow>,
): { decision: "allow" | "deny"; pattern: string; loggedAt: Date } | null {
  const pattern = canonicalPattern(call);
  // Walk newest first — an explicit later decision overrides an earlier
  // one (e.g. user toggled allow → deny on the same pattern).
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const row = log[i];
    if (!row) continue;
    if (row.scope !== "task") continue;
    if (patternMatches(row.pattern, pattern)) {
      return { decision: row.decision, pattern: row.pattern, loggedAt: row.createdAt };
    }
  }
  return null;
}

/**
 * Glob-style match for our canonical pattern alphabet. `*` matches any
 * sequence of characters; everything else is literal. The set of stored
 * patterns is small (exact or literal-with-trailing-*), so a regex
 * translation is sufficient. Anchored at both ends.
 */
export function patternMatches(stored: string, candidate: string): boolean {
  const escaped = escapeForRegex(stored).replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(candidate);
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/** Standard regex-escape: prefix any meta char with `\`. */
function escapeForRegex(s: string): string {
  return s.replace(REGEX_META, "\\$&");
}
