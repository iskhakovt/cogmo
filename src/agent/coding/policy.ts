/**
 * Pure in-process policy table for the tool gate.
 *
 * Evaluates `permission_request` events from Claude Code's stream-json
 * protocol against a fixed rule set. The container + Docker proxy + sysbox
 * runtime are the security boundary; this layer is purely about
 * **visibility into externally-visible side effects**. So the defaults are
 * loose — most things allow without prompting.
 *
 * - **allow** — fire on the CLI's stdin immediately, no Telegram round trip.
 * - **prompt** — orchestrator posts an inline keyboard, waits for the user.
 * - **deny** — never returned by the static policy (the proxy + sysbox
 *   handle the genuinely-dangerous cases at the right layer). The type
 *   keeps `deny` in the union so the decision log can still record an
 *   explicit user-denied response.
 *
 * Pure function — no I/O, no DB. The orchestrator wraps it with the
 * decision-log lookup (`coding_tool_decisions`) before consulting it.
 */

export type PolicyDecision = "allow" | "deny" | "prompt";

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
}

export interface ToolCall {
  /** Top-level tool name from Claude Code's permission_request event. */
  tool: string;
  /** Tool-specific input. For `Bash`, includes a `command` string. */
  input: Record<string, unknown>;
}

/**
 * Verbs under `gh pr` / `gh issue` that mutate GitHub state. `view`, `list`,
 * `status`, `diff`, `checks` are read-only and stay in default-allow.
 */
const GH_PR_WRITE_VERBS = new Set([
  "create",
  "merge",
  "review",
  "close",
  "edit",
  "comment",
  "ready",
  "reopen",
]);

const GH_ISSUE_WRITE_VERBS = new Set(["create", "close", "edit", "comment", "reopen", "delete"]);

/** HTTP verbs that change server-side state. GET / HEAD / OPTIONS stay in default-allow. */
const WRITE_HTTP_VERBS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

/**
 * Evaluate a single permission request against the policy.
 *
 * Default-broad allow: anything not explicitly named here returns `allow`.
 * The narrow prompt set covers external state changes (git push, gh
 * mutations, package publishes, HTTP writes to non-localhost).
 */
export function evaluate(call: ToolCall): PolicyResult {
  if (call.tool === "Bash") {
    return evaluateBash(call.input);
  }
  return {
    decision: "allow",
    reason: `${call.tool} is non-Bash — file/read/write ops within the container are default-allowed`,
  };
}

function evaluateBash(input: Record<string, unknown>): PolicyResult {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (command.length === 0) {
    return { decision: "allow", reason: "empty Bash command" };
  }

  // Compound commands prompt if any sub-command would prompt — worst-case
  // wins so a user who allows `pnpm test && git push` is shown the push
  // explicitly rather than having it ride in on a blanket allow.
  let worst: PolicyResult = {
    decision: "allow",
    reason: "all sub-commands in default-allow set",
  };
  for (const sub of splitShellCommand(command)) {
    const r = evaluateBashSubcommand(sub);
    if (r.decision === "deny") return r;
    if (r.decision === "prompt" && worst.decision === "allow") {
      worst = r;
    }
  }
  return worst;
}

/**
 * Best-effort shell splitter on `&&`, `||`, `;`, `|`. Doesn't respect
 * quoted-and-escaped versions of those operators — a determined user can
 * smuggle a `git push` past us with `bash -c "git\x20push"` or similar,
 * which is acceptable: the gate is for visibility, not security. The
 * container + proxy + sysbox enforce the actual boundary.
 */
function splitShellCommand(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function evaluateBashSubcommand(sub: string): PolicyResult {
  const tokens = tokenize(sub);
  const head = tokens[0] ?? "";

  // git supports global options before the subcommand: `git -C <path> push`,
  // `git --git-dir=<path> push`, `git -c <key>=<val> push`, etc. Walk
  // past them via `gitSubcommand` so a positional `tokens[1]` check
  // doesn't get fooled by `git -C /repo push`.
  if (head === "git") {
    const subcommand = gitSubcommand(tokens);
    if (subcommand === "push") {
      return { decision: "prompt", reason: "git push modifies remote state" };
    }
  }

  if (head === "gh") {
    const subject = tokens[1] ?? "";
    const verb = tokens[2] ?? "";
    if (subject === "pr" && GH_PR_WRITE_VERBS.has(verb)) {
      return { decision: "prompt", reason: `gh pr ${verb} mutates GitHub state` };
    }
    if (subject === "issue" && GH_ISSUE_WRITE_VERBS.has(verb)) {
      return { decision: "prompt", reason: `gh issue ${verb} mutates GitHub state` };
    }
    if (subject === "release" || subject === "repo") {
      // gh release create / gh repo create / gh repo delete — all mutate.
      // gh release view / gh repo view fall through to default-allow.
      if (verb === "create" || verb === "delete" || verb === "edit") {
        return { decision: "prompt", reason: `gh ${subject} ${verb} mutates GitHub state` };
      }
    }
  }

  if (
    (head === "npm" || head === "pnpm" || head === "yarn") &&
    (tokens[1] === "publish" || tokens[1] === "unpublish")
  ) {
    return { decision: "prompt", reason: `${head} ${tokens[1]} releases to a public registry` };
  }

  if (head === "cargo" && (tokens[1] === "publish" || tokens[1] === "yank")) {
    return { decision: "prompt", reason: `cargo ${tokens[1]} releases to crates.io` };
  }

  if ((head === "twine" || head === "uv") && tokens[1] === "publish") {
    return { decision: "prompt", reason: `${head} publish releases to PyPI` };
  }
  if (head === "twine" && tokens[1] === "upload") {
    return { decision: "prompt", reason: "twine upload releases to PyPI" };
  }

  if (head === "curl") {
    const verb = effectiveCurlVerb(tokens);
    if (verb && WRITE_HTTP_VERBS.has(verb)) {
      const url = extractFirstHttpUrl(tokens);
      if (url && !isLocalhostUrl(url)) {
        return {
          decision: "prompt",
          reason: `curl ${verb} to ${url} is an external write`,
        };
      }
    }
  }

  if (head === "wget") {
    const isWrite = tokens.some(
      (t) =>
        t === "--post-data" ||
        t === "--post-file" ||
        t.startsWith("--post-data=") ||
        t.startsWith("--post-file=") ||
        t === "--method=POST" ||
        t === "--method=PUT" ||
        t === "--method=DELETE",
    );
    if (isWrite) {
      const url = extractFirstHttpUrl(tokens);
      if (url && !isLocalhostUrl(url)) {
        return { decision: "prompt", reason: `wget write request to ${url}` };
      }
    }
  }

  return { decision: "allow", reason: "default-allow under container boundary policy" };
}

/**
 * Token split that drops the matched separator. Doesn't deal with quotes —
 * `curl -X "POST"` becomes `[curl, -X, "POST"]` and the comparison against
 * `"POST"` will fail. Live with it: the gate is visibility, not security,
 * and the proxy is the real enforcement surface.
 */
function tokenize(cmd: string): string[] {
  return cmd.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Walk past git's global-options layer to find the subcommand. Handles:
 *   git push                                  → push
 *   git -C /path push                         → push
 *   git --git-dir=/path push                  → push
 *   git -c user.email=x@y push                → push
 *   git -c user.email=x@y -C /repo push       → push
 *
 * Tokens whose value lives in the next position (`-C`, `--git-dir`, `-c`,
 * `--namespace`, `--exec-path`, `--work-tree`) consume two slots; their
 * `--key=value` forms consume one. Anything else that starts with `-` is
 * a flag we don't recognise — skip one slot and keep looking. The first
 * non-`-` token after the global layer is the subcommand.
 */
const GIT_GLOBAL_TWO_SLOT = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
]);

function gitSubcommand(tokens: string[]): string | null {
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i] as string;
    if (!t.startsWith("-")) return t;
    if (GIT_GLOBAL_TWO_SLOT.has(t)) {
      i += 2;
      continue;
    }
    // `--key=value` form, or unknown short flag — consume one slot.
    i += 1;
  }
  return null;
}

/**
 * Pull the explicit verb out of `curl -X <verb>` / `curl -X<verb>` /
 * `curl --request <verb>` / `curl --request=<verb>`. Returns the
 * upper-cased verb if found.
 */
function extractExplicitCurlVerb(tokens: string[]): string | null {
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] ?? "";
    if ((t === "-X" || t === "--request") && i + 1 < tokens.length) {
      const next = tokens[i + 1];
      if (next) return stripQuotes(next).toUpperCase();
    }
    if (t.startsWith("--request=")) {
      return stripQuotes(t.slice("--request=".length)).toUpperCase();
    }
    // -XPOST short-attached form.
    if (t.startsWith("-X") && t.length > 2) {
      return stripQuotes(t.slice(2)).toUpperCase();
    }
  }
  return null;
}

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, "");
}

/**
 * Long-flag exact matches that imply POST when no explicit `-X` is set.
 * Short flags are handled separately because curl accepts them with the
 * value attached (`-dfoo`, `-F@file`, `-Tfile.tar.gz`).
 */
const CURL_LONG_IMPLIES_POST = new Set([
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-urlencode",
  "--data-ascii",
  "--form",
  "--form-string",
  "--upload-file",
]);

const CURL_SHORT_IMPLIES_POST = ["-d", "-F", "-T"] as const;

/**
 * Effective verb a curl invocation will issue. Honours an explicit
 * `-X / --request <verb>` if present; otherwise falls back to curl's
 * default — POST when any of `-d`, `--data*`, `-F`, `--form*`, or upload
 * flags are set (in attached or separate form); HEAD on `-I / --head`;
 * otherwise GET.
 */
function effectiveCurlVerb(tokens: string[]): string | null {
  const explicit = extractExplicitCurlVerb(tokens);
  if (explicit) return explicit;
  for (const t of tokens) {
    if (!t) continue;
    if (curlTokenImpliesPost(t)) return "POST";
    if (t === "-I" || t === "--head") return "HEAD";
  }
  return "GET";
}

/**
 * Curl-flag-implies-POST matcher that handles all four invocation
 * styles: bare flag (`-d`, `--data`), long with `=value`
 * (`--data=foo`), short with attached value (`-dfoo`, `-Tfile`), and
 * the equivalent for `-F`. Without short-attached handling, `curl
 * -dfoo https://x.com/r` slips past as a GET because the dispatcher
 * only sees a single token `-dfoo` that doesn't match `"-d"` exactly.
 */
function curlTokenImpliesPost(token: string): boolean {
  // Long form: `--data` or `--data=value`.
  if (CURL_LONG_IMPLIES_POST.has(token)) return true;
  if (token.includes("=")) {
    const flag = token.slice(0, token.indexOf("="));
    if (CURL_LONG_IMPLIES_POST.has(flag)) return true;
  }
  // Short form: `-d`, `-F`, `-T` (bare or with value attached).
  for (const short of CURL_SHORT_IMPLIES_POST) {
    if (token === short) return true;
    if (token.startsWith(short) && token.length > short.length) return true;
  }
  return false;
}

/** First token that looks like an http(s) URL. */
function extractFirstHttpUrl(tokens: string[]): string | null {
  for (const t of tokens) {
    const stripped = t.replace(/^['"]|['"]$/g, "");
    if (stripped.startsWith("http://") || stripped.startsWith("https://")) {
      return stripped;
    }
  }
  return null;
}

function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Node's URL leaves IPv6 hostnames in `[::1]` bracketed form. Strip
    // brackets so the comparison against `"::1"` works.
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
}
