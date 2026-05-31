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
