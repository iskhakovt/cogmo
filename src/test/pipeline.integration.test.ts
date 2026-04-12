/// <reference path="../../test/vitest.d.ts" />

import { eq } from "drizzle-orm";
import { connect } from "inngest/connect";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { conversations, messages, profiles } from "../agent/store/schema.js";
import { db } from "../db/index.js";
import { bootstrap } from "../index.js";
import { channelSessions, channels, inboundMessages } from "../transport/store/schema.js";

let inngestBaseUrl: string;
let connection: Awaited<ReturnType<typeof connect>>;

beforeAll(async () => {
  inngestBaseUrl = inject("inngestBaseUrl");

  // Wire app in-process and register Inngest functions via connect mode (WebSocket).
  // Connect mode self-registers with the Inngest dev server — no discovery needed.
  // providerOverride: tests use llmock fixtures, not a real LLM provider from DB.
  const { AnthropicProvider } = await import("../llm/anthropic.js");
  const provider = new AnthropicProvider(process.env.ANTHROPIC_API_KEY ?? "test-key");
  const { inngest, functions } = await bootstrap({ providerOverride: provider });
  connection = await connect({
    apps: [{ client: inngest, functions }],
  });
});

afterAll(async () => {
  if (connection) await connection.close();
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
});
