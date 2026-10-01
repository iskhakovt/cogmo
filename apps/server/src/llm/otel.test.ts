import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type OtelHarness, setupOtelHarness } from "../test/otel-harness.js";
import { failChatSpan, recordChatUsage, recordReasoningChars, startChatSpan } from "./otel.js";

describe("llm/otel", () => {
  let harness: OtelHarness;

  beforeAll(() => {
    harness = setupOtelHarness();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness.shutdown();
  });

  it("emits a chat span with gen_ai.* attributes", () => {
    const span = startChatSpan("anthropic", "claude-sonnet-4-6");
    recordChatUsage(
      span,
      "anthropic",
      "claude-sonnet-4-6",
      { inputTokens: 100, outputTokens: 50 },
      "end_turn",
    );
    span.end();

    const spans = harness.getSpans();
    expect(spans).toHaveLength(1);
    const attrs = spans[0]?.attributes ?? {};
    expect(attrs["gen_ai.operation.name"]).toBe("chat");
    expect(attrs["gen_ai.provider.name"]).toBe("anthropic");
    expect(attrs["gen_ai.request.model"]).toBe("claude-sonnet-4-6");
    expect(attrs["gen_ai.response.model"]).toBe("claude-sonnet-4-6");
    expect(attrs["gen_ai.response.finish_reasons"]).toEqual(["end_turn"]);
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(100);
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(50);
  });

  it("includes cache token attrs when present", () => {
    const span = startChatSpan("anthropic", "claude-sonnet-4-6");
    recordChatUsage(
      span,
      "anthropic",
      "claude-sonnet-4-6",
      {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 200,
        cacheCreationTokens: 300,
      },
      "end_turn",
    );
    span.end();

    const attrs = harness.getSpans()[0]?.attributes ?? {};
    expect(attrs["gen_ai.usage.cache_read.input_tokens"]).toBe(200);
    expect(attrs["gen_ai.usage.cache_creation.input_tokens"]).toBe(300);
  });

  it("records reasoning tokens as a span attribute when the provider reports them", () => {
    const span = startChatSpan("custom", "qwen-3-6-plus");
    recordChatUsage(
      span,
      "custom",
      "qwen-3-6-plus",
      { inputTokens: 100, outputTokens: 900, reasoningTokens: 850 },
      "end_turn",
    );
    span.end();

    const attrs = harness.getSpans()[0]?.attributes ?? {};
    expect(attrs["gen_ai.usage.reasoning.output_tokens"]).toBe(850);
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(900);
  });

  it("leaves the reasoning attribute off when the provider doesn't report it", () => {
    const span = startChatSpan("anthropic", "claude-sonnet-4-6");
    recordChatUsage(
      span,
      "anthropic",
      "claude-sonnet-4-6",
      { inputTokens: 1, outputTokens: 1 },
      "end_turn",
    );
    span.end();

    expect(harness.getSpans()[0]?.attributes).not.toHaveProperty(
      "gen_ai.usage.reasoning.output_tokens",
    );
  });

  it("records reasoning characters only when there were some", () => {
    const thought = startChatSpan("custom", "qwen-3-6-plus");
    recordReasoningChars(thought, 7_400);
    thought.end();
    const silent = startChatSpan("custom", "qwen-3-6-plus");
    recordReasoningChars(silent, 0);
    silent.end();

    const [first, second] = harness.getSpans();
    expect(first?.attributes["cogmo.llm.reasoning_chars"]).toBe(7_400);
    expect(second?.attributes).not.toHaveProperty("cogmo.llm.reasoning_chars");
  });

  it("counts reasoning tokens within output, adding no token type of their own", async () => {
    const span = startChatSpan("custom", "qwen-3-6-plus");
    recordChatUsage(
      span,
      "custom",
      "qwen-3-6-plus",
      { inputTokens: 100, outputTokens: 900, reasoningTokens: 850 },
      "end_turn",
    );
    span.end();

    const byType = await tokensByType();
    expect(byType.get("output")).toBe(900);
    expect([...byType.keys()].sort()).toEqual(["input", "output"]);
  });

  /** The `cogmo.llm.tokens` data points since the last reset. Collecting drains them. */
  async function collectTokenPoints() {
    const result = await harness.collectMetrics();
    const tokenMetric = result.scopeMetrics
      .flatMap((s) => s.metrics)
      .find((m) => m.descriptor.name === "cogmo.llm.tokens");
    expect(tokenMetric).toBeDefined();
    return tokenMetric?.dataPoints ?? [];
  }

  async function tokensByType() {
    const points = await collectTokenPoints();
    return new Map(points.map((p) => [String(p.attributes.type), p.value]));
  }

  it("increments token counters labeled by type, model, provider", async () => {
    const span = startChatSpan("openrouter", "anthropic/claude-sonnet-4");
    recordChatUsage(
      span,
      "openrouter",
      "anthropic/claude-sonnet-4",
      {
        inputTokens: 2000,
        outputTokens: 250,
        cacheReadTokens: 500,
        cacheCreationTokens: 750,
      },
      "end_turn",
    );
    span.end();

    const points = await collectTokenPoints();
    const byType = new Map(points.map((p) => [String(p.attributes.type), p.value]));
    expect(byType.get("input")).toBe(750);
    expect(byType.get("output")).toBe(250);
    expect(byType.get("cache_read")).toBe(500);
    expect(byType.get("cache_create")).toBe(750);

    const inputPoint = points.find((p) => p.attributes.type === "input");
    expect(inputPoint?.attributes.model).toBe("anthropic/claude-sonnet-4");
    expect(inputPoint?.attributes.provider).toBe("openrouter");
  });

  // `Usage.inputTokens` is the whole prompt with cache reads and writes as
  // subsets. The span carries that total, per the GenAI conventions; the
  // counter's `input` type takes only the uncached remainder so the four
  // types stay disjoint and sum to what was billed.
  it("records the total on the span and the uncached remainder as the input counter", async () => {
    const span = startChatSpan("anthropic", "claude-sonnet-5");
    recordChatUsage(
      span,
      "anthropic",
      "claude-sonnet-5",
      { inputTokens: 7440, outputTokens: 9, cacheReadTokens: 7360, cacheCreationTokens: 68 },
      "end_turn",
    );
    span.end();

    expect(harness.getSpans()[0]?.attributes["gen_ai.usage.input_tokens"]).toBe(7440);
    const byType = await tokensByType();
    expect(byType.get("input")).toBe(12);
    expect(byType.get("cache_read")).toBe(7360);
    expect(byType.get("cache_create")).toBe(68);
  });

  it("never records a negative input count when a provider reports more cached tokens than prompt", async () => {
    const span = startChatSpan("custom", "some-model");
    recordChatUsage(
      span,
      "custom",
      "some-model",
      { inputTokens: 100, outputTokens: 1, cacheReadTokens: 150 },
      "end_turn",
    );
    span.end();

    const byType = await tokensByType();
    expect(byType.get("input")).toBe(0);
    expect(byType.get("cache_read")).toBe(150);
  });

  it("marks the span as ERROR when failChatSpan is called", () => {
    const span = startChatSpan("anthropic", "claude-sonnet-4-6");
    failChatSpan(span, new Error("rate limited"));
    span.end();

    const finished = harness.getSpans()[0];
    expect(finished?.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(finished?.events).toHaveLength(1);
    expect(finished?.events[0]?.name).toBe("exception");
  });
});
