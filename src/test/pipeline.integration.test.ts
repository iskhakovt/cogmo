/// <reference path="../../test/vitest.d.ts" />
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { chats, conversations, messages } from "../db/schema.js";

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
  it("processes a message end-to-end", async () => {
    const chatId = `test-chat-${Date.now()}`;

    // Send message/received event to Inngest
    await sendEvent("message/received", {
      channel: "test",
      chatId,
      userId: "test-user",
      text: "Hello integration test",
    });

    // Wait for assistant response to be persisted
    const assistantMsg = await waitForAssistantMessage();
    expect(assistantMsg.content).toBeDefined();

    // Verify user message was also persisted
    const userMsgs = await db.select().from(messages);
    const userMsg = userMsgs.find((r) => r.role === "user");
    expect(userMsg).toBeDefined();

    // Verify conversation was created
    const convRows = await db.select().from(conversations);
    expect(convRows.length).toBeGreaterThan(0);

    // Verify chat was created
    const chatRows = await db.select().from(chats);
    expect(chatRows.length).toBeGreaterThan(0);
  });
});

describe("migrations", () => {
  it("tables exist with correct structure", async () => {
    const convResult = await db.select().from(conversations).limit(0);
    expect(convResult).toEqual([]);

    const msgResult = await db.select().from(messages).limit(0);
    expect(msgResult).toEqual([]);
  });
});
