import { describe, expect, it } from "vitest";
import { REDACTED_BOT_SEGMENT, redactSecretsInText } from "./redact-secrets.js";

/** Shaped like a Bot API token (numeric id, colon, URL-safe base64), but not one. */
const FAKE_SECRET = "AAFake-TokenForTests_0123456789abcdef";
const FAKE_TOKEN = `123456789:${FAKE_SECRET}`;

describe("redactSecretsInText", () => {
  it.each([
    [
      "a Bot API method URL",
      `https://api.telegram.org/bot${FAKE_TOKEN}/sendPhoto`,
      `https://api.telegram.org/${REDACTED_BOT_SEGMENT}/sendPhoto`,
    ],
    [
      "a file download URL",
      `https://api.telegram.org/file/bot${FAKE_TOKEN}/photos/file_7.jpg`,
      `https://api.telegram.org/file/${REDACTED_BOT_SEGMENT}/photos/file_7.jpg`,
    ],
    [
      "a path alone, as url.path carries it",
      `/bot${FAKE_TOKEN}/getUpdates`,
      `/${REDACTED_BOT_SEGMENT}/getUpdates`,
    ],
    [
      "a self-hosted Bot API server",
      `http://127.0.0.1:8081/bot${FAKE_TOKEN}/getMe`,
      `http://127.0.0.1:8081/${REDACTED_BOT_SEGMENT}/getMe`,
    ],
    [
      "a percent-encoded colon",
      `https://api.telegram.org/bot123456789%3A${FAKE_SECRET}/getMe`,
      `https://api.telegram.org/${REDACTED_BOT_SEGMENT}/getMe`,
    ],
    [
      "a token as the last segment",
      `https://api.telegram.org/bot${FAKE_TOKEN}`,
      `https://api.telegram.org/${REDACTED_BOT_SEGMENT}`,
    ],
    [
      "a token followed by punctuation",
      `invalid json response body at https://api.telegram.org/bot${FAKE_TOKEN}.`,
      `invalid json response body at https://api.telegram.org/${REDACTED_BOT_SEGMENT}.`,
    ],
    [
      "node-fetch's error message",
      `request to https://api.telegram.org/bot${FAKE_TOKEN}/getUpdates failed, reason: socket hang up`,
      `request to https://api.telegram.org/${REDACTED_BOT_SEGMENT}/getUpdates failed, reason: socket hang up`,
    ],
    [
      "a serialized log line, more than once",
      `{"msg":"x","err":{"message":"request to https://api.telegram.org/bot${FAKE_TOKEN}/a failed","stack":"FetchError: request to https://api.telegram.org/bot${FAKE_TOKEN}/a failed"}}`,
      `{"msg":"x","err":{"message":"request to https://api.telegram.org/${REDACTED_BOT_SEGMENT}/a failed","stack":"FetchError: request to https://api.telegram.org/${REDACTED_BOT_SEGMENT}/a failed"}}`,
    ],
  ])("redacts the token in %s", (_label, input, expected) => {
    const output = redactSecretsInText(input);
    expect(output).toBe(expected);
    expect(output).not.toContain(FAKE_SECRET);
  });

  it.each([
    ["an unrelated URL", "https://api.anthropic.com/v1/messages?beta=true"],
    ["a Bot API URL with no token", "https://api.telegram.org/"],
    ["a `bot` segment without an id", "https://example.com/bot/status"],
    ["a `bot<id>` segment without a secret", "https://example.com/bot123/x"],
    ["an empty secret", "https://example.com/bot123:/x"],
    ["`bot` inside a longer segment", "https://example.com/robot123:abc/x"],
    ["a word starting with bot", "https://example.com/botanist/1:2"],
    ["a capitalised segment", `https://example.com/BOT${FAKE_TOKEN}/x`],
    ["text with no URL", "telegram polling loop failed"],
  ])("leaves %s untouched", (_label, input) => {
    expect(redactSecretsInText(input)).toBe(input);
  });

  const PAT = `ghp_${"a1B2".repeat(9)}`;

  it.each([
    [
      "a user and password",
      "fatal: unable to access 'https://x-access-token:s3cret@github.com/o/r.git/'",
      "fatal: unable to access 'https://REDACTED@github.com/o/r.git/'",
    ],
    ["an ssh URL", "ssh://git:PW@host:22/o/r.git", "ssh://REDACTED@host:22/o/r.git"],
    [
      "a token as the user, with no password",
      "https://glpat-abcdefghij0123456789@gitlab.com/o/r",
      "https://REDACTED@gitlab.com/o/r",
    ],
    [
      "a 40-hex token as the user",
      "https://0123456789abcdef0123456789abcdef01234567@github.com/o/r",
      "https://REDACTED@github.com/o/r",
    ],
    ["an empty user", "https://:SECRET@host/x", "https://REDACTED@host/x"],
    [
      "an @ inside the password, up to the last @ before the host",
      "connect through http://operator:p@ss@proxy.internal:3128/ failed",
      "connect through http://REDACTED@proxy.internal:3128/ failed",
    ],
    [
      "a URL glued to a JSON-escaped newline",
      String.raw`{"msg":"push failed\nhttps://u:p@h/x"}`,
      String.raw`{"msg":"push failed\nhttps://REDACTED@h/x"}`,
    ],
    ["two URLs", "a://u:p@h1/ b://u:p@h2/", "a://REDACTED@h1/ b://REDACTED@h2/"],
  ])("masks URL credentials: %s", (_label, input, expected) => {
    expect(redactSecretsInText(input)).toBe(expected);
  });

  it.each(["ghp", "gho", "ghu", "ghs", "ghr", "github_pat"])("masks %s_ tokens", (prefix) => {
    const token = `${prefix}_${"A1b2_".repeat(8)}`;
    expect(redactSecretsInText(`GH_TOKEN=${token} rest`)).toBe(`GH_TOKEN=${prefix}_REDACTED rest`);
  });

  it.each([
    ["after an identifier", `MY_TOKEN_${PAT}`, "MY_TOKEN_ghp_REDACTED"],
    ["after a digit", `1${PAT}`, "1ghp_REDACTED"],
    ["after a JSON-escaped newline", String.raw`"a\n${PAT}"`, String.raw`"a\nghp_REDACTED"`],
    [
      "an Anthropic OAuth token",
      `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-${"Ab9_-".repeat(20)}`,
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-REDACTED",
    ],
    ["an Anthropic API key", `key sk-ant-api03-${"x".repeat(90)}.`, "key sk-ant-REDACTED."],
  ])("masks a token %s", (_label, input, expected) => {
    expect(redactSecretsInText(input)).toBe(expected);
  });

  it.each([
    ["an scp-style remote", "To git@github.com:o/r.git"],
    ["a URL with no userinfo", "remote: https://github.com/o/r/pull/new/cogmo/abc"],
    ["a port after the host", "https://github.com:443/o/r"],
    ["an address after a URL", "see https://github.com: denied for user@example.com"],
    ["a URL then an address in a JSON line", '{"url":"https://github.com","user":"a@b.c"}'],
    ["a push rejection", " ! [rejected]        cogmo/abc -> cogmo/abc (non-fast-forward)"],
    ["a short token-like word", "ghp_short and sk-ant-short"],
  ])("leaves %s untouched", (_label, input) => {
    expect(redactSecretsInText(input)).toBe(input);
  });

  it("is idempotent", () => {
    const once = redactSecretsInText(`https://u:${PAT}@github.com ${PAT} sk-ant-${"y".repeat(30)}`);
    expect(redactSecretsInText(once)).toBe(once);
  });

  it.each([
    ["a long word", "a".repeat(200_000)],
    ["repeated scheme separators", "://x".repeat(50_000)],
    ["repeated token prefixes", "ghp_".repeat(50_000)],
    ["repeated key prefixes", "sk-ant-".repeat(30_000)],
  ])("stays linear on %s", (_label, input) => {
    const start = performance.now();
    redactSecretsInText(input);
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});
