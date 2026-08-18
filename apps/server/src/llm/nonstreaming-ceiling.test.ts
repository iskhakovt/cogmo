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
 * No sockets: the client is built with a `fetch` that throws instead of
 * dialling. The guard runs before the SDK reaches `fetch`, so which of
 * the two errors comes back says whether it fired — and the tier stays
 * hermetic, with nothing to hang on a runner that blackholes traffic
 * rather than refusing it.
 */

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { MAX_NONSTREAMING_TOKENS } from "./anthropic.js";

const GUARD_MESSAGE = "Streaming is required";

let reachedFetch = false;

/**
 * Stands in for the network. Whether the SDK gets here is the signal —
 * the guard runs first, so being called at all means it declined to fire.
 * The rejection's own error is discarded: the SDK rewraps it as
 * `APIConnectionError`, so the flag is the reliable observation, not the
 * message.
 */
const client = new Anthropic({
  apiKey: "not-a-real-key",
  fetch: () => {
    reachedFetch = true;
    return Promise.reject(new Error("no network in the unit tier"));
  },
  maxRetries: 0,
});

async function probe(maxTokens: number): Promise<{ fired: boolean; sawGuardMessage: boolean }> {
  reachedFetch = false;
  let sawGuardMessage = false;
  try {
    await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: "hi" }],
    });
  } catch (err) {
    sawGuardMessage = err instanceof Error && err.message.includes(GUARD_MESSAGE);
  }
  return { fired: !reachedFetch, sawGuardMessage };
}

describe("SDK non-streaming max_tokens ceiling", () => {
  it("accepts a request exactly at our ceiling", async () => {
    const { fired } = await probe(MAX_NONSTREAMING_TOKENS);
    expect(fired).toBe(false);
  });

  it("rejects a request one token above it", async () => {
    const { fired, sawGuardMessage } = await probe(MAX_NONSTREAMING_TOKENS + 1);
    expect(fired).toBe(true);
    // Pin the reason too, so an unrelated client-side rejection can't pass
    // for the ceiling moving.
    expect(sawGuardMessage).toBe(true);
  });
});
