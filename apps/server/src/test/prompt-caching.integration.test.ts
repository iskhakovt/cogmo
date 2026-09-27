/// <reference path="../../test/vitest.d.ts" />
/**
 * Byte stability across a real conversation (design/prompt-caching.md → Test
 * Plan → Integration tier): every request the agent loop sends is the one
 * before it plus what happened since, within turns and across them.
 *
 * The profile offers `generate_image` and `core_memory_update`. A turn that
 * saves to core memory leaves the system prompt as it is: the next turn's
 * context announces the change.
 */

import { readFile } from "node:fs/promises";
import { createClient, createConfig, HindsightClient, sdk } from "@vectorize-io/hindsight-client";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { connect } from "inngest/connect";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { z } from "zod";
import type { Profile } from "../agent/store/index.js";
import {
  coreMemoryBlocks,
  messages,
  systemPromptSnapshots,
  turnContexts,
} from "../agent/store/schema.js";
import { renderTurnContext } from "../agent/turn-context.js";
import { db } from "../db/index.js";
import { env } from "../env.js";
import { bootstrap } from "../index.js";
import { HindsightMemoryProvider } from "../memory/hindsight.js";
import { DEFAULT_BASE_PROMPT } from "../setup/seed.js";
import type { InboundContent } from "../transport/content.js";
import { channelSessions, inboundMessages } from "../transport/store/schema.js";
import { assertAppendOnly, compareRequests } from "./append-only.js";
import { expectDefined } from "./assertions.js";
import { CASSETTE_CHAT_MODEL } from "./cassette-model.js";
import { createFalFetch } from "./fal-mock.js";
import { fileLlmockUrl } from "./integration-file.js";
import { createIsolatedUser } from "./isolated-user.js";
import { createWireRecorder, type WireRecorder } from "./wire-recorder.js";
import { workerInngestBaseUrl } from "./worker-inngest.js";

const RECORDING = process.env.RECORD === "1";
const TURN_TIMEOUT_MS = RECORDING ? 120_000 : 30_000;
const HINDSIGHT_TIMEOUT_MS = RECORDING ? 180_000 : 60_000;

// The user messages key the recorded turns: editing one means re-recording this file.
const DRAW = "Draw me a lighthouse on a rocky coast at dusk, for the wall of my study.";
const HOMELAB = "What do you remember about my homelab?";
const MOVE = "I've just moved to Lisbon. Please save that to my core memory.";
const HYPERVISOR = "Which hypervisor did I say the homelab runs?";
const PICTURE = "Here's the picture I ended up printing. What's in it?";
const THANKS = "Thanks!";
const FACT = "The user runs a three-node Proxmox cluster in their homelab.";
const PICTURE_PATH = "./test/fixtures/images/cat-in-a-hat.jpg";

const ONE_HOUR = { type: "ephemeral", ttl: "1h" };

let connection: Awaited<ReturnType<typeof connect>>;
let bootstrapped: Awaited<ReturnType<typeof bootstrap>>;
let recorder: WireRecorder;
let userId: string;
let profile: Profile;
let channelId: string;

beforeAll(async () => {
  const { AnthropicProvider } = await import("../llm/anthropic.js");
  const anthropicKey = RECORDING ? (process.env.ANTHROPIC_API_KEY ?? "test-key") : "test-key";
  recorder = createWireRecorder();
  bootstrapped = await bootstrap({
    providerOverride: new AnthropicProvider(anthropicKey, fileLlmockUrl(), {
      fetch: recorder.fetch,
    }),
    falFetchOverride: createFalFetch({
      mode: RECORDING ? "record" : "replay",
      fixturePath: "./test/fixtures/fal",
    }),
  });
  const { inngest, functions, runInTx, agentStore, transportStore } = bootstrapped;
  connection = await connect({ apps: [{ client: inngest, functions }] });

  userId = await createIsolatedUser(db);
  profile = await runInTx((tx) =>
    agentStore.createProfile(tx, {
      userId,
      name: "prompt-caching",
      basePrompt: DEFAULT_BASE_PROMPT,
      model: CASSETTE_CHAT_MODEL,
      toolSet: ["generate_image", "core_memory_update"],
    }),
  );
  // A known user, so the prompt carries core memory rather than onboarding.
  await runInTx((tx) =>
    agentStore.upsertCoreMemoryBlock(tx, {
      userId,
      profileClass: null,
      key: "identity",
      content: "Name: Sam",
    }),
  );
  const channel = await runInTx((tx) => transportStore.getChannelByType(tx, "direct"));
  channelId = expectDefined(channel, "seeded direct channel").id;
});

afterAll(async () => {
  if (connection) await connection.close();
});

async function sendEvent(name: string, data: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${workerInngestBaseUrl()}/e/${inject("inngestEventKey")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data }),
  });
  if (!res.ok) throw new Error(`failed to send ${name}: ${res.status} ${await res.text()}`);
}

interface Conversation {
  id: string;
  sessionId: string;
}

async function startConversation(): Promise<Conversation> {
  const { runInTx, agentStore } = bootstrapped;
  const { id } = await runInTx((tx) =>
    agentStore.createConversation(tx, { userId, profileId: profile.id, isPrivate: true }),
  );
  const [session] = await db
    .insert(channelSessions)
    .values({
      channelId,
      platformAddress: `prompt-caching-${id}`,
      conversationId: id,
      status: "active",
      receive: "routed",
    })
    .returning({ id: channelSessions.id });
  return { id, sessionId: expectDefined(session, "channel session row").id };
}

/** Send one user message and wait for the turn's final assistant row. */
async function turn(conversation: Conversation, content: InboundContent): Promise<void> {
  const [inbound] = await db
    .insert(inboundMessages)
    .values({
      channelSessionId: conversation.sessionId,
      conversationId: conversation.id,
      content,
      platformTs: new Date(),
      source: "user",
    })
    .returning({ id: inboundMessages.id });
  const inboundId = expectDefined(inbound, "inbound row").id;
  await sendEvent("inbound/arrived", {
    conversationId: conversation.id,
    inboundMessageId: inboundId,
  });

  await vi.waitFor(
    async () => {
      const [last] = await db
        .select({ role: messages.role, lastInboundMessageId: messages.lastInboundMessageId })
        .from(messages)
        .where(eq(messages.conversationId, conversation.id))
        .orderBy(desc(messages.id))
        .limit(1);
      if (last?.role !== "assistant" || last.lastInboundMessageId !== inboundId) {
        throw new Error(`no reply yet to ${JSON.stringify(content)}`);
      }
    },
    { timeout: TURN_TIMEOUT_MS, interval: 500 },
  );
}

/** Retain `fact` to the user's bank and wait until Hindsight has processed it. */
async function retainFact(fact: string): Promise<void> {
  const hindsightUrl = inject("hindsightUrl");
  const apiKey = inject("hindsightApiKey");
  await new HindsightMemoryProvider(hindsightUrl, { apiKey }).retain(userId, fact);
  const hindsightSdk = createClient(
    createConfig({ baseUrl: hindsightUrl, headers: { Authorization: `Bearer ${apiKey}` } }),
  );
  await vi.waitFor(
    async () => {
      const { data, error } = await sdk.listOperations({
        client: hindsightSdk,
        path: { bank_id: userId },
        query: { type: "retain" },
      });
      if (data === undefined) throw new Error(`listOperations: ${JSON.stringify(error)}`);
      const open = data.operations.filter(
        (op) => op.status === "pending" || op.status === "processing",
      );
      if (data.operations.length === 0 || open.length > 0) {
        throw new Error(`${open.length} of ${data.operations.length} retains still open`);
      }
      expect(data.operations.map((op) => op.status)).toEqual(["completed"]);
    },
    { timeout: HINDSIGHT_TIMEOUT_MS, interval: 1000 },
  );
  const page = await new HindsightClient({ baseUrl: hindsightUrl, apiKey }).listMemories(userId, {
    limit: 100,
    offset: 0,
  });
  expect(page.items.map((m) => m.text ?? "").join("\n")).toMatch(/Proxmox/);
}

const TextBlockSchema = z.object({ type: z.literal("text"), text: z.string() });
const LoopBodySchema = z.looseObject({
  system: z.array(z.looseObject({ text: z.string(), cache_control: z.unknown() })),
  tools: z.array(z.looseObject({ cache_control: z.unknown().optional() })),
  messages: z.array(z.looseObject({ role: z.string(), content: z.unknown() })),
  cache_control: z.unknown(),
});
type LoopBody = z.infer<typeof LoopBodySchema>;

/**
 * The agent loop's requests for the conversation that opened with `firstText`,
 * in the order sent: those carrying a cache intent (summarization and the
 * Observer send none), whose first message is that turn.
 */
async function loopRequests(firstText: string): Promise<LoopBody[]> {
  const settled = await Promise.all(
    recorder.exchanges.map(async (e) => ({ e, res: await e.response.catch(() => undefined) })),
  );
  return settled.flatMap(({ e, res }) => {
    if (!e.request.url.endsWith("/v1/messages") || res?.status !== 200) return [];
    const body = LoopBodySchema.safeParse(e.request.body);
    if (!body.success) return [];
    const first = JSON.stringify(body.data.messages[0]?.content ?? null);
    return first.includes(JSON.stringify(firstText).slice(1, -1)) ? [body.data] : [];
  });
}

/** Leading text of every user message led by a turn context, in order. */
function turnContextsIn(body: LoopBody): string[] {
  return body.messages.flatMap((m) => {
    if (m.role !== "user" || !Array.isArray(m.content)) return [];
    const first = TextBlockSchema.safeParse(m.content[0]);
    return first.success && first.data.text.startsWith("<turn_context>\n") ? [first.data.text] : [];
  });
}

function memoryLines(rendered: string): string[] {
  const body = rendered.split(/<recalled_memories[^>]*>\n/)[1]?.split("\n</recalled_memories>")[0];
  return (body ?? "").split("\n").filter((line) => line.startsWith("- "));
}

describe("prompt caching", () => {
  it("sends every request as the previous one plus what happened since", {
    timeout: RECORDING ? 900_000 : 240_000,
  }, async () => {
    const conversation = await startConversation();

    // Requests sent by the end of each turn, to name a request's turn.
    const sentBy: number[] = [];
    const take = async (content: InboundContent) => {
      await turn(conversation, content);
      sentBy.push((await loopRequests(DRAW)).length);
    };

    await take(DRAW);
    await retainFact(FACT);
    await take(HOMELAB);
    await take(MOVE);
    await take(HYPERVISOR);
    const picture = await bootstrapped.attachmentStore.upload(
      await readFile(PICTURE_PATH),
      "image/jpeg",
      "inbound",
    );
    await take([
      { type: "image", path: picture, mediaType: "image/jpeg" },
      { type: "text", text: PICTURE },
    ]);
    await take(THANKS);

    const requests = await loopRequests(DRAW);
    const turnOf = (request: number) => sentBy.findIndex((sent) => request < sent) + 1;
    // Turns 1 and 3 are tool turns: at least two iterations each.
    expect(sentBy).toHaveLength(6);
    const [throughDraw, throughHomelab, throughMove] = sentBy;
    expect(throughDraw).toBeGreaterThanOrEqual(2);
    expect(
      expectDefined(throughMove, "move") - expectDefined(throughHomelab, "homelab"),
    ).toBeGreaterThanOrEqual(2);
    const throughPicture = expectDefined(sentBy[4], "requests through the picture turn");
    expect(requests.length).toBeGreaterThan(throughPicture);

    // ── Append-only, request to request, within turns and across them ──
    const rows = await db
      .select({ id: messages.id, role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.conversationId, conversation.id))
      .orderBy(asc(messages.id));
    const pictureRow = rows.findIndex(
      (r) => r.role === "user" && JSON.stringify(r.content).includes(PICTURE),
    );
    for (let i = 1; i < requests.length; i++) {
      const prev = expectDefined(requests[i - 1], "previous request");
      const next = expectDefined(requests[i], "request");
      if (i === throughPicture) {
        // The one declared exception: the image turn's row reloads as JSON text.
        expect(compareRequests(prev, next).divergence).toBe(
          `messages[${pictureRow}].content[1].type`,
        );
        continue;
      }
      try {
        assertAppendOnly(prev, next);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`turn ${turnOf(i)}, request ${i + 1} of ${requests.length}: ${reason}`);
      }
    }

    // ── One system prompt, carrying nothing per-turn, across a core-memory edit ──
    const systems = new Set(requests.map((r) => JSON.stringify(r.system)));
    expect(systems.size).toBe(1);
    const system = expectDefined(requests[0], "first request")
      .system.map((b) => b.text)
      .join("");
    expect(system).not.toMatch(/Current time:/);
    expect(system).not.toMatch(/Recalled Context|Proxmox/);
    expect(system).toContain("Name: Sam");
    expect(system).not.toMatch(/Lisbon/);
    const blocks = await db
      .select({ key: coreMemoryBlocks.key, content: coreMemoryBlocks.content })
      .from(coreMemoryBlocks)
      .where(eq(coreMemoryBlocks.userId, userId));
    expect(blocks.map((b) => b.content).join("\n")).toMatch(/Lisbon/);
    const snapshots = await db
      .select({ openedBy: systemPromptSnapshots.openedBy })
      .from(systemPromptSnapshots)
      .where(eq(systemPromptSnapshots.conversationId, conversation.id));
    expect(snapshots).toHaveLength(1);

    // ── Every loop request caches for an hour: tools, system and the tail ──
    for (const request of requests) {
      expect(request.cache_control).toEqual(ONE_HOUR);
      expect(request.system.at(-1)?.cache_control).toEqual(ONE_HOUR);
      expect(request.tools.at(-1)?.cache_control).toEqual(ONE_HOUR);
    }

    // ── Each turn opens with its stored turn context ──
    const stored = await db
      .select({
        messageId: turnContexts.messageId,
        rendered: turnContexts.rendered,
        context: turnContexts.context,
      })
      .from(turnContexts)
      .where(
        inArray(
          turnContexts.messageId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(turnContexts.messageId));
    expect(stored).toHaveLength(6);
    const last = expectDefined(requests.at(-1), "last request");
    expect(turnContextsIn(last)).toEqual(stored.map((s) => s.rendered));
    for (const { rendered } of stored) expect(rendered).toContain("Delivery channels: direct\n");
    // The time is the row's `created_at`, in the configured timezone.
    const createdAt = new Map(
      (
        await db
          .select({ id: messages.id, createdAt: messages.createdAt })
          .from(messages)
          .where(eq(messages.conversationId, conversation.id))
      ).map((r) => [r.id, r.createdAt]),
    );
    // No block changes after the turn that announces it, so its content is
    // the announcement's.
    const content = new Map(blocks.map((b) => [b.key, b.content]));
    for (const { messageId, rendered, context } of stored) {
      expect(rendered).toBe(
        renderTurnContext({
          handledAt: expectDefined(createdAt.get(messageId), "message created_at"),
          timezone: env.USER_TIMEZONE,
          context,
          coreMemoryUpdates: {
            scope: { kind: "unclassed" },
            blocks: context.announcedCoreMemoryBlocks.map((b) => ({
              ...b,
              content: expectDefined(content.get(b.key), `core memory block ${b.key}`),
            })),
          },
        }),
      );
    }

    // ── The core-memory edit: announced by the next turn, and only by it ──
    const announcing = stored.flatMap((s, i) =>
      s.context.announcedCoreMemoryBlocks.length > 0 ? [i] : [],
    );
    expect(announcing).toEqual([3]);
    expect(expectDefined(stored[3], "turn 4 context").rendered).toMatch(
      /<core_memory_updates>[\s\S]*Lisbon[\s\S]*<\/core_memory_updates>/,
    );

    // ── Recalled memories: shown by turn 2, never shown twice ──
    const [, homelab] = stored;
    expect(memoryLines(expectDefined(homelab, "turn 2 context").rendered).join("\n")).toMatch(
      /Proxmox/,
    );
    const shown = stored.flatMap((s) => memoryLines(s.rendered));
    expect(shown).toEqual([...new Set(shown)]);
  });
});
