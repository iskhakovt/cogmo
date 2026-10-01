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
 * A query parameter that carries a signature or credential — the names
 * `@opentelemetry/instrumentation-http` redacts from `url.full` by default
 * (`DEFAULT_QUERY_STRINGS_TO_REDACT`), matched as exactly there. The value
 * runs to the next `&` or `#`, or to a character that ends a URL in running
 * text (whitespace, a quote, `<`, `>`, `)`, `,`, `;`).
 * `@opentelemetry/instrumentation-undici` redacts none of them.
 */
const SIGNED_QUERY_PARAM =
  /([?&])(sig|Signature|AWSAccessKeyId|X-Goog-Signature|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=[^&#\s"'<>),;]*/g;

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
 * `text` with the value of every signed query parameter in it replaced by
 * `REDACTED`, in place: the rest of the text — other parameters, their
 * encoding, repeated keys — is left as it was. Works on a URL, a path with a
 * query, or running text that contains one. Returns `text` itself when
 * nothing matches.
 */
export function redactSignedQueryParams(text: string): string {
  if (!text.includes("=")) return text;
  return text.replace(SIGNED_QUERY_PARAM, `$1$2=${REDACTED_QUERY_VALUE}`);
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
