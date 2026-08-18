/**
 * Canary for `MAX_NONSTREAMING_TOKENS` in `anthropic.ts`.
 *
 * That constant is a number the SDK computes internally and never
 * exports: it refuses a non-streaming request whose projected generation
 * time passes its default timeout, throwing before the request leaves the
 * process. The projection is `60min * max_tokens / 128_000` against a
 * 10-minute default, which puts the ceiling at 21_333 — but nothing
 * upstream promises that ratio, and a version bump could move it with no
 * signal other than every non-streaming call starting to fail.
 *
 * These assertions probe the installed SDK for the real boundary, so a
 * bump that moves it fails here with a number to update rather than in
 * production. Deliberately not part of `anthropic.test.ts`, which mocks
 * `@anthropic-ai/sdk` wholesale and so cannot see the guard at all.
 *
 * Offline: the guard runs client-side, and the requests that get past it
 * are aimed at a closed port, so they fail as connection errors without
 * leaving the machine.
 */

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { MAX_NONSTREAMING_TOKENS } from "./anthropic.js";

/**
 * Nothing listens here; anything past the guard fails to connect.
 * `maxRetries: 0` keeps that failure immediate — the SDK's default of 2
 * would spend backoff on connection attempts that cannot succeed, and on
 * a host that blackholes rather than refuses, hold the test to its
 * timeout instead of failing fast.
 */
const client = new Anthropic({
  apiKey: "not-a-real-key",
  baseURL: "http://127.0.0.1:1",
  maxRetries: 0,
});

const GUARD_MESSAGE = "Streaming is required";

async function guardFiresAt(maxTokens: number): Promise<boolean> {
  try {
    await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: "hi" }],
    });
    return false;
  } catch (err) {
    return err instanceof Error && err.message.includes(GUARD_MESSAGE);
  }
}

describe("SDK non-streaming max_tokens ceiling", () => {
  it("accepts a request exactly at our ceiling", async () => {
    expect(await guardFiresAt(MAX_NONSTREAMING_TOKENS)).toBe(false);
  });

  it("rejects a request one token above it", async () => {
    expect(await guardFiresAt(MAX_NONSTREAMING_TOKENS + 1)).toBe(true);
  });
});
