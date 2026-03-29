/// <reference path="../../test/vitest.d.ts" />
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { conversations, messages, profiles, users } from "../agent/store/schema.js";
import { channelSessions, channels, inboundMessages } from "../transport/store/schema.js";

let db: ReturnType<typeof drizzle>;
let inngestBaseUrl: string;

beforeAll(() => {
  const databaseUrl = inject("databaseUrl");
  inngestBaseUrl = inject("inngestBaseUrl");
  db = drizzle({ connection: databaseUrl });
});

afterAll(async () => {
  await db.$client.end();
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

async function waitForAssistantMessage(timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await db.select().from(messages);
    const match = rows.find((r) => r.role === "assistant");
    if (match) return match;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Timed out waiting for assistant message");
}

describe("message pipeline", () => {
  it("processes inbound/arrived end-to-end", async () => {
    // The app's ensureDefaults creates a user, profile, CLI channel, and wildcard identity.
    // We need to create a conversation + session + inbound message, then emit the event.
    const defaultUserId = inject("defaultUserId");

    // Find the default profile and CLI channel (created by ensureDefaults)
    const profileRows = await db.select({ id: profiles.id }).from(profiles).limit(1);
    const channelRows = await db.select({ id: channels.id }).from(channels).limit(1);
    expect(profileRows.length).toBe(1);
    expect(channelRows.length).toBeGreaterThanOrEqual(1);

    const profileId = profileRows[0]!.id;
    const channelId = channelRows[0]!.id;

    // Create conversation
    const [conv] = await db
      .insert(conversations)
      .values({ userId: defaultUserId, profileId, isPrivate: true })
      .returning({ id: conversations.id });

    // Create session
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

    // Persist inbound message
    const [inbound] = await db
      .insert(inboundMessages)
      .values({
        channelSessionId: session!.id,
        conversationId: conv!.id,
        content: "Hello integration test",
        platformTs: new Date(),
      })
      .returning({ id: inboundMessages.id });

    // Emit inbound/arrived — this is what the adapter does
    await sendEvent("inbound/arrived", {
      conversationId: conv!.id,
      inboundMessageId: inbound!.id,
    });

    // Wait for assistant response
    const assistantMsg = await waitForAssistantMessage();
    expect(assistantMsg.content).toBeDefined();

    // Verify user message was created
    const allMsgs = await db.select().from(messages);
    const userMsg = allMsgs.find((r) => r.role === "user");
    expect(userMsg).toBeDefined();
  });
});

describe("migrations", () => {
  it("all tables exist with correct structure", async () => {
    // Query each table — if schema is wrong, this throws
    expect(await db.select().from(users).limit(0)).toEqual([]);
    expect(await db.select().from(profiles).limit(0)).toEqual([]);
    expect(await db.select().from(conversations).limit(0)).toEqual([]);
    expect(await db.select().from(messages).limit(0)).toEqual([]);
    expect(await db.select().from(channels).limit(0)).toEqual([]);
    expect(await db.select().from(channelSessions).limit(0)).toEqual([]);
    expect(await db.select().from(inboundMessages).limit(0)).toEqual([]);
  });
});
