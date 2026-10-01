/**
 * Secrets that travel inside URLs, scrubbed from telemetry and logs before
 * either leaves the process.
 *
 * Telegram's Bot API authenticates by path: a method call is
 * `<apiRoot>/bot<bot id>:<secret>/<method>` and a file download is
 * `<apiRoot>/file/bot<bot id>:<secret>/<file path>`. That URL is what HTTP
 * client instrumentation records as `url.full` / `url.path`, and what
 * node-fetch (grammY's HTTP client) writes into its error messages
 * (`request to <url> failed, reason: …`).
 */

/** What a token-shaped path segment is replaced with. */
export const REDACTED_BOT_SEGMENT = "bot<redacted>";

/** The value a signed or credential-bearing query parameter is replaced with. */
export const REDACTED_QUERY_VALUE = "REDACTED";

/**
 * A Bot API token as a path segment: `/bot`, the numeric bot id, a colon
 * (literal or percent-encoded) and the secret's URL-safe base64 characters.
 * Anchored on the `/` so `bot` inside a longer segment doesn't match, and
 * host-agnostic so a self-hosted Bot API server (`apiRoot`) is covered too.
 */
const BOT_TOKEN_SEGMENT = /\/bot\d+(?::|%3[Aa])[A-Za-z0-9_-]+/g;

/**
 * The query parameters that carry a signature or credential — the names
 * `@opentelemetry/instrumentation-http` redacts from `url.full` by default
 * (`DEFAULT_QUERY_STRINGS_TO_REDACT`), matched as exactly there.
 * `@opentelemetry/instrumentation-undici` redacts none of them.
 */
const SIGNED_PARAM_NAMES =
  "sig|Signature|AWSAccessKeyId|X-Goog-Signature|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token";

/** A signed parameter in a URL: its value runs to the next `&` or `#`. */
const SIGNED_PARAM_IN_URL = new RegExp(`([?&])(${SIGNED_PARAM_NAMES})=[^&#]*`, "g");

/**
 * A signed parameter in running text: its value also ends at a character
 * that ends a URL there (whitespace, a quote, `<`, `>`, `)`, `,`, `;`).
 */
const SIGNED_PARAM_IN_TEXT = new RegExp(`([?&])(${SIGNED_PARAM_NAMES})=[^&#\\s"'<>),;]*`, "g");

/**
 * `text` with every Bot API token path segment replaced by
 * `bot<redacted>`. Works on anything that may embed such a URL — a URL, an
 * error message or stack, a serialized log line. Returns `text` itself when
 * nothing matches.
 */
export function redactSecretsInText(text: string): string {
  if (!text.includes("/bot")) return text;
  return text.replace(BOT_TOKEN_SEGMENT, `/${REDACTED_BOT_SEGMENT}`);
}

/**
 * `url` — a URL, a path with a query, or a query with its leading `?` — with
 * the value of every signed query parameter replaced by `REDACTED`, in
 * place: other parameters, their encoding and repeated keys are left as
 * they were. Returns `url` itself when nothing matches.
 */
export function redactSignedQueryParams(url: string): string {
  if (!url.includes("=")) return url;
  return url.replace(SIGNED_PARAM_IN_URL, `$1$2=${REDACTED_QUERY_VALUE}`);
}

/**
 * {@link redactSignedQueryParams} for a query string on its own, with or
 * without its leading `?` — `url.query` as each instrumentation writes it.
 */
export function redactSignedQuery(query: string): string {
  if (query.startsWith("?")) return redactSignedQueryParams(query);
  const redacted = redactSignedQueryParams(`?${query}`).slice(1);
  return redacted === query ? query : redacted;
}

/**
 * {@link redactSignedQueryParams} for running text that may contain URLs —
 * an error message or stack trace — where a value can't be read to the next
 * `&` alone without swallowing the text after the URL.
 */
export function redactSignedQueryParamsInText(text: string): string {
  if (!text.includes("=")) return text;
  return text.replace(SIGNED_PARAM_IN_TEXT, `$1$2=${REDACTED_QUERY_VALUE}`);
}
