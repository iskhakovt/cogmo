/**
 * Secrets masked in text before it leaves the process or is stored.
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
 * No shape is anchored on a word boundary, so one matches inside an
 * identifier too: a token can follow a letter, a digit or an underscore
 * (`MY_TOKEN_ghp_…`, a JSON-escaped `\nghp_…`, a colour code's `m`). Tokens
 * are told from words by their body instead. Each shape opens with a fixed
 * start (`://`, `gh[pousr]_`, `sk-ant-`, …) and no quantifier nests, so a pass
 * is linear; none spans whitespace, which is what `truncationSafeLength` rests
 * on.
 */

/** What a token-shaped path segment is replaced with. */
export const REDACTED_BOT_SEGMENT = "bot<redacted>";

/**
 * A secret's shape, as regex sources: the `start` every match opens with and
 * the `rest`, neither matching whitespace. `replacement` stands for the whole
 * match, with `$1` for the start.
 */
interface SecretShape {
  start: string;
  rest: string;
  replacement: string;
}

const SECRET_SHAPES: ReadonlyArray<SecretShape> = [
  // A URL's userinfo under any scheme, up to the last `@` before the host: a
  // user, a password, either alone or empty. It stops at whitespace, at the
  // delimiters that end the authority (`/?#`), and at `"` and `\`, so it never
  // runs on through a JSON string's closing quote or escape into the rest of a
  // log line. The `/` ending each candidate keeps candidates from overlapping.
  { start: "://", rest: String.raw`[^\s/?#"\\]*@`, replacement: "$1REDACTED@" },
  // A GitHub App installation token in its app-id-and-JWT form: the app id,
  // then base64url segments joined by `.`.
  { start: "ghs_", rest: String.raw`\d+_[A-Za-z0-9._-]{36,}`, replacement: "$1REDACTED" },
  // GitHub's base62 tokens: personal (`ghp_`), OAuth (`gho_`), user-to-server
  // (`ghu_`), installation tokens in their base62 form (`ghs_`) and refresh
  // (`ghr_`), each 30 random characters and a 6-character checksum. A body
  // without `_` is what tells one from a word like `highs_and_lows`; 20
  // characters still masks one cut short of its checksum.
  { start: "gh[pousr]_", rest: "[A-Za-z0-9]{20,}", replacement: "$1REDACTED" },
  // GitHub fine-grained tokens.
  { start: "github_pat_", rest: "[A-Za-z0-9_]{36,}", replacement: "$1REDACTED" },
  // Anthropic API keys and OAuth tokens: a kind and version (`api03`,
  // `oat01`), then the secret.
  { start: "sk-ant-", rest: String.raw`[a-z]+\d+-[A-Za-z0-9_-]{20,}`, replacement: "$1REDACTED" },
  // A Bot API token as a path segment: `/bot`, the numeric bot id, a colon
  // (literal or percent-encoded) and the secret's URL-safe base64 characters.
  // Anchored on the `/` so `bot` inside a longer segment doesn't match, and
  // host-agnostic so a self-hosted Bot API server (`apiRoot`) is covered too.
  // There is no trailing boundary: in running text a token can be followed
  // by any punctuation, and replacing a token-shaped prefix is the safe
  // failure.
  {
    start: "/bot",
    rest: String.raw`\d+(?::|%3[Aa])[A-Za-z0-9_-]+`,
    replacement: `/${REDACTED_BOT_SEGMENT}`,
  },
];

const MASKS = SECRET_SHAPES.map((shape) => ({
  pattern: new RegExp(`(${shape.start})${shape.rest}`, "g"),
  replacement: shape.replacement,
}));

/** Any shape's start. */
const SECRET_START = new RegExp(SECRET_SHAPES.map((shape) => shape.start).join("|"));

const WHITESPACE = /\s/;

/**
 * `text` with URL userinfo, GitHub and Anthropic tokens, and Bot API token
 * path segments masked. Works on anything that may embed them — a URL, an
 * error message or stack, command output, a serialized log line — and on its
 * own output unchanged.
 */
export function redactSecretsInText(text: string): string {
  return MASKS.reduce((out, mask) => out.replace(mask.pattern, mask.replacement), text);
}

/**
 * How much of `text`, cut off at its end, can be kept for masking. A secret
 * the cut ran through can end too early to be recognised, however long it is.
 * It lies in the last whitespace-free run and opens with a shape's start, so
 * everything before the first start in that run is safe, and all of `text` is
 * when the run holds none.
 */
export function truncationSafeLength(text: string): number {
  let runStart = text.length;
  while (runStart > 0 && !WHITESPACE.test(text.charAt(runStart - 1))) runStart -= 1;
  const start = text.slice(runStart).search(SECRET_START);
  return start === -1 ? text.length : runStart + start;
}
