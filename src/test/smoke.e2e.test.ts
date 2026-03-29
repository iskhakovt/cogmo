/// <reference path="../../test/vitest.d.ts" />
import { drizzle } from "drizzle-orm/postgres-js";
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

describe("e2e smoke", () => {
  it("migrations applied — all tables queryable", async () => {
    expect(await db.select().from(users).limit(0)).toEqual([]);
    expect(await db.select().from(profiles).limit(0)).toEqual([]);
    expect(await db.select().from(conversations).limit(0)).toEqual([]);
    expect(await db.select().from(messages).limit(0)).toEqual([]);
    expect(await db.select().from(channels).limit(0)).toEqual([]);
    expect(await db.select().from(channelSessions).limit(0)).toEqual([]);
    expect(await db.select().from(inboundMessages).limit(0)).toEqual([]);
  });

  it("processes one message end-to-end", async () => {
    const defaultUserId = inject("defaultUserId");
    const eventKey = inject("inngestEventKey");

    const profileRows = await db.select({ id: profiles.id }).from(profiles).limit(1);
    const channelRows = await db.select({ id: channels.id }).from(channels).limit(1);
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
        platformAddress: `smoke-${Date.now()}`,
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
        content: "Hello smoke test",
        platformTs: new Date(),
      })
      .returning({ id: inboundMessages.id });

    // Emit event via Inngest API
    const res = await fetch(`${inngestBaseUrl}/e/${eventKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "inbound/arrived",
        data: { conversationId: conv!.id, inboundMessageId: inbound!.id },
      }),
    });
    expect(res.ok).toBe(true);

    // Poll for assistant response
    const start = Date.now();
    let assistantMsg = null;
    while (Date.now() - start < 30_000) {
      const rows = await db
        .select()
        .from(messages)
        .where((await import("drizzle-orm")).eq(messages.conversationId, conv!.id));
      assistantMsg = rows.find((r) => r.role === "assistant");
      if (assistantMsg) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBeDefined();
  });
});
