/// <reference path="../../test/vitest.d.ts" />

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sql as drizzleSql, eq } from "drizzle-orm";
import { connect } from "inngest/connect";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { conversations, messages, profiles, voiceConfig } from "../agent/store/schema.js";
import { db, transactor } from "../db/index.js";
import { bootstrap } from "../index.js";
import { directOutbound } from "../inngest/events.js";
import { deriveMasterKey, parseMasterKey } from "../secrets/encryption.js";
import { DrizzleSecretsStore } from "../secrets/store/index.js";
import { createAttachmentStore } from "../transport/attachment-store.js";
import { channelSessions, channels, inboundMessages } from "../transport/store/schema.js";
import { OpenAIVoiceProvider } from "../voice/openai.js";
import { createFalFetch } from "./fal-mock.js";
import { createOpenAIVoiceFetch } from "./openai-voice-mock.js";
import { type OtelHarness, setupOtelHarness } from "./otel-harness.js";

let inngestBaseUrl: string;
let connection: Awaited<ReturnType<typeof connect>>;
let otel: OtelHarness;

const VOICE_FIXTURE_DIR = "./test/fixtures/voice";
const INBOUND_OGG_PATH = join(VOICE_FIXTURE_DIR, "inbound.ogg");
const INBOUND_PHRASE = "Hello, this is the voice integration test.";

interface CapturedOutbound {
  platformAddress: string;
  content: string;
  images?: Array<{ data: string; mediaType: string }> | undefined;
  voice?: { data: string; mediaType: string } | undefined;
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

  // Same shape for OpenAI voice (`/v1/audio/speech` and
  // `/v1/audio/transcriptions`) — wired through `OpenAIVoiceConfig.fetch`
  // by bootstrap when `voiceFetchOverride` is passed.
  const voiceFetchOverride = createOpenAIVoiceFetch({
    mode: process.env.RECORD === "1" ? "record" : "replay",
    fixturePath: VOICE_FIXTURE_DIR,
  });

  // Seed `voice_config` BEFORE bootstrap — bootstrap reads voice_config
  // exactly once at boot to construct the OpenAIVoiceProvider. Inserting
  // afterwards has no effect on the running pipeline.
  await seedVoiceConfig();

  const { inngest, functions } = await bootstrap({
    providerOverride: provider,
    falFetchOverride,
    voiceFetchOverride,
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

/**
 * Seed a single `voice_config` row + matching `secrets` entry so bootstrap
 * wires the OpenAIVoiceProvider. The OpenAI key is "test-openai-key" in
 * replay (the interceptor never touches the network); record mode requires
 * a real key in `OPENAI_API_KEY` and the interceptor forwards it.
 */
async function seedVoiceConfig() {
  if (!process.env.COGMO_MASTER_KEY) {
    throw new Error("COGMO_MASTER_KEY not set — integration setup must run first");
  }
  const masterKey = deriveMasterKey(
    parseMasterKey(process.env.COGMO_MASTER_KEY),
    "cogmo/secrets-at-rest/v1",
  );
  const secrets = new DrizzleSecretsStore(masterKey);
  const tx = transactor(db);
  const apiKey =
    process.env.RECORD === "1" ? (process.env.OPENAI_API_KEY ?? "") : "test-openai-key";
  if (process.env.RECORD === "1" && !apiKey) {
    throw new Error("RECORD=1 requires OPENAI_API_KEY to capture voice fixtures");
  }
  const { id: secretId } = await tx((trx) =>
    secrets.putSecret(trx, { name: "voice_openai_key", plaintext: apiKey }),
  );

  await db.execute(drizzleSql`DELETE FROM voice_config`);
  await db.insert(voiceConfig).values({
    ttsSecretId: secretId,
    sttSecretId: secretId,
    ttsProvider: "openai",
    ttsModel: "gpt-4o-mini-tts",
    ttsVoice: "alloy",
    sttProvider: "openai",
    sttModel: "gpt-4o-mini-transcribe",
  });
}

/**
 * Read the inbound voice fixture clip. Bootstrapped on first record run by
 * TTS-ing INBOUND_PHRASE directly against OpenAI (no interceptor) so we
 * don't end up with a duplicate `tts-{model}-{voice}-{sha256(INBOUND_PHRASE)}`
 * fixture sitting next to `inbound.ogg` with byte-identical content — the
 * pipeline never TTS's the inbound phrase, only the assistant's reply, so
 * no replay path needs the inbound-phrase TTS fixture.
 */
async function loadInboundOgg(): Promise<Buffer> {
  try {
    return await readFile(INBOUND_OGG_PATH);
  } catch {
    if (process.env.RECORD !== "1") {
      throw new Error(
        `Missing fixture ${INBOUND_OGG_PATH}. Run once with RECORD=1 LLMOCK_RECORD=1 OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-... pnpm test:integration to seed (voice + LLM fixtures are both required).`,
      );
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("RECORD=1 requires OPENAI_API_KEY");
    // Bypass the interceptor so the bootstrap call doesn't write a
    // tts-{model}-{voice}-{sha256(INBOUND_PHRASE)}.ogg fixture next to
    // inbound.ogg with identical bytes. Goes straight to OpenAI.
    const provider = new OpenAIVoiceProvider({ apiKey });
    const result = await provider.tts({
      text: INBOUND_PHRASE,
      voice: "alloy",
      model: "gpt-4o-mini-tts",
      format: "ogg",
    });
    await mkdir(dirname(INBOUND_OGG_PATH), { recursive: true });
    await writeFile(INBOUND_OGG_PATH, result.audio);
    return result.audio;
  }
}

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
    const channelRows = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.type, "direct"))
      .limit(1);
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

  it("voice round-trip: STT inbound → text → TTS outbound", async () => {
    const defaultUserId = inject("defaultUserId");

    const [profile] = await db.select({ id: profiles.id }).from(profiles).limit(1);
    const [channel] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.type, "direct"))
      .limit(1);
    if (!profile || !channel) throw new Error("seed incomplete");

    const platformAddress = `voice-test-${Date.now()}`;
    const [conv] = await db
      .insert(conversations)
      .values({
        userId: defaultUserId,
        profileId: profile.id,
        isPrivate: true,
        // Force voice on regardless of inbound modality detection — the
        // integration test asserts the full TTS path lands a voice payload
        // on directOutbound.
        voiceMode: "always",
      })
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

    // Inbound OGG bytes — fed into AttachmentStore so the orchestrator's
    // transcribe-voice step downloads + STT's them via the intercepted
    // OpenAI client.
    const inboundOgg = await loadInboundOgg();
    const { S3Client } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({
      ...(process.env.S3_ENDPOINT && { endpoint: process.env.S3_ENDPOINT }),
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? "minioadmin",
        secretAccessKey: process.env.S3_SECRET_KEY ?? "minioadmin",
      },
    });
    const attachments = createAttachmentStore(s3, process.env.S3_BUCKET ?? "cogmo-files");
    const path = await attachments.upload(inboundOgg, "audio/ogg", "inbound");
    s3.destroy();

    const [inbound] = await db
      .insert(inboundMessages)
      .values({
        channelSessionId: session!.id,
        conversationId: conv!.id,
        content: [{ type: "voice", path, mediaType: "audio/ogg" }],
        platformTs: new Date(),
      })
      .returning({ id: inboundMessages.id });

    await sendEvent("inbound/arrived", {
      conversationId: conv!.id,
      inboundMessageId: inbound!.id,
    });

    const timeoutMs = process.env.RECORD === "1" ? 60_000 : 30_000;
    const outbound = await waitForOutbound(
      conv!.id,
      (e) => e.platformAddress === platformAddress && !!e.voice,
      timeoutMs,
    );

    expect(outbound.voice).toBeDefined();
    expect(outbound.voice!.mediaType).toBe("audio/ogg");
    const audioBytes = Buffer.from(outbound.voice!.data, "base64");
    expect(audioBytes.length).toBeGreaterThan(0);
    // OGG container magic bytes — confirms the interceptor returned the
    // recorded audio fixture rather than e.g. a non-empty error body.
    expect(audioBytes.subarray(0, 4).toString("ascii")).toBe("OggS");

    // The stored user message should be the STT transcript text — voice
    // blocks are substituted to text before persist.
    const allMsgs = await db.select().from(messages).where(eq(messages.conversationId, conv!.id));
    const userMsg = allMsgs.find((r) => r.role === "user");
    expect(userMsg).toBeDefined();
    expect(typeof userMsg!.content).toBe("string");
    expect((userMsg!.content as string).length).toBeGreaterThan(0);
  });

  it("emits gen_ai chat spans + token metrics through the live pipeline", async () => {
    const defaultUserId = inject("defaultUserId");

    const [profile] = await db.select({ id: profiles.id }).from(profiles).limit(1);
    const [channel] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.type, "direct"))
      .limit(1);
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
    const types = new Set((tokenMetric?.dataPoints ?? []).map((p) => p.attributes.type));
    expect(types).toContain("input");
    expect(types).toContain("output");
    const inputPoint = tokenMetric?.dataPoints.find((p) => p.attributes.type === "input");
    expect(inputPoint?.attributes.provider).toBe("anthropic");

    const iterationsMetric = allMetrics.find((m) => m.descriptor.name === "cogmo.agent.iterations");
    expect(iterationsMetric).toBeDefined();
    expect(iterationsMetric?.dataPoints.length).toBeGreaterThanOrEqual(1);
  });
});
