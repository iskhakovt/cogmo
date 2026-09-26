import * as R from "remeda";

/**
 * A copy of a JSON value with object keys sorted at every depth (by UTF-16 code
 * unit, as RFC 8785 does) and arrays kept in order, so the same data serializes
 * to the same bytes whatever key order it arrived in. Tool-call inputs go
 * through this because the model's emission order and `jsonb`'s reload order
 * differ, and prompt caches key on bytes.
 *
 * - Integer-like keys are the one departure from RFC 8785: JavaScript lists
 *   them first, in numeric order. The result still depends only on the key set.
 * - Only arrays and plain objects are walked; anything else is returned as is.
 *   A parsed `__proto__` key stays an own key.
 * - Never throws on JSON at any depth: the walk is iterative, since model
 *   output has no nesting limit and this runs on every `messages.content` read.
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
