/// <reference path="../../test/vitest.d.ts" />
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { conversations, messages } from "../db/schema.js";

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

async function waitForMessage(
  conversationId: string,
  role: string,
  timeoutMs = 15_000,
): Promise<typeof messages.$inferSelect> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    const match = rows.find((r) => r.role === role);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${role} message in conversation ${conversationId}`);
}

describe("message pipeline", () => {
  it("processes a message end-to-end", async () => {
    const conversationId = `test-${Date.now()}`;

    // Send message/received event to Inngest
    await sendEvent("message/received", {
      conversationId,
      channel: "test",
      chatId: conversationId,
      userId: "test-user",
      text: "Hello integration test",
    });

    // Wait for assistant response to be persisted
    const assistantMsg = await waitForMessage(conversationId, "assistant");

    // Verify assistant message was persisted
    expect(assistantMsg.content).toBeDefined();
    expect(assistantMsg.model).toBeDefined();
    expect(assistantMsg.inputTokens).toBeGreaterThan(0);
    expect(assistantMsg.outputTokens).toBeGreaterThan(0);

    // Verify user message was also persisted
    const userMsg = await waitForMessage(conversationId, "user");
    expect(userMsg.content).toBe("Hello integration test");

    // Verify conversation was created
    const convRows = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(convRows).toHaveLength(1);
    expect(convRows[0]!.channel).toBe("test");
    expect(convRows[0]!.userId).toBe("test-user");
  });
});

describe("migrations", () => {
  it("tables exist with correct structure", async () => {
    // If we got here, migrations ran successfully (app started).
    // Verify the tables are queryable.
    const convResult = await db.select().from(conversations).limit(0);
    expect(convResult).toEqual([]);

    const msgResult = await db.select().from(messages).limit(0);
    expect(msgResult).toEqual([]);
  });
});
