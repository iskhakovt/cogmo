/**
 * Cap a string at `max` characters, replacing the last visible character with
 * an ellipsis when truncation occurs. Empty strings pass through verbatim
 * (rather than being rendered as `(empty)` — callers that want a placeholder
 * for empty input should handle that case themselves; this helper's contract
 * is "only modify the input when it exceeds `max`").
 *
 * Used by every operator-facing renderer (sessions list, profile rows,
 * `/mcp list`, error-message previews) so all surfaces ellipsize consistently.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Backslash-escapes every closing tag of the named elements that a lenient
 * reader would honor (any case, whitespace at the slash), so text placed
 * inside one of them can't end it. `names` are plain element names (letters,
 * digits, underscores), used in the pattern as they are.
 */
export function escapeClosingTags(text: string, names: ReadonlyArray<string>): string {
  const closing = new RegExp(`<(\\s*)\\/(\\s*(?:${names.join("|")}))`, "gi");
  return text.replace(closing, "<$1\\/$2");
}
