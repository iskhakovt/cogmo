/**
 * The byte-stability check over consecutive LLM requests
 * (design/prompt-caching.md → Test Plan → Harness): every request's prefix is
 * the previous request's, unchanged. Modelled on promptcachelint, which diffs
 * requests segment by segment with cache markers stripped.
 *
 * Works on request bodies as the wire recorder parses them, so key order is
 * the order sent: a reordered tool input is a divergence, as it is for the
 * provider's cache. Anthropic bodies carry `system` and `tools` at the top
 * level; OpenAI-compatible bodies carry the system prompt as their first
 * message, which the message prefix covers.
 */

type Json = unknown;

/** Anthropic's lookback: a breakpoint finds a prior write at most this many positions back. */
export const LOOKBACK_POSITIONS = 20;

export interface AppendOnlyReport {
  /** Path of the first difference (`system`, `tools[3]`, `messages[7].content[1].input`), or null. */
  divergence: string | null;
  /** Positions the later request appends — a run of `tool_use` or `tool_result` blocks counts once. */
  appended: number;
}

export function compareRequests(
  prev: Record<string, Json>,
  next: Record<string, Json>,
): AppendOnlyReport {
  const a = stripCacheControl(prev);
  const b = stripCacheControl(next);
  const prevMessages = asArray(a.messages);
  const nextMessages = asArray(b.messages);
  const divergence =
    firstDifference(a.tools, b.tools, "tools") ??
    firstDifference(a.system, b.system, "system") ??
    prefixDifference(prevMessages, nextMessages);
  return {
    divergence,
    appended: nextMessages.slice(prevMessages.length).reduce<number>((n, m) => n + positions(m), 0),
  };
}

/**
 * Throws unless `next` extends `prev`: the same `tools` and `system`, every
 * message of `prev` at the same position byte for byte, and no more than the
 * lookback window appended.
 */
export function assertAppendOnly(prev: Record<string, Json>, next: Record<string, Json>): void {
  const { divergence, appended } = compareRequests(prev, next);
  if (divergence !== null) {
    throw new Error(
      `request is not append-only: it diverges from the previous one at ${divergence}`,
    );
  }
  if (appended > LOOKBACK_POSITIONS) {
    throw new Error(
      `request appends ${appended} positions, past the ${LOOKBACK_POSITIONS}-position lookback`,
    );
  }
}

function prefixDifference(prev: ReadonlyArray<Json>, next: ReadonlyArray<Json>): string | null {
  for (const [i, message] of prev.entries()) {
    if (i >= next.length) return `messages[${i}]`;
    const diff = firstDifference(message, next[i], `messages[${i}]`);
    if (diff !== null) return diff;
  }
  return null;
}

/** The first path where `a` and `b` differ, key order included; null when identical. */
function firstDifference(a: Json, b: Json, path: string): string | null {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length || i >= b.length) return `${path}[${i}]`;
      const diff = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (diff !== null) return diff;
    }
    return null;
  }
  if (isObject(a) && isObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    for (let i = 0; i < Math.max(keysA.length, keysB.length); i++) {
      const key = keysA[i];
      if (key === undefined || key !== keysB[i]) return `${path}.${key ?? keysB[i]}`;
      const diff = firstDifference(a[key], b[key], `${path}.${key}`);
      if (diff !== null) return diff;
    }
    return null;
  }
  return Object.is(a, b) ? null : path;
}

function positions(message: Json): number {
  const content = isObject(message) ? message.content : undefined;
  if (!Array.isArray(content)) return 1;
  let count = 0;
  let previousType: unknown;
  for (const block of content) {
    const type = isObject(block) ? block.type : undefined;
    const run = type === "tool_use" || type === "tool_result";
    if (!(run && type === previousType)) count++;
    previousType = type;
  }
  return Math.max(count, 1);
}

function stripCacheControl(value: Json): Record<string, Json> {
  const strip = (v: Json): Json => {
    if (Array.isArray(v)) return v.map(strip);
    if (!isObject(v)) return v;
    return Object.fromEntries(
      Object.entries(v)
        .filter(([key]) => key !== "cache_control")
        .map(([key, inner]) => [key, strip(inner)]),
    );
  };
  const stripped = strip(value);
  return isObject(stripped) ? stripped : {};
}

function asArray(value: Json): ReadonlyArray<Json> {
  return Array.isArray(value) ? value : [];
}

function isObject(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
