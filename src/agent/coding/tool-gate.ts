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

import * as policy from "./policy.js";
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
 * - `Bash` calls: extract the **prompt-worthy** sub-command (the one that
 *   would have triggered the prompt under the static policy — `git push`,
 *   `gh pr create`, `npm publish`, etc.). Compound commands like
 *   `pnpm test && git push` get matched to `Bash(git push *)` so the
 *   user's "Allow for task" tap applies to the dangerous part, not to
 *   the test runner that happened to come first. If no sub-command is
 *   prompt-worthy, fall back to the head of the first sub-command.
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
  const subs = command
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (subs.length === 0) return "Bash()";

  // Pick the canonical pattern for the first sub-command whose policy
  // decision is `prompt`. Driving the choice through `policy.evaluate`
  // (rather than a parallel match table) ensures we never canonicalise
  // a sub that the policy would have auto-allowed — e.g. `curl GET
  // localhost && git push` canonicalises to the push, not the curl,
  // because `curl GET localhost` evaluates to `allow` and skips.
  for (const sub of subs) {
    const evald = policy.evaluate({ tool: "Bash", input: { command: sub } });
    if (evald.decision !== "prompt") continue;
    const matched = subPattern(sub);
    if (matched) return matched;
  }

  // No sub prompts — fall back to the head of the first sub. Coarse but
  // consistent with how unmatched commands canonicalise.
  const tokens = (subs[0] ?? "").split(/\s+/).filter((t) => t.length > 0);
  const head = tokens[0] ?? "";
  return `Bash(${head} *)`;
}

/**
 * Canonical glob form for a sub-command that the policy already
 * confirmed is prompt-worthy. Mirrors the verb set in `policy.ts`; only
 * called on subs that `policy.evaluate` returned `prompt` for, so the
 * `curl`/`wget` arms are reached only for actual writes to non-localhost.
 */
function subPattern(sub: string): string | null {
  const tokens = sub.split(/\s+/).filter((t) => t.length > 0);
  const head = tokens[0] ?? "";

  if (head === "git" && tokens.includes("push")) return "Bash(git push *)";
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
    // The URL is variable per request, so we don't encode it. Only
    // reachable for subs the policy confirmed are external writes.
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
