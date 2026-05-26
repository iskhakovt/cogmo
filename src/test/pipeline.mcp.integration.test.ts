/// <reference path="../../test/vitest.d.ts" />

import { eq } from "drizzle-orm";
import { connect } from "inngest/connect";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { conversations, messages } from "../agent/store/schema.js";
import { db } from "../db/index.js";
import { bootstrap } from "../index.js";
import { channelSessions, inboundMessages } from "../transport/store/schema.js";

/**
 * LLM-driven MCP pipeline integration test. Drives `handle-message`
 * end-to-end through the production registry / pool / dispatcher
 * pipeline and the production `HostRunner` — the test's MCP server runs
 * in `globalSetup` over Streamable HTTP, so every worker can reach it
 * regardless of which one Inngest routes the event to.
 *
 * What this test catches that the registry-level tests don't:
 * 1. `resolveTools` output is merged into the agent loop's tool list
 *    and surfaces through the LLM provider's tool block.
 * 2. The LLM-visible name encoding (`mcp__<server>__<tool>`) survives
 *    the round trip from registry → prompt → LLM tool_use → dispatcher
 *    → MCP server.
 * 3. Tool results are wrapped back into the conversation as
 *    `tool_result` blocks and the LLM's follow-up text references the
 *    echoed payload.
 *
 * Assertion strategy: poll the persisted `messages` table for the final
 * assistant turn (instead of attaching an Inngest function to capture
 * `directOutbound`). Reason: `inngest.connect` consolidates function
 * registrations under one app id ("cogmo"). When this test runs in
 * parallel with `pipeline.integration.test.ts` — which also calls
 * `connect` with its own outbound-capture function on the same app id —
 * one fork's capture function shadows the other, and the event never
 * reaches this fork's buffer. Polling `messages` reads from the shared
 * Postgres so the assertion is fork-routing-independent. The outbound
 * event itself is covered by `pipeline.integration.test.ts`'s
 * `processes inbound/arrived end-to-end` case.
 *
 * Fixture stability: the test's tool schema lives inside
 * `src/test/mcp-http-echo-server.ts` (frozen with the test, not with
 * `node_modules`). Re-record only when the test author edits the prompt
 * structure, the model, or the test's MCP tool surface.
 */

let inngestBaseUrl: string;
let connection: Awaited<ReturnType<typeof connect>>;
let bootstrapped: Awaited<ReturnType<typeof bootstrap>>;
let mcpServerId: string | undefined;

const MCP_SERVER_NAME = "echotest";

beforeAll(async () => {
  inngestBaseUrl = inject("inngestBaseUrl");

  const { AnthropicProvider } = await import("../llm/anthropic.js");
  const anthropicKey =
    process.env.RECORD === "1" ? (process.env.ANTHROPIC_API_KEY ?? "test-key") : "test-key";
  const provider = new AnthropicProvider(anthropicKey, inject("llmockBaseUrl"));

  bootstrapped = await bootstrap({ providerOverride: provider });
  const { inngest, functions } = bootstrapped;

  // Connect this worker so production functions (handle-message, the
  // direct-channel adapter, etc.) are reachable from the gateway.
  // No test capture function — see file-header note on cross-fork
  // routing — the assertion polls `messages` directly.
  connection = await connect({ apps: [{ client: inngest, functions }] });
});

afterAll(async () => {
  if (connection) await connection.close();
  // Stop the registry before the test orchestrator tears down the shared
  // MCP HTTP server so the client-side pool closes its connections cleanly
  // (matches the pattern in bootstrap-daytona.integration.test.ts).
  if (bootstrapped) {
    if (mcpServerId) await bootstrapped.mcpRegistry.removeServer(mcpServerId);
    await bootstrapped.mcpRegistry.stop();
  }
});

/**
 * Drive the registry's public API end-to-end: register the server,
 * approve it (which spawns via the production `HostRunner` over
 * Streamable HTTP, calls `listTools` against the shared echo server,
 * and pins the schema), then approve the resulting `echo` pin so
 * `resolveTools` will surface `mcp__echotest__echo` to the agent loop.
 *
 * Going through the API instead of raw `db.insert` keeps the echo
 * server's tool description / schema in one place — drift between the
 * test's pin and the live tool can't slip past, because the pin comes
 * from `listTools` against the same server the dispatcher calls.
 */
async function seedEchoServer(): Promise<string> {
  const { mcpRegistry } = bootstrapped;
  const server = await mcpRegistry.addServer({
    name: MCP_SERVER_NAME,
    config: { transport: "http", url: inject("mcpEchoUrl"), headers: {} },
    enabled: true,
  });
  await mcpRegistry.approveServer(server.id);
  await mcpRegistry.approveTool(server.id, "echo");
  return server.id;
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

interface PersistedMessage {
  role: string;
  content: unknown;
}

async function waitForFinalAssistantMessage(
  conversationId: string,
  predicate: (msg: PersistedMessage) => boolean,
  timeoutMs: number,
): Promise<PersistedMessage> {
  return vi.waitFor(
    async () => {
      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId));
      const lastAssistant = [...rows].reverse().find((m) => m.role === "assistant");
      if (!lastAssistant || !predicate(lastAssistant)) {
        throw new Error("no matching final assistant message yet");
      }
      return lastAssistant;
    },
    { timeout: timeoutMs, interval: 500 },
  );
}

function flattenText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as { type?: string; text?: string }[])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

describe("MCP pipeline", () => {
  it("LLM invokes an MCP tool end-to-end and the echoed value lands in the reply", async () => {
    const defaultUserId = inject("defaultUserId");
    const { transportStore, runInTx, profile } = bootstrapped;

    mcpServerId = await seedEchoServer();

    const channel = await runInTx((tx) => transportStore.getChannelByType(tx, "direct"));
    if (!channel) throw new Error("seed incomplete: no direct channel");

    const platformAddress = `mcp-test-${Date.now()}`;
    const [conv] = await db
      .insert(conversations)
      .values({ userId: defaultUserId, profileId: profile.id, isPrivate: true })
      .returning({ id: conversations.id });
    if (!conv) throw new Error("conversation insert returned no row");

    const [session] = await db
      .insert(channelSessions)
      .values({
        channelId: channel.id,
        platformAddress,
        conversationId: conv.id,
        status: "active",
        receive: "routed",
      })
      .returning({ id: channelSessions.id });
    if (!session) throw new Error("channel session insert returned no row");

    // User prompt nudges the LLM toward calling mcp__echotest__echo with a
    // recognisable string. Record mode captures the full Anthropic
    // tool_use → tool_result → final text round trip; replay drives the
    // same agent loop against the recorded fixture.
    const [inbound] = await db
      .insert(inboundMessages)
      .values({
        channelSessionId: session.id,
        conversationId: conv.id,
        content:
          "Please call the echotest echo tool with the message 'PIPELINE_OK' and reply with the result.",
        platformTs: new Date(),
        source: "user",
      })
      .returning({ id: inboundMessages.id });
    if (!inbound) throw new Error("inbound insert returned no row");

    await sendEvent("inbound/arrived", {
      conversationId: conv.id,
      inboundMessageId: inbound.id,
    });

    const timeoutMs = process.env.RECORD === "1" ? 60_000 : 30_000;
    const finalMsg = await waitForFinalAssistantMessage(
      conv.id,
      (m) => /PIPELINE_OK/.test(flattenText(m.content)),
      timeoutMs,
    );

    // Sanity check that a tool_use / tool_result pair landed in the
    // persisted conversation — proves the MCP dispatch path executed
    // (the registry resolved `mcp__echotest__echo`, the agent loop
    // dispatched it, the in-process MCP server replied) rather than the
    // LLM merely hallucinating the echoed payload back into its reply.
    const allMsgs = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    const hasToolCall = allMsgs.some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === "tool_use" && b.name === "mcp__echotest__echo"),
    );
    const hasToolResult = allMsgs.some(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
    );
    expect(hasToolCall).toBe(true);
    expect(hasToolResult).toBe(true);

    expect(flattenText(finalMsg.content)).toMatch(/PIPELINE_OK/);
  });
});
