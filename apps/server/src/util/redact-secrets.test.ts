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
});
