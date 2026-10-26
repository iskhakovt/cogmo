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
 * digit or an underscore (`MY_TOKEN_ghp_…`, a JSON-escaped `\nghp_…`, a
 * colour code's `m`). Tokens are told from words by their body instead. Each
 * pattern starts with a literal and no quantifier nests, so a pass is linear.
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
 * user, a password, either alone or empty. It stops at whitespace and at the
 * delimiters that end the authority (`/?#`), and at `"` and `\`, so it never
 * runs on through a JSON string's closing quote or escape into the rest of a
 * log line. The `/` ending each candidate also keeps candidates from
 * overlapping.
 */
const URL_USERINFO = /:\/\/[^\s/?#"\\]*@/g;

/** GitHub classic, OAuth, user-to-server, server-to-server and refresh tokens: 36+ base62 characters. */
const GITHUB_TOKEN = /(gh[pousr])_[A-Za-z0-9]{36,}/g;

/** GitHub fine-grained tokens. */
const GITHUB_FINE_GRAINED_TOKEN = /github_pat_[A-Za-z0-9_]{36,}/g;

/** Anthropic API keys and OAuth tokens: a kind and version (`api03`, `oat01`), then the secret. */
const ANTHROPIC_KEY = /sk-ant-[a-z]+\d+-[A-Za-z0-9_-]{20,}/g;

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
    .replace(GITHUB_FINE_GRAINED_TOKEN, "github_pat_REDACTED")
    .replace(ANTHROPIC_KEY, "sk-ant-REDACTED")
    .replace(BOT_TOKEN_SEGMENT, `/${REDACTED_BOT_SEGMENT}`);
}
