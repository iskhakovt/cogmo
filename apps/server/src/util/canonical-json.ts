import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import * as R from "remeda";

/**
 * Escape marker for the encodings {@link toCanonicalizable} substitutes.
 *
 * U+FFFD is doubled wherever it already occurs in the input, which makes the
 * escape alphabet prefix-free: a single U+FFFD in the output always opens an
 * escape, a doubled one always denotes the literal character. The whole
 * substitution is therefore injective — distinct inputs stay distinct, which
 * is the property every digest over it depends on.
 */
const ESCAPE = "�";

/** Single-key wrappers standing in for values RFC 8785 cannot express. */
const NON_FINITE_KEY = `${ESCAPE}non-finite`;
const CIRCULAR_KEY = `${ESCAPE}circular`;

/** Any surrogate code unit or a literal U+FFFD — a cheap "might need escaping" test. */
const NEEDS_ESCAPE = /[\uD800-\uDFFF�]/;

/** A high surrogate with no low after it, or a low surrogate with no high before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Encode lone surrogates so the result is well-formed without merging
 * distinct inputs. Each unpaired code unit becomes `ESCAPE` plus its four hex
 * digits; pre-existing U+FFFD is doubled first so the two cases never alias.
 * Well-formed surrogate pairs pass through untouched.
 */
function escapeIllFormed(s: string): string {
  if (!NEEDS_ESCAPE.test(s)) return s;
  return s
    .replaceAll(ESCAPE, ESCAPE + ESCAPE)
    .replace(LONE_SURROGATE, (cu) => `${ESCAPE}${cu.charCodeAt(0).toString(16)}`);
}

/**
 * Rewrite a value into the subset `canonicalize` accepts.
 *
 * RFC 8785 has no encoding for three things a model-written value can carry,
 * and `canonicalize` throws on each: ill-formed strings, non-finite numbers
 * (`JSON.parse('{"n":1e999}')` yields `Infinity` from perfectly valid JSON
 * text), and reference cycles. Each case gets a deterministic stand-in
 * instead, so hashing a value never aborts the caller.
 *
 * With the non-finite marker {@link canonicalJson} uses, the substitutions
 * are injective, and every escape is anchored on a lone
 * U+FFFD that {@link escapeIllFormed} guarantees cannot occur in a translated
 * string or key. Two consequences digests rely on: a 2-key object stays a
 * 2-key object, and the pre-pass never reorders anything, so `canonicalize`
 * still sorts the same key set regardless of emission order.
 *
 * Only arrays and plain objects are walked. Anything else with a `toJSON`
 * reaches `canonicalize` untouched and takes its own path there.
 *
 * `nonFinite` is what a non-finite number becomes.
 */
function toCanonicalizable(
  value: unknown,
  ancestors: Set<object>,
  nonFinite: (n: number) => unknown,
): unknown {
  if (typeof value === "string") return escapeIllFormed(value);
  if (typeof value === "number" && !Number.isFinite(value)) return nonFinite(value);
  if (value === null || typeof value !== "object") return value;
  if (!Array.isArray(value) && !R.isPlainObject(value)) return value;
  if (ancestors.has(value)) return { [CIRCULAR_KEY]: true };

  ancestors.add(value);
  const encoded = Array.isArray(value)
    ? value.map((v) => toCanonicalizable(v, ancestors, nonFinite))
    : Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          escapeIllFormed(k),
          toCanonicalizable(v, ancestors, nonFinite),
        ]),
      );
  ancestors.delete(value);
  return encoded;
}

/**
 * Stand-in hash input for a value no encoder could render: one holding a
 * `BigInt` or a throwing `toJSON`, or nested past the call stack. Distinct
 * unencodable inputs share it and compare equal; for tool arguments that can
 * only inflate Class D's counters for repeated calls to the *same* tool, which
 * the loop's side-effect gate and iteration cap bound; for a transcript head,
 * an edit inside such a message goes unseen. The alternative, propagating the
 * throw, ends the turn outright.
 */
const UNENCODABLE_ARGS = `${ESCAPE}unencodable`;

/**
 * Total canonical-JSON encoding for hashing. Wraps the `canonicalize` library
 * (RFC 8785 JSON Canonicalization Scheme) — sorted object keys at every depth,
 * arrays preserve order — behind {@link toCanonicalizable}, which
 * pre-translates the values RFC 8785 cannot express.
 *
 * Never throws. `canonicalize` returns `undefined` for top-level `undefined` /
 * function / symbol input; the catch covers whatever the library rejects that
 * the pre-pass doesn't anticipate (a `BigInt`, a throwing `toJSON`). Both land
 * on {@link UNENCODABLE_ARGS}.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, (n) => ({ [NON_FINITE_KEY]: String(n) }));
}

/**
 * {@link canonicalJson} of `value` as JSON sends it: a non-finite number,
 * which `JSON.stringify` writes as `null`, is `null`, so a value held in memory
 * and the same value reloaded from a memo or a row encode the same.
 */
export function canonicalJsonAsSent(value: unknown): string {
  return encode(value, () => null);
}

function encode(value: unknown, nonFinite: (n: number) => unknown): string {
  try {
    return canonicalize(toCanonicalizable(value, new Set(), nonFinite)) ?? UNENCODABLE_ARGS;
  } catch {
    return UNENCODABLE_ARGS;
  }
}

/** The SHA-256 of `s`'s UTF-8 bytes, as lowercase hex. */
export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
