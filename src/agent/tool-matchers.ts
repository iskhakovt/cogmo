import picomatch from "picomatch";

/**
 * Compile a list of tool-name patterns (exact names or picomatch globs) into a
 * single matcher predicate. Used by the per-turn tool composer in
 * `composeTurnTools` to gate every tool source — built-ins, skills, MCP —
 * against the active profile's `toolSet`.
 *
 * Each entry can be an exact tool name (`"memory_recall"`) or a
 * picomatch-compatible glob (`"mcp__github__*"`, `"memory_*"`,
 * `"mcp__{github,linear}__*"`). picomatch is invoked with `dot: false` and
 * `nocase: false`; the matcher is case-sensitive. Empty patterns array
 * returns a matcher that rejects everything (chat-only profile).
 *
 * Compiles each pattern once per call — safe to invoke once per resolveTools.
 */
export function compileToolMatchers(patterns: readonly string[]): (name: string) => boolean {
  if (patterns.length === 0) return () => false;
  const matchers = patterns.map((p) => picomatch(p, { dot: false, nocase: false }));
  return (name) => matchers.some((m) => m(name));
}
