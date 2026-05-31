import { z } from "zod";

/**
 * Shared UUID validation helpers. Cogmo uses lowercase UUIDv7 throughout
 * (DB-generated via `uuidv7()`); this module is the single source of truth
 * for pattern + checks.
 *
 * Three exports for the three call shapes:
 *   - `UUID_PATTERN` — raw regex source for embedding inside a larger
 *     regex (e.g. a Telegram `callback_data` parser). Anchorless.
 *   - `UUID_RE` — anchored compiled `RegExp` for a standalone match.
 *   - `UuidSchema` — Zod schema; use it at a typed boundary.
 *
 * Accepts any UUID version's shape (8-4-4-4-12 hex). Slice-2's
 * plan-keyboard already accepts non-v7 inputs; this preserves that
 * laxness so an upstream-driven change of the version nibble doesn't
 * silently break parsing. Telegram-callback parsers should NOT
 * accept upper-case (they're round-tripping our own emitted strings),
 * which is why `UUID_PATTERN` and `UUID_RE` are case-sensitive.
 * `UuidSchema` is also case-sensitive — Zod's built-in `z.uuid()` would
 * accept upper-case which we don't want at the DB boundary.
 */
export const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const UUID_RE = new RegExp(`^${UUID_PATTERN}$`);

/** Zod schema for a Cogmo UUIDv7-shaped string (lowercase). */
export const UuidSchema = z.string().regex(UUID_RE, "expected lowercase UUID");

/** Pure predicate — true iff `s` matches the standard UUID 8-4-4-4-12 lowercase shape. */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
