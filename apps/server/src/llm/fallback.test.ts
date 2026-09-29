import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockProvider } from "../test/factories.js";
import { ProviderProtocolError } from "./errors.js";
import {
  AllProvidersFailedError,
  FallbackLlmProvider,
  isRetriableProviderError,
  RefusalError,
} from "./fallback.js";
import type { LlmProvider } from "./provider.js";
import type { ChatParams, ChatStreamFrame, LlmResponse } from "./types.js";

// --- Error construction helpers ---

/**
 * Build an Error with a numeric `status` field, matching the shape both the
 * Anthropic SDK and OpenAI SDK use on their APIError classes (duck-typed).
 */
function apiError(status: number, message = `HTTP ${status}`): Error {
  const err = new Error(message);
  err.name = "APIError";
  (err as Error & { status: number }).status = status;
  return err;
}

function networkError(message = "ECONNREFUSED"): Error {
  const err = new Error(message);
  err.name = "FetchError";
  return err;
}

// --- Stream helpers ---

type ContentFrame = Exclude<ChatStreamFrame, { type: "done" }>;

const DONE: ChatStreamFrame = {
  type: "done",
  meta: { stopReason: "end_turn", model: "mock-model", usage: { inputTokens: 1, outputTokens: 1 } },
};

/** A candidate stream that yields `frames`, then `done`. */
async function* streamOf(frames: ContentFrame[]): AsyncGenerator<ChatStreamFrame> {
  yield* frames;
  yield DONE;
}

/**
 * A candidate stream that throws on its first pull — the SDK failing while
 * establishing the stream (pre-stream failure).
 */
function streamFailsBeforeFirstFrame(err: unknown): AsyncIterable<ChatStreamFrame> {
  // Plain async iterable — no generator function, so biome's `useYield` rule
  // doesn't fire on a generator that only throws.
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<ChatStreamFrame>> {
          throw err;
        },
      };
    },
  };
}

/**
 * A candidate stream that yields one frame, then throws — a mid-stream
 * failure after the consumer has seen output.
 */
async function* streamFailsMidStream(err: unknown): AsyncGenerator<ChatStreamFrame> {
  yield { type: "text_delta", text: "partial" };
  throw err;
}

/** A candidate stream that records when its cleanup runs. */
async function* streamWithCleanup(cleanup: () => void): AsyncGenerator<ChatStreamFrame> {
  try {
    yield { type: "text_delta", text: "one" };
    yield { type: "text_delta", text: "two" };
    yield DONE;
  } finally {
    cleanup();
  }
}

/** The error an SDK throws for an aborted request: no status, so it would classify as transient. */
function userAbortError(): Error {
  const err = new Error("Request was aborted.");
  err.name = "APIUserAbortError";
  return err;
}

const chatParams: ChatParams = {
  model: "m",
  system: "s",
  messages: [{ role: "user", content: "hi" }],
};

// --- isRetriableProviderError ---

describe("isRetriableProviderError", () => {
  const cases: Array<[string, unknown, boolean]> = [
    ["400 bad request", apiError(400), false],
    ["401 unauthorized", apiError(401), false],
    ["403 forbidden", apiError(403), false],
    ["404 not found", apiError(404), false],
    ["409 conflict", apiError(409), false],
    ["422 unprocessable", apiError(422), false],
    ["408 request timeout", apiError(408), true],
    ["425 too early", apiError(425), true],
    ["429 too many requests", apiError(429), true],
    ["500 internal server error", apiError(500), true],
    ["502 bad gateway", apiError(502), true],
    ["503 service unavailable", apiError(503), true],
    ["599 edge case 5xx", apiError(599), true],
    ["network error without status", networkError(), true],
    ["string throw", "oops", false],
    ["undefined throw", undefined, false],
    [
      "ProviderProtocolError (no status, but content-level failure)",
      new ProviderProtocolError("tool_use args unparseable", new SyntaxError("bad json")),
      false,
    ],
    // Refusals are policy decisions — silent re-routing to the next provider
    // is the wrong shape. See design/agent-resilience.md Class C.
    ["RefusalError", new RefusalError("refused"), false],
  ];

  it.each(cases)("%s → retriable=%s", (_label, err, expected) => {
    expect(isRetriableProviderError(err)).toBe(expected);
  });
});

// --- Constructor ---

describe("FallbackLlmProvider constructor", () => {
  it("rejects an empty provider list", () => {
    expect(() => new FallbackLlmProvider([])).toThrow(/at least one provider/);
  });

  it("uses the single provider's name when given exactly one", () => {
    const only = mockProvider({ name: "anthropic" });
    expect(new FallbackLlmProvider([only]).name).toBe("anthropic");
  });

  it("composes names when given multiple providers", () => {
    const p1 = mockProvider({ name: "anthropic" });
    const p2 = mockProvider({ name: "openrouter" });
    expect(new FallbackLlmProvider([p1, p2]).name).toBe("fallback(anthropic,openrouter)");
  });
});

// --- chat() ---

describe("FallbackLlmProvider.chat", () => {
  const sampleResponse: LlmResponse = {
    content: [{ type: "text", text: "ok" }],
    stopReason: "end_turn",
    model: "mock",
    usage: { inputTokens: 1, outputTokens: 1 },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the primary's result when primary succeeds, secondary never called", async () => {
    const primary = mockProvider({
      name: "primary",
      chat: vi.fn().mockResolvedValue(sampleResponse),
    });
    const secondary = mockProvider({
      name: "secondary",
      chat: vi.fn().mockResolvedValue(sampleResponse),
    });

    const fb = new FallbackLlmProvider([primary, secondary]);
    const result = await fb.chat(chatParams);

    expect(result).toBe(sampleResponse);
    expect(primary.chat).toHaveBeenCalledOnce();
    expect(secondary.chat).not.toHaveBeenCalled();
  });

  it("falls back to the secondary on a transient 500 error", async () => {
    const primary = mockProvider({
      name: "primary",
      chat: vi.fn().mockRejectedValue(apiError(500)),
    });
    const secondary = mockProvider({
      name: "secondary",
      chat: vi.fn().mockResolvedValue(sampleResponse),
    });

    const fb = new FallbackLlmProvider([primary, secondary]);
    const result = await fb.chat(chatParams);

    expect(result).toBe(sampleResponse);
    expect(primary.chat).toHaveBeenCalledOnce();
    expect(secondary.chat).toHaveBeenCalledOnce();
  });

  it("propagates permanent 401 error without trying secondary", async () => {
    const primary = mockProvider({
      name: "primary",
      chat: vi.fn().mockRejectedValue(apiError(401, "invalid api key")),
    });
    const secondary = mockProvider({
      name: "secondary",
      chat: vi.fn().mockResolvedValue(sampleResponse),
    });

    const fb = new FallbackLlmProvider([primary, secondary]);

    await expect(fb.chat(chatParams)).rejects.toMatchObject({ status: 401 });
    expect(secondary.chat).not.toHaveBeenCalled();
  });

  it("throws AllProvidersFailedError with ordered attempts when all providers fail transiently", async () => {
    const err1 = apiError(503, "boom1");
    const err2 = apiError(500, "boom2");
    const err3 = networkError("ETIMEDOUT");
    const p1 = mockProvider({ name: "p1", chat: vi.fn().mockRejectedValue(err1) });
    const p2 = mockProvider({ name: "p2", chat: vi.fn().mockRejectedValue(err2) });
    const p3 = mockProvider({ name: "p3", chat: vi.fn().mockRejectedValue(err3) });

    const fb = new FallbackLlmProvider([p1, p2, p3]);

    const caught = await fb.chat(chatParams).catch((e) => e);

    expect(caught).toBeInstanceOf(AllProvidersFailedError);
    expect((caught as AllProvidersFailedError).attempts).toEqual([
      { provider: "p1", error: err1 },
      { provider: "p2", error: err2 },
      { provider: "p3", error: err3 },
    ]);
  });

  it("treats a non-Error throw as permanent (no fallback)", async () => {
    const primary = mockProvider({
      name: "primary",
      chat: vi.fn().mockRejectedValue("string-throw"),
    });
    const secondary = mockProvider({
      name: "secondary",
      chat: vi.fn().mockResolvedValue(sampleResponse),
    });

    const fb = new FallbackLlmProvider([primary, secondary]);

    await expect(fb.chat(chatParams)).rejects.toBe("string-throw");
    expect(secondary.chat).not.toHaveBeenCalled();
  });

  it("passes the call options to the candidate", async () => {
    const primary = mockProvider({ chat: vi.fn().mockResolvedValue(sampleResponse) });
    const options = { signal: new AbortController().signal };

    await new FallbackLlmProvider([primary]).chat(chatParams, options);

    expect(primary.chat).toHaveBeenCalledWith(chatParams, options);
  });

  it("propagates a failure after the signal fires without trying the secondary", async () => {
    const aborted = userAbortError();
    const primary = mockProvider({ name: "primary", chat: vi.fn().mockRejectedValue(aborted) });
    const secondary = mockProvider({
      name: "secondary",
      chat: vi.fn().mockResolvedValue(sampleResponse),
    });

    const fb = new FallbackLlmProvider([primary, secondary]);

    await expect(fb.chat(chatParams, { signal: AbortSignal.abort() })).rejects.toBe(aborted);
    expect(secondary.chat).not.toHaveBeenCalled();
  });
});

// --- countTokens() ---

describe("FallbackLlmProvider.countTokens", () => {
  it("falls back on transient error for countTokens too", async () => {
    const primary = mockProvider({
      name: "primary",
      countTokens: vi.fn().mockRejectedValue(apiError(503)),
    });
    const secondary = mockProvider({
      name: "secondary",
      countTokens: vi.fn().mockResolvedValue(42),
    });

    const fb = new FallbackLlmProvider([primary, secondary]);
    expect(await fb.countTokens({ model: "m", system: "s", messages: [] })).toBe(42);
  });
});

// --- chatStream() ---

describe("FallbackLlmProvider.chatStream", () => {
  async function collect(frames: AsyncIterable<ChatStreamFrame>): Promise<ChatStreamFrame[]> {
    const out: ChatStreamFrame[] = [];
    for await (const frame of frames) out.push(frame);
    return out;
  }

  it("yields the primary's frames when the primary succeeds", async () => {
    const primary = mockProvider({
      name: "primary",
      chatStream: vi.fn().mockReturnValue(streamOf([{ type: "text_delta", text: "from-primary" }])),
    });
    const secondaryStream = vi.fn();
    const secondary = mockProvider({ name: "secondary", chatStream: secondaryStream });
    const options = { signal: new AbortController().signal };

    const fb = new FallbackLlmProvider([primary, secondary]);

    expect(await collect(fb.chatStream(chatParams, options))).toEqual([
      { type: "text_delta", text: "from-primary" },
      DONE,
    ]);
    expect(primary.chatStream).toHaveBeenCalledWith(chatParams, options);
    expect(secondaryStream).not.toHaveBeenCalled();
  });

  it("falls back on pre-stream failure and the consumer sees the secondary's frames", async () => {
    const primary = mockProvider({
      name: "primary",
      chatStream: vi.fn().mockReturnValue(streamFailsBeforeFirstFrame(apiError(503))),
    });
    const secondary = mockProvider({
      name: "secondary",
      chatStream: vi
        .fn()
        .mockReturnValue(streamOf([{ type: "text_delta", text: "from-secondary" }])),
    });

    const fb = new FallbackLlmProvider([primary, secondary]);

    expect(await collect(fb.chatStream(chatParams))).toEqual([
      { type: "text_delta", text: "from-secondary" },
      DONE,
    ]);
    expect(primary.chatStream).toHaveBeenCalledOnce();
    expect(secondary.chatStream).toHaveBeenCalledOnce();
  });

  it("does NOT fall back on a pre-stream permanent error — propagates to consumer", async () => {
    const primary = mockProvider({
      name: "primary",
      chatStream: vi.fn().mockReturnValue(streamFailsBeforeFirstFrame(apiError(401))),
    });
    const secondary = mockProvider({
      name: "secondary",
      chatStream: vi.fn().mockReturnValue(streamOf([{ type: "text_delta", text: "unused" }])),
    });

    const fb = new FallbackLlmProvider([primary, secondary]);

    await expect(collect(fb.chatStream(chatParams))).rejects.toMatchObject({ status: 401 });
    expect(secondary.chatStream).not.toHaveBeenCalled();
  });

  it("propagates mid-stream failure without falling back", async () => {
    const midErr = apiError(500, "mid-stream");
    const primary = mockProvider({
      name: "primary",
      chatStream: vi.fn().mockReturnValue(streamFailsMidStream(midErr)),
    });
    const secondary = mockProvider({
      name: "secondary",
      chatStream: vi
        .fn()
        .mockReturnValue(streamOf([{ type: "text_delta", text: "from-secondary" }])),
    });

    const fb = new FallbackLlmProvider([primary, secondary]);

    const iter = fb.chatStream(chatParams)[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value).toEqual({ type: "text_delta", text: "partial" });
    // The consumer has seen output, so fallback is no longer an option.
    await expect(iter.next()).rejects.toBe(midErr);
    expect(secondary.chatStream).not.toHaveBeenCalled();
  });

  it("throws AllProvidersFailedError when every candidate fails pre-stream transiently", async () => {
    const e1 = apiError(503);
    const e2 = networkError();
    const p1 = mockProvider({
      name: "p1",
      chatStream: vi.fn().mockReturnValue(streamFailsBeforeFirstFrame(e1)),
    });
    const p2 = mockProvider({
      name: "p2",
      chatStream: vi.fn().mockReturnValue(streamFailsBeforeFirstFrame(e2)),
    });

    const fb = new FallbackLlmProvider([p1, p2]);

    const caught: unknown = await collect(fb.chatStream(chatParams)).catch((e) => e);
    expect(caught).toBeInstanceOf(AllProvidersFailedError);
    expect((caught as AllProvidersFailedError).attempts.map((a) => a.provider)).toEqual([
      "p1",
      "p2",
    ]);
  });

  it("propagates a pre-stream failure after the signal fires without trying the secondary", async () => {
    const aborted = userAbortError();
    const primary = mockProvider({
      name: "primary",
      chatStream: vi.fn().mockReturnValue(streamFailsBeforeFirstFrame(aborted)),
    });
    const secondary = mockProvider({
      name: "secondary",
      chatStream: vi.fn().mockReturnValue(streamOf([{ type: "text_delta", text: "unused" }])),
    });

    const fb = new FallbackLlmProvider([primary, secondary]);

    await expect(collect(fb.chatStream(chatParams, { signal: AbortSignal.abort() }))).rejects.toBe(
      aborted,
    );
    expect(secondary.chatStream).not.toHaveBeenCalled();
  });

  it("returns the candidate's stream when the consumer stops early", async () => {
    const cleanup = vi.fn();
    const primary = mockProvider({
      name: "primary",
      chatStream: vi.fn().mockReturnValue(streamWithCleanup(cleanup)),
    });

    for await (const _ of new FallbackLlmProvider([primary]).chatStream(chatParams)) break;

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("returns the candidate's stream when the consumer's loop body throws", async () => {
    // The agent loop's delivery push failing mid-stream.
    const cleanup = vi.fn();
    const primary = mockProvider({
      name: "primary",
      chatStream: vi.fn().mockReturnValue(streamWithCleanup(cleanup)),
    });
    const pushFailed = new Error("push failed");

    await expect(
      (async () => {
        for await (const _ of new FallbackLlmProvider([primary]).chatStream(chatParams)) {
          throw pushFailed;
        }
      })(),
    ).rejects.toBe(pushFailed);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("exposes the underlying provider when the list contains a single entry", () => {
    const only: LlmProvider = mockProvider({ name: "anthropic" });
    const fb = new FallbackLlmProvider([only]);
    expect(fb.name).toBe("anthropic");
  });
});
