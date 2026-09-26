// DIAGNOSTIC ONLY — branch diag/mcp-pipeline-timeout, never merged. Lives
// outside src/ so no spec file changes size (Vitest orders files by size).

import { desc, eq, like } from "drizzle-orm";
import { messages } from "../src/agent/store/schema.js";
import { db } from "../src/db/index.js";
import { diag } from "../src/diag.js";
import { channelSessions, inboundMessages } from "../src/transport/store/schema.js";

async function gql(baseUrl: string, query: string): Promise<string> {
  try {
    const res = await fetch(`${baseUrl}/v0/gql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });
    return (await res.text()).slice(0, 20_000);
  } catch (err) {
    return `gql failed: ${String(err)}`;
  }
}

export async function dumpMcpDiagnostics(): Promise<void> {
  const baseUrl = process.env.INNGEST_BASE_URL ?? "";
  const [session] = await db
    .select({ conversationId: channelSessions.conversationId })
    .from(channelSessions)
    .where(like(channelSessions.platformAddress, "mcp-test-%"))
    .orderBy(desc(channelSessions.createdAt))
    .limit(1);
  const conversationId = session?.conversationId ?? "";
  diag("DUMP begin", conversationId, baseUrl);
  const inb = await db
    .select()
    .from(inboundMessages)
    .where(eq(inboundMessages.conversationId, conversationId));
  diag("DUMP inbound_messages", JSON.stringify(inb));
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, conversationId));
  diag("DUMP messages", JSON.stringify(msgs).slice(0, 8000));
  diag("DUMP apps", await gql(baseUrl, "{ apps { name connected functionCount } }"));
  let events: { id: string; name: string; data?: { conversationId?: string } }[] = [];
  try {
    const res = await fetch(`${baseUrl}/v1/events?limit=100`);
    events = ((await res.json()) as { data: typeof events }).data;
  } catch (err) {
    diag("DUMP events fetch failed", String(err));
  }
  diag("DUMP recent events", JSON.stringify(events.map((e) => [e.name, e.data?.conversationId])));
  const runIds: string[] = [];
  for (const e of events.filter((ev) => ev.data?.conversationId === conversationId)) {
    const out = await gql(
      baseUrl,
      `{ event(query:{workspaceId:"local", eventId:"${e.id}"}) { name status pendingRuns totalRuns functionRuns { id status startedAt finishedAt function { slug app { name connected } } } } }`,
    );
    diag("DUMP event", e.name, e.id, out);
    for (const m of out.matchAll(/"id":"([0-9A-Z]{26})"/g)) if (m[1]) runIds.push(m[1]);
  }
  for (const runId of runIds) {
    diag(
      "DUMP runTrace",
      runId,
      await gql(
        baseUrl,
        `{ runTrace(runID:"${runId}") { name status queuedAt startedAt endedAt attempts stepOp childrenSpans { name status stepOp queuedAt startedAt endedAt attempts childrenSpans { name status queuedAt startedAt endedAt attempts } } } }`,
      ),
    );
  }
  diag("DUMP end", conversationId);
}
