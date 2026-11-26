import { types } from "node:util";
import { GrammyError, HttpError } from "grammy";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { TokenRedactor } from "./token-redaction.js";

/** Shaped like a Bot API token (numeric id, colon, URL-safe base64), but not one. */
const TOKEN = "123456:AAsecret-tok_en";
const ENCODED = encodeURIComponent(TOKEN);
const redact = new TokenRedactor(TOKEN);

/** Text carrying the token every way a Bot API error can echo it. */
const ECHO = `token ${TOKEN}, encoded ${ENCODED}, in https://bot-api.local/bot${TOKEN}/getMe and https%3A%2F%2Fbot-api.local%2Fbot${ENCODED}%2FgetMe`;
const MASKED =
  "token <redacted>, encoded <redacted>, in https://bot-api.local/bot<redacted>/getMe and https%3A%2F%2Fbot-api.local%2Fbot<redacted>%2FgetMe";

/** What pino writes for `err`. */
function serialized(err: unknown): string {
  return JSON.stringify(pino.stdSerializers.err(expectError(err)));
}

function expectError(value: unknown): Error {
  if (!(value instanceof Error)) throw new Error("expected an Error");
  return value;
}

describe("TokenRedactor.text", () => {
  it("masks the token raw and percent-encoded, bare and in a URL", () => {
    expect(redact.text(ECHO)).toBe(MASKED);
  });

  it("leaves text without the token unchanged", () => {
    expect(redact.text("Conflict: terminated by other getUpdates request")).toBe(
      "Conflict: terminated by other getUpdates request",
    );
  });

  it("masks a token percent-encoding leaves alone", () => {
    expect(new TokenRedactor("fake").text("a fake token")).toBe("a <redacted> token");
  });
});

describe("TokenRedactor.error", () => {
  it("masks a Bot API error's message, stack and description, keeping its type and fields", () => {
    const refusal = new GrammyError(
      "Call to 'getUpdates' failed!",
      { ok: false, error_code: 409, description: ECHO },
      "getUpdates",
      { offset: 7 },
    );

    const copy = expectError(redact.error(refusal));

    expect(copy).toBeInstanceOf(GrammyError);
    expect(copy).toMatchObject({
      message: `Call to 'getUpdates' failed! (409: ${MASKED})`,
      description: MASKED,
      error_code: 409,
      method: "getUpdates",
      payload: { offset: 7 },
    });
    expect(copy.stack).toContain(MASKED);
    expect(copy.stack).not.toContain(TOKEN);
  });

  it("masks the error an HttpError wraps", () => {
    const fetchError = Object.assign(new Error(`request to ${ECHO} failed`), {
      type: "system",
      code: "ECONNRESET",
    });
    const failure = new HttpError("Network request for 'getUpdates' failed!", fetchError);

    const copy = redact.error(failure);

    expect(copy).toBeInstanceOf(HttpError);
    expect(copy).toMatchObject({
      error: { message: `request to ${MASKED} failed`, type: "system", code: "ECONNRESET" },
    });
  });

  it("masks a cause, which stays non-enumerable", () => {
    const err = new Error(ECHO, { cause: new Error(ECHO) });

    const copy = expectError(redact.error(err));

    expect(expectError(copy.cause).message).toBe(MASKED);
    expect(Object.keys(copy)).not.toContain("cause");
  });

  it("copies a cause cycle once", () => {
    const err = new Error(ECHO);
    err.cause = err;

    const copy = expectError(redact.error(err));

    expect(copy.cause).toBe(copy);
  });

  it("copies an error without the token as a native error equal to it", () => {
    const refusal = new GrammyError(
      "Call to 'getMe' failed!",
      { ok: false, error_code: 404, description: "Not Found" },
      "getMe",
      {},
    );

    const copy = redact.error(refusal);

    expect(copy).not.toBe(refusal);
    expect(types.isNativeError(copy)).toBe(true);
    expect(copy).toEqual(refusal);
  });

  it("leaves the error it was given unchanged", () => {
    const refusal = new GrammyError(
      "Call to 'getUpdates' failed!",
      { ok: false, error_code: 409, description: ECHO },
      "getUpdates",
      {},
    );

    redact.error(refusal);

    expect(refusal.description).toBe(ECHO);
    expect(refusal.message).toContain(TOKEN);
  });

  it("writes nothing of the token through pino's serializer, and names the type", () => {
    const failure = new HttpError(
      "Network request for 'getUpdates' failed!",
      new Error(ECHO, { cause: new Error(ECHO) }),
    );

    const line = serialized(redact.error(failure));

    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain(ENCODED);
    expect(line).toContain("<redacted>");
    expect(JSON.parse(line)).toMatchObject({ type: "HttpError" });
    expect(serialized(failure)).toContain(TOKEN);
  });

  it("masks a thrown string and hands anything else back", () => {
    const payload = { reason: "not an Error" };

    expect(redact.error(ECHO)).toBe(MASKED);
    expect(redact.error(payload)).toBe(payload);
    expect(redact.error(undefined)).toBeUndefined();
  });
});
