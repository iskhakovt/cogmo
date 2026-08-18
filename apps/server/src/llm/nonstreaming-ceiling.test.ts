/**
 * Canary for `MAX_NONSTREAMING_TOKENS` in `anthropic.ts`, which mirrors a
 * threshold the SDK computes internally and never exports. Nothing
 * upstream promises that ratio, so a bump could move it with no signal
 * beyond every non-streaming call starting to fail; probing the installed
 * SDK from both sides turns that into a failure here with a number to
 * update.
 *
 * Separate from `anthropic.test.ts`, which mocks `@anthropic-ai/sdk`
 * wholesale and so cannot see the guard. No sockets either: the injected
 * `fetch` records being reached, which is the signal, and keeps the tier
 * hermetic.
 */

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { MAX_NONSTREAMING_TOKENS } from "./anthropic.js";

const GUARD_MESSAGE = "Streaming is required";

let reachedFetch = false;

/**
 * Stands in for the network. The guard runs first, so reaching here at
 * all means it declined to fire. The rejection's message is not the
 * signal — the SDK rewraps it as `APIConnectionError`.
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
