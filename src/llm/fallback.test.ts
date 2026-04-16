import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockProvider } from "../test/factories.js";
import {
  AllProvidersFailedError,
  FallbackLlmProvider,
  isRetriableProviderError,
} from "./fallback.js";
import type { LlmProvider } from "./provider.js";
import type { ChatParams, ChatStreamResult, LlmResponse, StreamEvent } from "./types.js";

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

/** Build a ChatStreamResult from a list of events. Success path. */
function streamOf(events: StreamEvent[]): ChatStreamResult {
  async function* gen(): AsyncIterable<StreamEvent> {
    for (const e of events) yield e;
  }
  return {
    events: gen(),
    response: Promise.resolve({
      stopReason: "end_turn",
      model: "mock-model",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  };
}

/** Attach a no-op catch to a rejected promise so it is not flagged as unhandled. */
function handled<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

/**
 * Build a ChatStreamResult that throws on first `events.next()` — simulates
 * the SDK failing while establishing the stream (pre-stream failure).
 */
function streamFailsBeforeFirstEvent(err: unknown): ChatStreamResult {
  async function* gen(): AsyncIterable<StreamEvent> {
    throw err;
    // biome-ignore lint/correctness/noUnreachable: needed to give the generator a yield type
    yield { type: "text_delta", text: "" };
  }
  return {
    events: gen(),
    response: handled(Promise.reject(err)),
  };
}

/**
 * Build a ChatStreamResult that yields one event then throws — simulates a
 * mid-stream failure after we've already handed bytes to the consumer.
 */
function streamFailsMidStream(err: unknown): ChatStreamResult {
  async function* gen(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", text: "partial" };
    throw err;
  }
  return {
    events: gen(),
    response: handled(Promise.reject(err)),
  };
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
  async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
    const out: StreamEvent[] = [];
    for await (const e of events) out.push(e);
    return out;
  }

  it("yields primary's events when primary succeeds", async () => {
    const primary = mockProvider({
      name: "primary",
      chatStream: vi.fn().mockReturnValue(streamOf([{ type: "text_delta", text: "from-primary" }])),
    });
    const secondaryStream = vi.fn();
    const secondary = mockProvider({ name: "secondary", chatStream: secondaryStream });

    const fb = new FallbackLlmProvider([primary, secondary]);
    const handle = fb.chatStream(chatParams);

    const events = await collect(handle.events);
    expect(events).toEqual([{ type: "text_delta", text: "from-primary" }]);
    expect(secondaryStream).not.toHaveBeenCalled();
    await expect(handle.response).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  it("falls back on pre-stream failure and the consumer sees the secondary's events", async () => {
    const primary = mockProvider({
      name: "primary",
      chatStream: vi.fn().mockReturnValue(streamFailsBeforeFirstEvent(apiError(503))),
    });
    const secondary = mockProvider({
      name: "secondary",
      chatStream: vi
        .fn()
        .mockReturnValue(streamOf([{ type: "text_delta", text: "from-secondary" }])),
    });

    const fb = new FallbackLlmProvider([primary, secondary]);
    const handle = fb.chatStream(chatParams);

    const events = await collect(handle.events);
    expect(events).toEqual([{ type: "text_delta", text: "from-secondary" }]);
    expect(primary.chatStream).toHaveBeenCalledOnce();
    expect(secondary.chatStream).toHaveBeenCalledOnce();
    await expect(handle.response).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  it("does NOT fall back on a pre-stream permanent error — propagates to consumer", async () => {
    const primary = mockProvider({
      name: "primary",
      chatStream: vi.fn().mockReturnValue(streamFailsBeforeFirstEvent(apiError(401))),
    });
    const secondary = mockProvider({
      name: "secondary",
      chatStream: vi.fn().mockReturnValue(streamOf([{ type: "text_delta", text: "unused" }])),
    });

    const fb = new FallbackLlmProvider([primary, secondary]);
    const handle = fb.chatStream(chatParams);

    await expect(collect(handle.events)).rejects.toMatchObject({ status: 401 });
    await expect(handle.response).rejects.toMatchObject({ status: 401 });
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
    const handle = fb.chatStream(chatParams);

    const iter = handle.events[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value).toEqual({ type: "text_delta", text: "partial" });
    // Next pull re-raises the mid-stream error — consumer has already seen
    // bytes, so fallback is no longer an option.
    await expect(iter.next()).rejects.toBe(midErr);
    // Response also rejects with the same mid-stream error.
    await expect(handle.response).rejects.toBe(midErr);
    expect(secondary.chatStream).not.toHaveBeenCalled();
  });

  it("throws AllProvidersFailedError when every candidate fails pre-stream transiently", async () => {
    const e1 = apiError(503);
    const e2 = networkError();
    const p1 = mockProvider({
      name: "p1",
      chatStream: vi.fn().mockReturnValue(streamFailsBeforeFirstEvent(e1)),
    });
    const p2 = mockProvider({
      name: "p2",
      chatStream: vi.fn().mockReturnValue(streamFailsBeforeFirstEvent(e2)),
    });

    const fb = new FallbackLlmProvider([p1, p2]);
    const handle = fb.chatStream(chatParams);

    const caught: unknown = await collect(handle.events).catch((e) => e);
    expect(caught).toBeInstanceOf(AllProvidersFailedError);
    expect((caught as AllProvidersFailedError).attempts.map((a) => a.provider)).toEqual([
      "p1",
      "p2",
    ]);
    await expect(handle.response).rejects.toBeInstanceOf(AllProvidersFailedError);
  });

  it("exposes the underlying provider when the list contains a single entry", () => {
    const only: LlmProvider = mockProvider({ name: "anthropic" });
    const fb = new FallbackLlmProvider([only]);
    expect(fb.name).toBe("anthropic");
  });
});
