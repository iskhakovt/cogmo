import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type OtelHarness, setupOtelHarness } from "../test/otel-harness.js";
import { failChatSpan, recordChatUsage, startChatSpan } from "./otel.js";

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

  it("increments token counters labeled by type, model, provider", async () => {
    const span = startChatSpan("openrouter", "anthropic/claude-sonnet-4");
    recordChatUsage(
      span,
      "openrouter",
      "anthropic/claude-sonnet-4",
      {
        inputTokens: 1000,
        outputTokens: 250,
        cacheReadTokens: 500,
        cacheCreationTokens: 750,
      },
      "end_turn",
    );
    span.end();

    const result = await harness.collectMetrics();
    const tokenMetric = result.scopeMetrics
      .flatMap((s) => s.metrics)
      .find((m) => m.descriptor.name === "cogmo.llm.tokens");
    expect(tokenMetric).toBeDefined();
    const points = tokenMetric?.dataPoints ?? [];
    const byType = new Map<string, number>();
    for (const p of points) {
      const type = String(p.attributes.type);
      byType.set(type, p.value as number);
    }
    expect(byType.get("input")).toBe(1000);
    expect(byType.get("output")).toBe(250);
    expect(byType.get("cache_read")).toBe(500);
    expect(byType.get("cache_create")).toBe(750);

    const inputPoint = points.find((p) => p.attributes.type === "input");
    expect(inputPoint?.attributes.model).toBe("anthropic/claude-sonnet-4");
    expect(inputPoint?.attributes.provider).toBe("openrouter");
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
