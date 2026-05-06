/// <reference path="../../test/vitest.d.ts" />

import { eq } from "drizzle-orm";
import { connect } from "inngest/connect";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { conversations, messages, profiles } from "../agent/store/schema.js";
import { db } from "../db/index.js";
import { bootstrap } from "../index.js";
import { directOutbound } from "../inngest/events.js";
import { channelSessions, channels, inboundMessages } from "../transport/store/schema.js";
import { createFalFetch } from "./fal-mock.js";
import { type OtelHarness, setupOtelHarness } from "./otel-harness.js";

let inngestBaseUrl: string;
let connection: Awaited<ReturnType<typeof connect>>;
let otel: OtelHarness;

interface CapturedOutbound {
  platformAddress: string;
  content: string;
  images?: Array<{ data: string; mediaType: string }>;
}
// File-scoped capture buffer for `adapter/direct/outbound` events. A dedicated
// Inngest function (registered alongside the app's functions) pushes each
// event here, letting tests assert on delivery without polling the dev server.
const capturedOutbound: CapturedOutbound[] = [];

beforeAll(async () => {
  inngestBaseUrl = inject("inngestBaseUrl");

  // Set up the OTel harness BEFORE bootstrap so the global tracer/meter
  // providers exist by the time domain modules first call startSpan/record.
  // ProxyTracer caches its delegate on first use, so this ordering matters.
  otel = setupOtelHarness();

  // Wire app in-process and register Inngest functions via connect mode (WebSocket).
  // Connect mode self-registers with the Inngest dev server — no discovery needed.
  // providerOverride: tests use llmock fixtures, not a real LLM provider from DB.
  // In LLMOCK_RECORD=1, llmock proxies to real Anthropic and forwards the
  // Authorization header as-is — pass the real key when recording.
  const { AnthropicProvider } = await import("../llm/anthropic.js");
  const anthropicKey =
    process.env.LLMOCK_RECORD === "1" ? (process.env.ANTHROPIC_API_KEY ?? "test-key") : "test-key";
  const provider = new AnthropicProvider(anthropicKey, inject("llmockBaseUrl"));

  // Scoped fetch wrapper for fal.ai traffic — intercepts fal endpoints only,
  // delegates everything else to global fetch. Passed to the fal provider
  // via `createFal({ fetch })` so Anthropic/S3/etc. calls are untouched.
  const falFetchOverride = createFalFetch({
    mode: process.env.RECORD === "1" ? "record" : "replay",
    fixturePath: "./test/fixtures/fal",
  });

  const { inngest, functions } = await bootstrap({
    providerOverride: provider,
    falFetchOverride,
  });

  // Capture directOutbound events for test assertions — same pattern the
  // app uses, just consumed by the test harness instead of a console client.
  const captureOutbound = inngest.createFunction(
    { id: "test-capture-outbound", triggers: [directOutbound] },
    async ({ event }) => {
      capturedOutbound.push(event.data);
      return { captured: true };
    },
  );

  connection = await connect({
    apps: [{ client: inngest, functions: [...functions, captureOutbound] }],
  });
});

afterAll(async () => {
  if (connection) await connection.close();
  if (otel) await otel.shutdown();
});

// Reset the outbound capture buffer between tests so events from a previous
// test can't leak into a later test's `waitForOutbound` search.
beforeEach(async () => {
  capturedOutbound.length = 0;
  await otel.reset();
});

async function sendEvent(name: string, data: Record<string, unknown>) {
  const eventKey = inject("inngestEventKey");
  const res = await fetch(`${inngestBaseUrl}/e/${eventKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data }),
  });
  if (!res.ok) {
    throw new Error(`Failed to send event: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function waitForAssistantMessage(conversationId: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    const match = rows.find((r) => r.role === "assistant");
    if (match) return match;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Timed out waiting for assistant message");
}

/**
 * Poll the captured directOutbound buffer for an event matching `predicate`.
 *
 * `conversationId` is used only to label the timeout error message — correlation
 * against the actual event is done by the caller via `predicate` (typically
 * matching on the `platformAddress` we set per-test to disambiguate runs).
 */
async function waitForOutbound(
  conversationId: string,
  predicate: (e: CapturedOutbound) => boolean,
  timeoutMs = 30_000,
): Promise<CapturedOutbound> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const match = capturedOutbound.find(predicate);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for directOutbound for conversation ${conversationId}`);
}

describe("message pipeline", () => {
  it("processes inbound/arrived end-to-end", async () => {
    const defaultUserId = inject("defaultUserId");

    const profileRows = await db.select({ id: profiles.id }).from(profiles).limit(1);
    const channelRows = await db.select({ id: channels.id }).from(channels).limit(1);
    expect(profileRows.length).toBe(1);
    expect(channelRows.length).toBeGreaterThanOrEqual(1);

    const profileId = profileRows[0]!.id;
    const channelId = channelRows[0]!.id;

    const [conv] = await db
      .insert(conversations)
      .values({ userId: defaultUserId, profileId, isPrivate: true })
      .returning({ id: conversations.id });

    const [session] = await db
      .insert(channelSessions)
      .values({
        channelId,
        platformAddress: `test-${Date.now()}`,
        conversationId: conv!.id,
        status: "active",
        receive: "routed",
      })
      .returning({ id: channelSessions.id });

    const [inbound] = await db
      .insert(inboundMessages)
      .values({
        channelSessionId: session!.id,
        conversationId: conv!.id,
        content: "Hello integration test",
        platformTs: new Date(),
      })
      .returning({ id: inboundMessages.id });

    await sendEvent("inbound/arrived", {
      conversationId: conv!.id,
      inboundMessageId: inbound!.id,
    });

    const assistantMsg = await waitForAssistantMessage(conv!.id);
    expect(assistantMsg.content).toBeDefined();

    const allMsgs = await db.select().from(messages).where(eq(messages.conversationId, conv!.id));
    const userMsg = allMsgs.find((r) => r.role === "user");
    expect(userMsg).toBeDefined();
  });

  it("generates and delivers image end-to-end", async () => {
    const defaultUserId = inject("defaultUserId");

    const [profile] = await db.select({ id: profiles.id }).from(profiles).limit(1);
    // Direct is the batch channel we test against — Telegram's streaming
    // path is exercised in the unit tests (grammy mocks).
    const [channel] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.type, "direct"))
      .limit(1);
    if (!profile || !channel) throw new Error("seed incomplete");

    const platformAddress = `img-test-${Date.now()}`;
    const [conv] = await db
      .insert(conversations)
      .values({ userId: defaultUserId, profileId: profile.id, isPrivate: true })
      .returning({ id: conversations.id });

    const [session] = await db
      .insert(channelSessions)
      .values({
        channelId: channel.id,
        platformAddress,
        conversationId: conv!.id,
        status: "active",
        receive: "routed",
      })
      .returning({ id: channelSessions.id });

    // User prompt must match the llmock fixture trigger. Record mode
    // (LLMOCK_RECORD=1) captures the LLM round trip; replay uses the saved
    // tool_use { name: "generate_image" } response.
    const [inbound] = await db
      .insert(inboundMessages)
      .values({
        channelSessionId: session!.id,
        conversationId: conv!.id,
        content: "draw me a cat in a hat",
        platformTs: new Date(),
      })
      .returning({ id: inboundMessages.id });

    await sendEvent("inbound/arrived", {
      conversationId: conv!.id,
      inboundMessageId: inbound!.id,
    });

    // Response delivered via Direct adapter's batch path — directOutbound
    // event carries base64 image bytes alongside text.
    // Record mode needs more time than replay — real fal call (~3s) + image
    // download (~1s) + two Anthropic round trips. Replay is ~2s total.
    const timeoutMs = process.env.RECORD === "1" ? 60_000 : 30_000;
    const outbound = await waitForOutbound(
      conv!.id,
      (e) => e.platformAddress === platformAddress && !!e.images?.length,
      timeoutMs,
    );

    expect(outbound.content).toBeTruthy();
    expect(outbound.images).toHaveLength(1);
    const img = outbound.images![0]!;
    expect(img.mediaType).toMatch(/^image\//);
    const bytes = Buffer.from(img.data, "base64");
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("emits gen_ai chat spans + token metrics through the live pipeline", async () => {
    const defaultUserId = inject("defaultUserId");

    const [profile] = await db.select({ id: profiles.id }).from(profiles).limit(1);
    const [channel] = await db.select({ id: channels.id }).from(channels).limit(1);
    if (!profile || !channel) throw new Error("seed incomplete");

    const [conv] = await db
      .insert(conversations)
      .values({ userId: defaultUserId, profileId: profile.id, isPrivate: true })
      .returning({ id: conversations.id });

    const [session] = await db
      .insert(channelSessions)
      .values({
        channelId: channel.id,
        platformAddress: `otel-test-${Date.now()}`,
        conversationId: conv!.id,
        status: "active",
        receive: "routed",
      })
      .returning({ id: channelSessions.id });

    const [inbound] = await db
      .insert(inboundMessages)
      .values({
        channelSessionId: session!.id,
        conversationId: conv!.id,
        content: "Hello integration test",
        platformTs: new Date(),
      })
      .returning({ id: inboundMessages.id });

    await sendEvent("inbound/arrived", {
      conversationId: conv!.id,
      inboundMessageId: inbound!.id,
    });

    await waitForAssistantMessage(conv!.id);

    // Spans land via SimpleSpanProcessor; small grace for any in-flight ends.
    await new Promise((r) => setTimeout(r, 200));

    const spans = otel.getSpans();
    // `inngest.execution` is opened by Inngest's engine unconditionally via
    // the global tracer; it's the per-function-run span our domain spans
    // parent under. Verifying it appears confirms the engine integration.
    expect(spans.some((s) => s.name === "inngest.execution")).toBe(true);
    const chatSpans = spans.filter((s) => s.name === "chat");
    expect(chatSpans.length).toBeGreaterThanOrEqual(1);
    const first = chatSpans[0]!;
    expect(first.attributes["gen_ai.operation.name"]).toBe("chat");
    expect(first.attributes["gen_ai.provider.name"]).toBe("anthropic");
    expect(typeof first.attributes["gen_ai.request.model"]).toBe("string");
    expect(typeof first.attributes["gen_ai.usage.input_tokens"]).toBe("number");
    expect(typeof first.attributes["gen_ai.usage.output_tokens"]).toBe("number");

    // Token counter receives input/output data points labeled by model+provider.
    // We assert on shape rather than magnitude — llmock fixture replay returns
    // usage `{0, 0}`, so values land at zero. The contract we care about is
    // "tokens are being recorded with proper labels"; re-record fixtures to
    // verify magnitudes.
    const result = await otel.collectMetrics();
    const allMetrics = result.scopeMetrics.flatMap((s) => s.metrics);
    const tokenMetric = allMetrics.find((m) => m.descriptor.name === "cogmo.llm.tokens");
    expect(tokenMetric).toBeDefined();
    const types = new Set((tokenMetric?.dataPoints ?? []).map((p) => p.attributes["type"]));
    expect(types).toContain("input");
    expect(types).toContain("output");
    const inputPoint = tokenMetric?.dataPoints.find((p) => p.attributes["type"] === "input");
    expect(inputPoint?.attributes["provider"]).toBe("anthropic");

    const iterationsMetric = allMetrics.find((m) => m.descriptor.name === "cogmo.agent.iterations");
    expect(iterationsMetric).toBeDefined();
    expect(iterationsMetric?.dataPoints.length).toBeGreaterThanOrEqual(1);
  });
});
