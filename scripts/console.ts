#!/usr/bin/env tsx
/**
 * Interactive console for the assistant.
 *
 * Sends messages via Inngest events (adapter/direct/inbound),
 * polls the database for assistant responses.
 *
 * Usage:
 *   pnpm console
 *
 * Requires:
 *   DATABASE_URL — PostgreSQL connection
 *   INNGEST_BASE_URL — Inngest server (default: http://localhost:8288)
 *   INNGEST_EVENT_KEY — event key (default: "test" for dev)
 */
import * as readline from "node:readline";
import { and, desc, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { messages } from "../src/agent/store/schema.js";
import { channelSessions, channels } from "../src/transport/store/schema.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://cogmo@localhost/cogmo";
const INNGEST_BASE_URL = process.env.INNGEST_BASE_URL ?? "http://localhost:8288";
const INNGEST_EVENT_KEY = process.env.INNGEST_EVENT_KEY ?? "test";
const PLATFORM_ADDRESS = `console-${process.pid}`;

const db = drizzle({ connection: DATABASE_URL });

async function sendEvent(name: string, data: Record<string, unknown>) {
  const res = await fetch(`${INNGEST_BASE_URL}/e/${INNGEST_EVENT_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data }),
  });
  if (!res.ok) {
    throw new Error(`Failed to send event: ${res.status} ${await res.text()}`);
  }
}

async function getDirectChannelId(): Promise<string> {
  const rows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.type, "direct"))
    .limit(1);
  if (!rows[0]) throw new Error("No 'direct' channel found. Is the app running?");
  return rows[0].id;
}

async function getActiveConversationId(channelId: string): Promise<string | null> {
  const rows = await db
    .select({ conversationId: channelSessions.conversationId })
    .from(channelSessions)
    .where(
      and(
        eq(channelSessions.channelId, channelId),
        eq(channelSessions.platformAddress, PLATFORM_ADDRESS),
        eq(channelSessions.status, "active"),
      ),
    )
    .orderBy(desc(channelSessions.id))
    .limit(1);
  return rows[0]?.conversationId ?? null;
}

async function waitForResponse(
  conversationId: string,
  afterMessageId: string | null,
  timeoutMs = 30_000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const conditions = [
      eq(messages.conversationId, conversationId),
      eq(messages.role, "assistant"),
    ];
    if (afterMessageId) {
      conditions.push(gt(messages.id, afterMessageId));
    }

    const rows = await db
      .select({ id: messages.id, content: messages.content })
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.id))
      .limit(1);

    if (rows[0]) {
      const content = rows[0].content;
      return typeof content === "string" ? content : JSON.stringify(content);
    }

    await new Promise((r) => setTimeout(r, 400));
  }
  return "(timeout — no response received)";
}

async function getLastAssistantMessageId(conversationId: string): Promise<string | null> {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "assistant")))
    .orderBy(desc(messages.id))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function main() {
  const channelId = await getDirectChannelId();
  let conversationId = await getActiveConversationId(channelId);
  let lastAssistantId: string | null = null;

  if (conversationId) {
    lastAssistantId = await getLastAssistantMessageId(conversationId);
    console.log(`Resuming conversation ${conversationId.slice(0, 8)}...`);
  } else {
    console.log("No active conversation. Send a message to start one.");
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }

    try {
      if (text === "/new") {
        await sendEvent("adapter/direct/inbound", {
          platformAddress: PLATFORM_ADDRESS,
          text: "/new",
          platformTs: new Date().toISOString(),
        });
        conversationId = null;
        lastAssistantId = null;
        console.log("New conversation started.\n");
        rl.prompt();
        return;
      }

      await sendEvent("adapter/direct/inbound", {
        platformAddress: PLATFORM_ADDRESS,
        text,
        platformTs: new Date().toISOString(),
      });

      // Wait for session/conversation to be created if this is the first message
      if (!conversationId) {
        await new Promise((r) => setTimeout(r, 1000));
        conversationId = await getActiveConversationId(channelId);
        if (!conversationId) {
          console.log("(waiting for conversation to be created...)\n");
          await new Promise((r) => setTimeout(r, 2000));
          conversationId = await getActiveConversationId(channelId);
        }
      }

      if (!conversationId) {
        console.log("(could not find conversation — is the app running?)\n");
        rl.prompt();
        return;
      }

      process.stdout.write("...");
      const response = await waitForResponse(conversationId, lastAssistantId);
      process.stdout.write("\r");
      console.log(`\n${response}\n`);

      lastAssistantId = await getLastAssistantMessageId(conversationId);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
    }

    rl.prompt();
  });

  rl.on("close", async () => {
    await db.$client.end();
    console.log("\nBye.");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
