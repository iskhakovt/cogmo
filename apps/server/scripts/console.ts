#!/usr/bin/env tsx
/**
 * Interactive console for cogmo.
 *
 * Sends messages via Inngest events (adapter/direct/inbound),
 * polls the database for assistant-role responses.
 *
 * Usage:
 *   pnpm console
 *   echo "hello" | pnpm console   # replies to each piped line, then exits;
 *                                 # nonzero if a line went unanswered
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

/** The newest assistant reply after `afterMessageId`, or null if none lands within `timeoutMs`. */
async function waitForResponse(
  conversationId: string,
  afterMessageId: string | null,
  timeoutMs: number,
): Promise<string | null> {
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
  return null;
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

  /** Resolves whether the line was delivered and, unless it is `/new`, answered. */
  async function send(text: string): Promise<boolean> {
    if (text === "/new") {
      await sendEvent("adapter/direct/inbound", {
        platformAddress: PLATFORM_ADDRESS,
        text: "/new",
        platformTs: new Date().toISOString(),
      });
      conversationId = null;
      lastAssistantId = null;
      console.log("New conversation started.\n");
      return true;
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
      return false;
    }

    process.stdout.write("...");
    const response = await waitForResponse(conversationId, lastAssistantId, 30_000);
    process.stdout.write("\r");
    console.log(`\n${response ?? "(timeout — no response received)"}\n`);

    lastAssistantId = await getLastAssistantMessageId(conversationId);
    return response !== null;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });
  // readline throws on a prompt after `close`.
  let inputEnded = false;
  rl.on("close", () => {
    inputEnded = true;
  });
  let unanswered = false;
  // Ctrl+C leaves at once; the end of input (Ctrl+D, a drained pipe) waits
  // for the reply in flight. readline keeps the terminal raw while it listens,
  // so Ctrl+C never kills the process: a second one quits without waiting for
  // the database to close.
  let interrupted = false;
  rl.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    bye(unanswered ? 1 : 0).catch(fatal);
  });

  rl.prompt();

  // One line at a time, each after the previous reply. The loop ends after
  // the reply to the last line, so `echo msg | pnpm console` prints it.
  for await (const line of rl) {
    const text = line.trim();
    if (text) {
      try {
        const answered = await send(text);
        if (!answered) unanswered = true;
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : err);
        unanswered = true;
      }
    }
    if (!inputEnded) rl.prompt();
  }
  await bye(unanswered ? 1 : 0);
}

async function bye(exitCode: number): Promise<never> {
  await db.$client.end();
  console.log("\nBye.");
  process.exit(exitCode);
}

function fatal(err: unknown): never {
  console.error("Fatal:", err);
  process.exit(1);
}

main().catch(fatal);
