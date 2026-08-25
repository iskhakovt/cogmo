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
    // Three shapes, each matching only at a name position so a longer
    // name that merely ends in one of these (`mypkg.smtplib`, an alias
    // `parse as request`) is left alone: `import a, http.client`, `from
    // http.client import X`, and `from http import client`.
    //
    // The pre-name group spells the alias form out rather than folding
    // spaces into the name class. A class matching whitespace next to a
    // trailing `[ \t]*` lets the engine split one run of tabs between the
    // two in exponentially many ways, and a body of `\t\t,` repeats then
    // stalls the register call it is supposed to guard.
    pattern:
      /^[ \t]*(?:import[ \t]+(?:[\w.]+(?:[ \t]+as[ \t]+[\w.]+)?[ \t]*,[ \t]*)*(?:urllib\.request|http\.client|ftplib|smtplib|telnetlib|poplib|imaplib)\b|from[ \t]+(?:urllib\.request|http\.client|ftplib|smtplib|telnetlib|poplib|imaplib)[ \t]+import\b|from[ \t]+(?:urllib|http)[ \t]+import[ \t]+(?:[\w.]+(?:[ \t]+as[ \t]+[\w.]+)?[ \t]*,[ \t]*)*(?:request|client)\b)/m,
    reason:
      "stdlib networking has no socket underneath it in tier-1 (WASM); use `await ctx.http.get(url)`, or declare tier: container to use httpx",
  },
  {
    // The third-party HTTP clients sit on sockets exactly as the stdlib
    // ones do, and they are what an author reaches for first. Both
    // authoring prompts tell the model these are rejected at register
    // time; this rule is what makes that true. Tier 2 declares them as
    // dependencies and runs them for real — the lint only sees wasm.
    name: "third_party_http",
    pattern:
      /^[ \t]*(?:import[ \t]+(?:[\w.]+(?:[ \t]+as[ \t]+[\w.]+)?[ \t]*,[ \t]*)*(?:httpx|requests|urllib3|aiohttp|websockets)\b|from[ \t]+(?:httpx|requests|urllib3|aiohttp|websockets)(?:\.[\w.]+)?[ \t]+import\b)/m,
    reason:
      "httpx / requests need sockets, which tier-1 (WASM) does not have; use `await ctx.http.get(url)`, or declare tier: container",
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
  const source = collapseParenthesisedImports(body);
  for (const rule of RULES) {
    const match = rule.pattern.exec(source);
    if (match) {
      errors.push({
        rule: rule.name,
        reason: rule.reason,
        line: lineNumberAt(source, match.index),
      });
    }
  }
  return errors.length === 0 ? ok(undefined) : err(errors);
}

/**
 * Collapse a parenthesised `from X import (...)` onto its opening line.
 * Python lets the name list span lines, and a formatter produces exactly
 * that once the list grows, so a line-oriented rule would otherwise see
 * `from urllib import (` and none of the names under it. The newlines the
 * statement occupied are re-emitted after it, so every later line keeps
 * the number `lineNumberAt` would have given it.
 */
function collapseParenthesisedImports(source: string): string {
  return source.replace(
    /^([ \t]*from[ \t]+[\w.]+[ \t]+import[ \t]*)\(([^)]*)\)/gm,
    (whole: string, head: string, names: string) => {
      // Comments go first. Flattening a list that carries one would leave
      // `# note` sitting between `import` and the name it annotates, and the
      // rules match names at a position — so the name would read as
      // commented-out and the import would pass.
      const flattened = names
        .replace(/#[^\n]*/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return `${head}${flattened}${"\n".repeat((whole.match(/\n/g) ?? []).length)}`;
    },
  );
}

function lineNumberAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 0x0a) n++;
  }
  return n;
}
