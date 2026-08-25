import { SKILLS_CODING_REPO_NAME } from "../../skills/repo.js";
import type { CodingRepoRow, CodingTaskRow } from "./store/index.js";

/**
 * Repo-specific guidance for the skills library. `register` reads
 * `SKILL.md` + `skill.py` from the repo root at the branch tip, so claude
 * must place both files at `/workspace` — not in a `skills/<name>/`
 * subdirectory. One feature branch = one skill.
 */
const SKILLS_REPO_CONVENTION = [
  "# Skills repo convention",
  "- This is the skills library. One feature branch = exactly one skill.",
  "- Place SKILL.md (the manifest), skill.py (the implementation), and (if",
  "  the skill imports any third-party package) requirements.lock at /workspace root.",
  "  Do NOT put them in a `skills/<name>/` subdirectory — registration reads them from the",
  "  repo root and rejects layouts that hide them inside subdirs.",
  "- skill.py must export `async def run(inputs, ctx) -> dict`.",
  "",
  "SKILL.md frontmatter contract — these are validated structurally, not free-form:",
  "  - The frontmatter is YAML. Any value containing `{`, `}`, `:`, `#`, `[`, or `]`",
  "    MUST be wrapped in double quotes — otherwise YAML parses the special char as",
  "    structure (e.g. unquoted `{ price: number }` becomes a nested flow mapping).",
  "  - name: lowercase, starts with letter, [a-z0-9_-] only",
  "  - description: 10-500 chars; quote it if it contains any YAML-special char above",
  '  - tier: one of "wasm" | "container" (NOT "notify"/"approve" — those are risk tiers',
  "    auto-derived from effects, not authored)",
  "  - inputs: a JSON Schema object — must include `type: object` and (usually)",
  "    `properties` + `required` arrays. Use `{type: object, properties: {}}` for",
  "    no-arg skills. Never `inputs: none` or `inputs: <string>`.",
  "  - effects: an array of strings, picked from this closed set: reads_memory,",
  "    writes_memory, reads_user_data, writes_user_data, sends_email, sends_message,",
  "    posts_public, deletes_external, financial, reads_filesystem, writes_filesystem,",
  "    spawns_subprocess. Use `[]` if none apply. Never a free-form string or a value",
  "    outside this set. A read-only HTTP call to a public API needs no effects.",
  "  - dependencies: an array of strict `name==version` strings. Required for any",
  "    third-party import in skill.py. Use `[]` (or omit) when skill.py is stdlib-only.",
  "",
  "Network access — tier 1 (`tier: wasm`) has no sockets, so `urllib`, `http.client`,",
  "`httpx` and `requests` cannot reach anything there and are rejected at register",
  "time. Make requests through the host instead:",
  '    `resp = await ctx.http.get(url)`  ->  {"status": int, "headers": dict, "body": str}',
  "  `ctx.http.post(url, body, headers=...)` and `ctx.http.request(method, url, ...)`",
  "  are also available. A 4xx/5xx comes back as a normal value carrying that",
  '  status — check `resp["status"]` rather than catching. Parse with',
  '  `json.loads(resp["body"])`. This needs no dependency and no lockfile.',
  "  Reach for `tier: container` + `httpx` only when a vendor SDK is genuinely",
  "  required; that tier has real sockets.",
  "  Every host reached through `ctx.http` must be listed in the manifest, or",
  "  the request is refused — with no `network:` block, `ctx.http` reaches",
  "  nothing. (A `tier: container` skill calling httpx directly has real",
  "  sockets and is not bound by this; prefer `ctx.http` there too.)",
  "    network:",
  "      allow:",
  "        - api.example.com",
  "        - '*.cdn.example.com'   # any depth under the zone; the apex needs its own entry",
  "  List only the hosts actually contacted. A skill that declares both a secret",
  "  and a network allowlist always needs human approval before it deploys, so",
  "  keep the allowlist to what the skill uses.",
  "",
  "",
  "Lockfile contract — if dependencies is non-empty:",
  "- Generate requirements.lock with `uv pip compile --no-header --generate-hashes",
  "  -o requirements.lock -` reading specs from stdin, e.g.:",
  "    `printf 'httpx==0.27.2\\n' | uv pip compile --no-header --generate-hashes",
  "    -o requirements.lock -`",
  "  uv is on PATH in the sandbox. The lockfile resolves transitive deps with",
  "  hashes — register byte-compares against a fresh re-resolve, so `--no-header`",
  "  is required (the header is non-deterministic).",
  "",
  "Minimal valid SKILL.md (no deps):",
  "```",
  "---",
  "name: example-skill",
  'description: "One-line summary of what the skill does (at least 10 chars)."',
  "tier: wasm",
  "inputs:",
  "  type: object",
  "  properties: {}",
  "effects: []",
  "---",
  "Free-form markdown body describing the skill in more detail.",
  "```",
  "",
  "Same shape with dependencies + a description that contains YAML-special chars:",
  "```",
  "---",
  "name: example-skill",
  'description: "Reads a row from the vendor API and returns { rows: number }."',
  "tier: container",
  "inputs:",
  "  type: object",
  "  properties: {}",
  "effects: []",
  "dependencies:",
  '  - "httpx==0.27.2"',
  "---",
  "```",
].join("\n");

function repoConvention(repo: CodingRepoRow): string {
  if (repo.name === SKILLS_CODING_REPO_NAME) return `\n${SKILLS_REPO_CONVENTION}\n`;
  return "";
}

/**
 * Slice-1 plan-phase prompt. Hardcoded template; slice 4+ wires this through
 * `DefaultPromptSource` so coding-scoped steering rules layer on top.
 *
 * Repo conventions are NOT inlined — Claude Code loads `/workspace/CLAUDE.md`,
 * `~/.claude/CLAUDE.md`, and `/etc/claude-code/CLAUDE.md` natively from its
 * memory tiers. See design/coding-delegation.md → "Injected context".
 * Exception: the skills library has a layout convention that's load-bearing
 * for register (root-only files), surfaced via {@link repoConvention} until
 * a CLAUDE.md ships in the bare repo.
 */
export function buildPlanPrompt(task: CodingTaskRow, repo: CodingRepoRow): string {
  if (!task.worktreeAssignment) {
    throw new Error(`buildPlanPrompt called for task ${task.id} before worktree was allocated`);
  }
  return [
    "# Task",
    task.goal,
    "",
    "# Environment",
    "- Repo root is /workspace. Stay inside it.",
    `- Current branch: ${task.worktreeAssignment.branch}. Already created and checked out.`,
    "- Git credentials are NOT available in plan mode — you cannot push or pull.",
    "- Do NOT make any edits. Plan only.",
    repoConvention(repo),
    "# Verify command (for context — runs after execution, not during plan)",
    repo.verifyCommand,
    "",
    "# Budget",
    `Aim to keep the task within ~${repo.taskTokenBudget} tokens of execution. ` +
      "If the task is too large, narrow scope rather than promise the moon.",
    "",
    "# When finished",
    'Produce a "## Plan" section describing the steps you would take, the files you would touch, ' +
      "and how you would verify. Cogmo posts this plan to the human for approval before any " +
      "execution. No edits, no commits, no pushes.",
  ].join("\n");
}

/**
 * Slice-2 execute-phase prompt. Sent on stdin after `claude --resume <sid>`
 * loads the prior plan-mode session — Claude already has the goal, repo
 * context, and its own plan in scrollback. This message just transitions it
 * from plan mode to execution and reaffirms the boundaries it must respect.
 */
export function buildExecutePrompt(repo: CodingRepoRow): string {
  return [
    "# Approved",
    "The plan you proposed has been approved. Proceed with the implementation.",
    "",
    "# Reminders",
    "- Stay on the current branch and inside /workspace.",
    "- Git credentials are NOT available — do not `git push` or `gh pr create`.",
    "  Cogmo handles push and PR opening after verifying your work.",
    "- When you believe the task is done, run the verify command and report",
    "  the result. If it fails, iterate.",
    repoConvention(repo),
    "# Verify command",
    repo.verifyCommand,
  ].join("\n");
}
