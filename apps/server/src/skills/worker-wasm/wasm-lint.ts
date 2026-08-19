import { err, ok, type Result } from "neverthrow";

/**
 * Pyodide-compatibility lint for `skill.py`. Tier-1 skills run inside the
 * WASM sandbox where `subprocess`, `os.fork`, raw sockets, and other
 * OS-affordance APIs are unavailable; importing them produces obscure
 * runtime errors instead of clear deploy-time rejection.
 *
 * The check is a deterministic text scan: cheap, deterministic, false-positive
 * tolerant. P3.3 will replace it with a real Python AST pass run inside the
 * same Pyodide instance used for execution. v1 catches the common cases.
 *
 * **Threat model:** this lint is UX, not security. A determined skill can
 * trivially bypass it via `__import__("subprocess")` or
 * `importlib.import_module("os").system(...)` — a regex-based scanner has no
 * chance against runtime indirection. The actual security boundary is the
 * Pyodide WASM sandbox, which doesn't ship those host APIs anyway. The lint
 * exists so a skill author writing `import subprocess` gets a clear "won't
 * work in tier-1" at deploy time instead of a Pyodide ImportError at
 * runtime.
 */

interface RulePattern {
  name: string;
  pattern: RegExp;
  reason: string;
}

const RULES: readonly RulePattern[] = [
  {
    name: "subprocess_import",
    pattern: /^[ \t]*(?:import[ \t]+subprocess|from[ \t]+subprocess[ \t]+import)\b/m,
    reason: "subprocess is not available in tier-1 (WASM); declare tier: container",
  },
  {
    name: "os_fork",
    // Suffixes per Python stdlib: execl/execle/execlp/execlpe/execv/execve/execvp/execvpe.
    pattern: /\bos\.(?:fork|exec[lepv]+|spawn[lvp]+|posix_spawn)\b/,
    reason: "process-spawning APIs are not available in tier-1 (WASM)",
  },
  {
    name: "os_system",
    pattern: /\bos\.system\b/,
    reason: "os.system is not available in tier-1 (WASM)",
  },
  {
    name: "raw_socket",
    pattern: /^[ \t]*(?:import[ \t]+socket|from[ \t]+socket[ \t]+import)\b/m,
    reason: "raw sockets are not available in tier-1 (WASM); use `await ctx.http.get(url)`",
  },
  {
    // The stdlib HTTP clients are the ones a dependency-free skill
    // actually reaches for, and they fail at first use rather than at
    // import: they load fine and then find no socket underneath. Without
    // a rule here the skill deploys clean and breaks on invocation, which
    // is the outcome this lint exists to prevent.
    name: "stdlib_network",
    // Only the modules that open a connection. `urllib.parse` is string
    // manipulation and `urllib.error` is exception classes — both are
    // fine here and common, so the rule names `urllib.request` rather
    // than the package. A bare `import urllib` cannot reach the network
    // either, since the submodule has to be imported to be used.
    // Three shapes: `import http.client`, `from http.client import X`,
    // and `from http import client` — the last is as idiomatic as the
    // others, and missing it would let a skill deploy clean and fail on
    // first invocation, which is what this rule exists to prevent.
    pattern:
      /^[ \t]*(?:import[ \t]+(?:urllib\.request|http\.client|ftplib|smtplib|telnetlib|poplib|imaplib)\b|from[ \t]+(?:urllib\.request|http\.client|ftplib|smtplib|telnetlib|poplib|imaplib)[ \t]+import|from[ \t]+(?:urllib|http)[ \t]+import[ \t]+[\w, \t]*\b(?:request|client)\b)/m,
    reason:
      "stdlib networking has no socket underneath it in tier-1 (WASM); use `await ctx.http.get(url)`, or declare tier: container to use httpx",
  },
  {
    name: "multiprocessing",
    pattern: /^[ \t]*(?:import[ \t]+multiprocessing|from[ \t]+multiprocessing[ \t]+import)\b/m,
    reason: "multiprocessing is not available in tier-1 (WASM)",
  },
  {
    name: "ctypes",
    pattern: /^[ \t]*(?:import[ \t]+ctypes|from[ \t]+ctypes[ \t]+import)\b/m,
    reason: "ctypes is not available in tier-1 (WASM)",
  },
];

export interface LintError {
  rule: string;
  reason: string;
  /** 1-indexed line number of the first match (best-effort). */
  line: number;
}

export type LintResult = Result<void, readonly LintError[]>;

/**
 * Scan the skill body for tier-1-incompatible patterns. Returns `ok` if the
 * code is plausibly Pyodide-safe; `err` lists every rule that fired.
 */
export function lintWasmCompat(body: string): LintResult {
  const errors: LintError[] = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(body);
    if (match) {
      errors.push({
        rule: rule.name,
        reason: rule.reason,
        line: lineNumberAt(body, match.index),
      });
    }
  }
  return errors.length === 0 ? ok(undefined) : err(errors);
}

function lineNumberAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 0x0a) n++;
  }
  return n;
}
