import * as R from "remeda";

/**
 * Return a copy of a JSON value with object keys sorted at every depth and
 * arrays kept in order: the RFC 8785 key ordering, comparing keys by UTF-16
 * code unit.
 *
 * What callers rely on is that the result serializes to the same bytes for
 * every key order of the same data. A tool call's `input` goes through this
 * wherever it enters a transcript, because the model's emission order and the
 * order `jsonb` reloads it in (length first, then bytewise) differ, and a
 * provider's prompt cache keys on the bytes.
 *
 * Integer-like keys (`"0"`, `"10"`) are the one departure from RFC 8785:
 * JavaScript enumerates them first, in numeric order, however they were
 * inserted. The result is still a function of the key set alone.
 *
 * Meant for JSON data. Only arrays and plain objects are walked; anything
 * else, including a non-plain object, comes back as the same reference.
 * Entries are copied as own properties, so a parsed `__proto__` key stays a
 * key and never becomes a prototype.
 */
export function canonicalKeyOrder<T>(value: T): T {
  // Reordering keys keeps every value and its type; TypeScript cannot
  // follow a rebuilt object back to `T`.
  return sortKeys(value) as T;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!R.isPlainObject(value)) return value;
  return Object.fromEntries(
    R.sortBy(Object.entries(value), ([key]) => key).map(([key, member]) => [key, sortKeys(member)]),
  );
}
