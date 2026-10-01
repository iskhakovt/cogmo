/**
 * Canonical shape for compartment + profile-class names. Lowercase ASCII
 * letters / digits / hyphen / underscore, must start with a letter, ≤32
 * chars. Mirrors the format of `CORE_COMPARTMENTS` values so the merged
 * set is uniform, prevents `Work` / `work` conceptual duplicates, and
 * avoids weird Unicode or whitespace landing in Hindsight tag values.
 */
export const CANONICAL_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
