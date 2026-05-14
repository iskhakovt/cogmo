/// <reference path="../../test/vitest.d.ts" />

import { eq } from "drizzle-orm";
import { connect } from "inngest/connect";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { conversations, messages, profiles } from "../agent/store/schema.js";
import { db } from "../db/index.js";
import { bootstrap } from "../index.js";
import { directOutbound } from "../inngest/events.js";
import { hashToolSchema } from "../mcp/approval.js";
import { mcpServers, mcpServerTools } from "../mcp/store/schema.js";
import { channelSessions, channels, inboundMessages } from "../transport/store/schema.js";
import { createInlineMcpEchoRunner } from "./mcp-inline-server.js";

/**
 * LLM-driven MCP pipeline integration test. Drives `handle-message`
 * end-to-end with an in-process MCP server reached via
 * `InMemoryTransport`, so the agent loop's MCP integration is exercised
 * against a real registry / pool / dispatcher pipeline without the
 * subprocess + readiness-probe + version-drift overhead of
 * `server-everything`.
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
 * Fixture stability: the inline server's tool description and schema
 * live inside this test file (frozen with the test, not with
 * `node_modules`). Re-record only when the test author edits the prompt
 * structure, the model, or the test's MCP tool surface.
 */

let inngestBaseUrl: string;
let connection: Awaited<ReturnType<typeof connect>>;
let mcpRunnerClose: () => Promise<void>;

interface CapturedOutbound {
  platformAddress: string;
  content: string;
}
const capturedOutbound: CapturedOutbound[] = [];

const MCP_SERVER_NAME = "echotest";

beforeAll(async () => {
  inngestBaseUrl = inject("inngestBaseUrl");

  // In-process MCP server reached via InMemoryTransport — no subprocess,
  // no readiness probe. The runner is injected through the bootstrap
  // override and supersedes the production HostRunner. Held outside the
  // bootstrap call so afterAll can tear it down independently.
  const { runner, close } = await createInlineMcpEchoRunner();
  mcpRunnerClose = close;

  const { AnthropicProvider } = await import("../llm/anthropic.js");
  const anthropicKey =
    process.env.RECORD === "1" ? (process.env.ANTHROPIC_API_KEY ?? "test-key") : "test-key";
  const provider = new AnthropicProvider(anthropicKey, inject("llmockBaseUrl"));

  const { inngest, functions } = await bootstrap({
    providerOverride: provider,
    mcpRunnerOverride: runner,
  });

  const captureOutbound = inngest.createFunction(
    { id: "test-mcp-capture-outbound", triggers: [directOutbound] },
    async ({ event }) => {
      capturedOutbound.push({
        platformAddress: event.data.platformAddress,
        content: event.data.content,
      });
      return { captured: true };
    },
  );

  connection = await connect({
    apps: [{ client: inngest, functions: [...functions, captureOutbound] }],
  });
});

afterAll(async () => {
  if (connection) await connection.close();
  if (mcpRunnerClose) await mcpRunnerClose();
});

beforeEach(async () => {
  capturedOutbound.length = 0;
});

/**
 * Seed an MCP server row + approved `echo` tool pin so the registry's
 * `resolveTools` surfaces `mcp__echotest__echo` for the active profile
 * (whose `toolSet` is `["*"]` per the default seed, matching every glob).
 * `config.transport` is `"stdio"` so it satisfies `McpServerConfigSchema`;
 * the inline runner ignores the config field entirely and returns the
 * pre-wired in-memory connection on spawn.
 */
async function seedEchoServer(): Promise<void> {
  const description = "Echo the input string back unchanged. Use this to verify connectivity.";
  const inputSchema = {
    type: "object",
    properties: {
      message: { type: "string", description: "The message to echo back" },
    },
    required: ["message"],
  };

  await db.delete(mcpServers).where(eq(mcpServers.name, MCP_SERVER_NAME));

  const [server] = await db
    .insert(mcpServers)
    .values({
      name: MCP_SERVER_NAME,
      config: { transport: "stdio", command: "/bin/true", args: [], env: {} },
      enabled: true,
      approvalStatus: "approved",
    })
    .returning({ id: mcpServers.id });
  if (!server) throw new Error("seed: mcp_servers insert returned no row");

  const snapshot = { description, inputSchema };
  await db.insert(mcpServerTools).values({
    serverId: server.id,
    toolName: "echo",
    schemaHash: hashToolSchema(snapshot),
    schemaSnapshot: snapshot,
    approvalStatus: "approved",
  });
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

async function waitForOutbound(
  predicate: (e: CapturedOutbound) => boolean,
  timeoutMs = 30_000,
): Promise<CapturedOutbound> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const match = capturedOutbound.find(predicate);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Timed out waiting for directOutbound");
}

describe("MCP pipeline", () => {
  it("LLM invokes an MCP tool end-to-end and the echoed value lands in the reply", async () => {
    const defaultUserId = inject("defaultUserId");

    await seedEchoServer();

    const [profile] = await db.select({ id: profiles.id }).from(profiles).limit(1);
    const [channel] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.type, "direct"))
      .limit(1);
    if (!profile || !channel) throw new Error("seed incomplete");

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
      })
      .returning({ id: inboundMessages.id });
    if (!inbound) throw new Error("inbound insert returned no row");

    await sendEvent("inbound/arrived", {
      conversationId: conv.id,
      inboundMessageId: inbound.id,
    });

    const timeoutMs = process.env.RECORD === "1" ? 60_000 : 30_000;
    const outbound = await waitForOutbound((e) => e.platformAddress === platformAddress, timeoutMs);

    // Sanity check that a tool_use / tool_result pair landed in the
    // persisted conversation — proves the MCP dispatch path executed
    // (the registry resolved `mcp__echotest__echo`, the agent loop
    // dispatched it, the in-memory MCP server replied) rather than the
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

    expect(outbound.content).toMatch(/PIPELINE_OK/);
  });
});
