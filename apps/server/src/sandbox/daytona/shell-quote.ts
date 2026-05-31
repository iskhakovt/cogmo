/**
 * Single-quote-escape for safe bash interpolation. POSIX rule: `'foo'`
 * is literal; embedded `'` becomes `'"'"'`. Cheaper than reaching for
 * shellac for one helper, and shared between the session-command and
 * PTY exec paths so a future fix lands once.
 */
export function shellEscape(s: string): string {
  return `'${s.replaceAll("'", "'\"'\"'")}'`;
}

/** Convenience over `argv.map(shellEscape).join(" ")` — same escape rules. */
export function shellEscapeArgv(argv: readonly string[]): string {
  return argv.map(shellEscape).join(" ");
}
