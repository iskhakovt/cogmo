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
 * Query parameters that carry a signature or credential — the list
 * `@opentelemetry/instrumentation-http` redacts from `url.full` by default
 * (`DEFAULT_QUERY_STRINGS_TO_REDACT`). `@opentelemetry/instrumentation-undici`
 * applies none, so its `url.full` and `url.query` carry them verbatim.
 */
const SIGNED_QUERY_PARAMS: readonly string[] = [
  "sig",
  "Signature",
  "AWSAccessKeyId",
  "X-Goog-Signature",
  "X-Amz-Signature",
  "X-Amz-Credential",
  "X-Amz-Security-Token",
];

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
 * `url` — a full URL or a path — with the value of every parameter in
 * {@link SIGNED_QUERY_PARAMS} in its query replaced by `REDACTED`. Returns
 * `url` itself, not re-encoded, when there is no such parameter.
 */
export function redactSignedQueryParams(url: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return url;
  const fragmentStart = url.indexOf("#", queryStart);
  const queryEnd = fragmentStart === -1 ? url.length : fragmentStart;
  const query = url.slice(queryStart, queryEnd);
  const redacted = redactSignedQuery(query);
  return redacted === query ? url : `${url.slice(0, queryStart)}${redacted}${url.slice(queryEnd)}`;
}

/**
 * `query` — a query string, with or without its leading `?` — with the value
 * of every parameter in {@link SIGNED_QUERY_PARAMS} replaced by `REDACTED`.
 * Returns `query` itself, not re-encoded, when there is no such parameter.
 */
export function redactSignedQuery(query: string): string {
  const prefix = query.startsWith("?") ? "?" : "";
  const params = new URLSearchParams(query.slice(prefix.length));
  const signed = SIGNED_QUERY_PARAMS.filter((name) => params.has(name));
  if (signed.length === 0) return query;
  for (const name of signed) params.set(name, REDACTED_QUERY_VALUE);
  return `${prefix}${params.toString()}`;
}
