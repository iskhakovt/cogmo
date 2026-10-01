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

/**
 * A Bot API token as a path segment: `/bot`, the numeric bot id, a colon
 * (literal or percent-encoded) and the secret's URL-safe base64 characters.
 * Anchored on the `/` so `bot` inside a longer segment doesn't match, and
 * host-agnostic so a self-hosted Bot API server (`apiRoot`) is covered too.
 * There is no trailing boundary: in running text a token can be followed by
 * any punctuation, and replacing a token-shaped prefix is the safe failure.
 */
const BOT_TOKEN_SEGMENT = /\/bot\d+(?::|%3[Aa])[A-Za-z0-9_-]+/g;

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
