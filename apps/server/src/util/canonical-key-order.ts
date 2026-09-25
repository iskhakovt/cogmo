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
 *
 * Never throws on JSON data, at any depth. The input is model output parsed
 * by `JSON.parse`, which has no nesting limit, and it runs on every read of
 * `messages.content` — so the walk is iterative, bounded by the heap rather
 * than the call stack. A shared or cyclic reference, which JSON cannot
 * produce, is copied once and stays shared in the result.
 */
export function canonicalKeyOrder<T>(value: T): T {
  // Reordering keys keeps every value and its type; TypeScript cannot
  // follow a rebuilt object back to `T`.
  return sortKeys(value) as T;
}

type Container = unknown[] | Record<PropertyKey, unknown>;

function isContainer(value: unknown): value is Container {
  return Array.isArray(value) || R.isPlainObject(value);
}

function sortKeys(value: unknown): unknown {
  if (!isContainer(value)) return value;

  // Pass 1: a shallow copy of every container reachable from `value`, object
  // keys inserted in sorted order, members still the originals.
  const copies = new Map<Container, Container>();
  const pending: Container[] = [value];
  for (let source = pending.pop(); source !== undefined; source = pending.pop()) {
    if (copies.has(source)) continue;
    copies.set(
      source,
      Array.isArray(source)
        ? source.slice()
        : Object.fromEntries(R.sortBy(Object.entries(source), ([key]) => key)),
    );
    // One push per member: spreading a wide array into `push` would hit the
    // engine's argument limit.
    for (const member of Object.values(source)) {
      if (isContainer(member)) pending.push(member);
    }
  }

  // Pass 2: point each copy's container members at their copies. Setting an
  // existing key keeps its position, and for an own `__proto__` key writes
  // the property rather than the prototype.
  for (const copy of copies.values()) {
    for (const [key, member] of Object.entries(copy)) {
      const sorted = isContainer(member) ? copies.get(member) : undefined;
      if (sorted !== undefined) Reflect.set(copy, key, sorted);
    }
  }
  return copies.get(value);
}
