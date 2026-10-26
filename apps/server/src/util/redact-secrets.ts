/**
 * Secrets masked in text before it leaves the process or is stored: log
 * lines, exported spans, boot errors, and the coding orchestrators' failure
 * reasons and PR bodies.
 *
 * Telegram's Bot API authenticates by path: a method call is
 * `<apiRoot>/bot<bot id>:<secret>/<method>` and a file download is
 * `<apiRoot>/file/bot<bot id>:<secret>/<file path>`. That URL is what HTTP
 * client instrumentation records as `url.full` / `url.path`, and what
 * node-fetch (grammY's HTTP client) writes into its error messages
 * (`request to <url> failed, reason: …`).
 *
 * Git and HTTP clients quote URLs that carry credentials in their userinfo,
 * and tool output can carry a bare GitHub or Anthropic token.
 *
 * No pattern is anchored on a word boundary: a token can follow a letter, a
 * digit or an underscore (`MY_TOKEN_ghp_…`, a JSON-escaped `\nghp_…`). Each
 * starts with a literal and has one quantifier, so a pass is linear.
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
 * A URL's userinfo under any scheme, up to the last `@` before the host: a
 * user, a password, either alone or empty. It can't hold whitespace, a
 * delimiter that ends the authority (`/?#`), or a character a URL must
 * percent-encode (quotes, backslash, angle brackets), so a candidate never
 * runs past its host into the surrounding text or JSON. The `/` ending each
 * candidate also keeps candidates from overlapping.
 */
const URL_USERINFO = /:\/\/[^\s/?#"'`<>\\{}|^]*@/g;

/** GitHub classic, OAuth, user-to-server, server-to-server, refresh and fine-grained tokens. */
const GITHUB_TOKEN = /(gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g;

/** Anthropic API keys and OAuth tokens: `sk-ant-api03-…`, `sk-ant-oat01-…`. */
const ANTHROPIC_KEY = /sk-ant-[A-Za-z0-9_-]{20,}/g;

/**
 * `text` with URL userinfo, GitHub and Anthropic tokens, and Bot API token
 * path segments masked. Works on anything that may embed them — a URL, an
 * error message or stack, command output, a serialized log line — and on its
 * own output unchanged.
 */
export function redactSecretsInText(text: string): string {
  return text
    .replace(URL_USERINFO, "://REDACTED@")
    .replace(GITHUB_TOKEN, "$1_REDACTED")
    .replace(ANTHROPIC_KEY, "sk-ant-REDACTED")
    .replace(BOT_TOKEN_SEGMENT, `/${REDACTED_BOT_SEGMENT}`);
}
