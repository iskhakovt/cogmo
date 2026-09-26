/// <reference path="../../test/vitest.d.ts" />
/**
 * The learning loop, end to end: what one conversation teaches changes what a
 * later conversation sends to the model. Real `handle-message` and the real
 * Observer run through Inngest against llmock fixtures and a real Hindsight.
 *
 * 1. Conversation 1 — the user states a core fact, which the agent writes to
 *    core memory in the turn; mentions a dinner, a Hindsight detail; and asks
 *    for no bullet points. The Observer learns an inactive rule from the
 *    correction and retains the facts to Hindsight.
 * 2. Conversation 2 — the same correction again. The Observer reinforces the
 *    rule, which graduates to active.
 * 3. Conversation 3 — the request the model receives carries the core memory
 *    block under `# User`, the rule under `# Rules`, and the dinner under
 *    `# Recalled Context`, recalled from Hindsight.
 *
 * The user and profile are this file's own. A learned rule is global
 * (`profile_id` null, no user column), so it reaches every other file's
 * prompts while it is active, and `afterAll` deletes it by id. Everything
 * else stays behind under the private user until the containers go.
 */

import { createClient, createConfig, HindsightClient, sdk } from "@vectorize-io/hindsight-client";
import { and, asc, desc, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import { connect } from "inngest/connect";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { z } from "zod";
import { formatUserContext } from "../agent/prompt.js";
import type { Profile } from "../agent/store/index.js";
import {
  coreMemoryBlocks,
  evolutionEvents,
  messages,
  steeringRules,
} from "../agent/store/schema.js";
import { db } from "../db/index.js";
import { bootstrap } from "../index.js";
import { DEFAULT_BASE_PROMPT } from "../setup/seed.js";
import { channelSessions, inboundMessages } from "../transport/store/schema.js";
import { expectDefined } from "./assertions.js";
import { CASSETTE_CHAT_MODEL } from "./cassette-model.js";
import { createIsolatedUser } from "./isolated-user.js";
import { workerInngestBaseUrl } from "./worker-inngest.js";

const RECORDING = process.env.RECORD === "1";
const TURN_TIMEOUT_MS = RECORDING ? 120_000 : 30_000;
const OBSERVER_TIMEOUT_MS = RECORDING ? 180_000 : 30_000;
const HINDSIGHT_TIMEOUT_MS = RECORDING ? 180_000 : 60_000;

// The user messages key the recorded turns, and the transcripts built from
// them key the Observer's: editing one means re-recording this file.
const CORE_FACT = "Call me T — I've just moved to Lisbon.";
const DINNER =
  "We had dinner at Taberna da Rua das Flores and the bacalhau was the best I've ever had. " +
  "What other Portuguese dishes should I try?";
const CORRECTION = "Please don't use bullet points with me — just write in plain sentences.";
const DAY_TRIPS = "Suggest three day trips from Lisbon I could do by train.";
const CORRECTION_AGAIN =
  "Again, no bullet points or numbered lists with me, please. Plain sentences only.";
/** Names neither the restaurant nor the dish, so only recall can put them in the prompt. */
const PROBE = "Where was that restaurant with the amazing cod? I want to book it again.";

/** The only channel this file's conversations use, so the only scope a rule it learns can take. */
const CHANNEL_TYPE = "direct";

let connection: Awaited<ReturnType<typeof connect>>;
let bootstrapped: Awaited<ReturnType<typeof bootstrap>>;
let hindsight: HindsightClient;
let hindsightSdk: ReturnType<typeof createClient>;
let userId: string;
let profile: Profile;
let channelId: string;
/** Every steering rule that existed before this file ran. */
let rulesBefore: ReadonlyArray<string> | undefined;

beforeAll(async () => {
  const { AnthropicProvider } = await import("../llm/anthropic.js");
  const anthropicKey = RECORDING ? (process.env.ANTHROPIC_API_KEY ?? "test-key") : "test-key";
  bootstrapped = await bootstrap({
    providerOverride: new AnthropicProvider(anthropicKey, inject("llmockBaseUrl")),
  });
  const { inngest, functions, runInTx, agentStore, transportStore } = bootstrapped;
  connection = await connect({ apps: [{ client: inngest, functions }] });

  const hindsightUrl = inject("hindsightUrl");
  const apiKey = inject("hindsightApiKey");
  hindsight = new HindsightClient({ baseUrl: hindsightUrl, apiKey });
  hindsightSdk = createClient(
    createConfig({ baseUrl: hindsightUrl, headers: { Authorization: `Bearer ${apiKey}` } }),
  );

  userId = await createIsolatedUser(db);
  profile = await runInTx((tx) =>
    agentStore.createProfile(tx, {
      userId,
      name: "learning-loop",
      basePrompt: DEFAULT_BASE_PROMPT,
      model: CASSETTE_CHAT_MODEL,
      toolSet: ["core_memory_update", "core_memory_read", "memory_retain"],
    }),
  );
  const channel = await runInTx((tx) => transportStore.getChannelByType(tx, CHANNEL_TYPE));
  channelId = expectDefined(channel, "seeded direct channel").id;

  const rows = await db.select({ id: steeringRules.id }).from(steeringRules);
  rulesBefore = rows.map((r) => r.id);
});

afterAll(async () => {
  if (rulesBefore !== undefined) {
    const learned = await learnedRules(rulesBefore);
    if (learned.length > 0) {
      await db.delete(steeringRules).where(
        inArray(
          steeringRules.id,
          learned.map((r) => r.id),
        ),
      );
    }
  }
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

/** A conversation on the direct channel, for this file's user and profile. */
async function startConversation(): Promise<Conversation> {
  const { runInTx, agentStore } = bootstrapped;
  const { id } = await runInTx((tx) =>
    agentStore.createConversation(tx, { userId, profileId: profile.id, isPrivate: true }),
  );
  const [session] = await db
    .insert(channelSessions)
    .values({
      channelId,
      platformAddress: `learning-loop-${id}`,
      conversationId: id,
      status: "active",
      receive: "routed",
    })
    .returning({ id: channelSessions.id });
  return { id, sessionId: expectDefined(session, "channel session row").id };
}

/** Send one user message and wait for the turn's final assistant row. */
async function turn(conversation: Conversation, content: string): Promise<void> {
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
      // One insert writes the turn's rows, so only `id` orders them.
      const [last] = await db
        .select({ role: messages.role, lastInboundMessageId: messages.lastInboundMessageId })
        .from(messages)
        .where(eq(messages.conversationId, conversation.id))
        .orderBy(desc(messages.id))
        .limit(1);
      if (last?.role !== "assistant" || last.lastInboundMessageId !== inboundId) {
        throw new Error(`no reply yet to "${content}"`);
      }
    },
    { timeout: TURN_TIMEOUT_MS, interval: 500 },
  );
}

/** Fire the Observer the way the idle timer does and wait for its audit row. */
async function observe(conversation: Conversation) {
  await sendEvent("conversation/idle", { conversationId: conversation.id });
  return vi.waitFor(
    async () => {
      const [event] = await db
        .select()
        .from(evolutionEvents)
        .where(eq(evolutionEvents.conversationId, conversation.id))
        .orderBy(desc(evolutionEvents.id))
        .limit(1);
      if (!event) throw new Error("the Observer has not finished yet");
      return event.payload;
    },
    { timeout: OBSERVER_TIMEOUT_MS, interval: 500 },
  );
}

/**
 * Rules the Observer learned during this file. Another file's learned rule is
 * global too, so this narrows to the scopes this file's conversations allow:
 * every channel, or the direct channel.
 */
async function learnedRules(before: ReadonlyArray<string>) {
  return db
    .select()
    .from(steeringRules)
    .where(
      and(
        eq(steeringRules.source, "correction"),
        or(isNull(steeringRules.channelType), eq(steeringRules.channelType, CHANNEL_TYPE)),
        ...(before.length > 0 ? [notInArray(steeringRules.id, [...before])] : []),
      ),
    )
    .orderBy(asc(steeringRules.id));
}

async function bulletPointRule() {
  const learned = await learnedRules(expectDefined(rulesBefore, "rules before this file"));
  const matching = learned.filter((r) => /bullet/i.test(r.rule));
  expect(matching, "one learned rule about bullet points").toHaveLength(1);
  return expectDefined(matching[0], "the bullet-point rule");
}

/**
 * Wait until Hindsight has processed every retain on the user's bank, then
 * return the bank's facts. The Observer's retains are async, and a recall
 * before they finish would miss what they carry.
 */
async function retainedFacts(): Promise<ReadonlyArray<string>> {
  const retains = await vi.waitFor(
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
      return data.operations;
    },
    { timeout: HINDSIGHT_TIMEOUT_MS, interval: 1000 },
  );
  expect(
    retains.filter((op) => op.status !== "completed").map((op) => op.error_message),
    "failed retains",
  ).toEqual([]);
  const page = await hindsight.listMemories(userId, { limit: 100, offset: 0 });
  return page.items.map((item) => item.text ?? "");
}

const JournalEntrySchema = z.object({ path: z.string(), body: z.unknown() });
const ChatBodySchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string().nullable() })),
});

/**
 * The system prompt of the first request llmock received whose latest user
 * message is `userMessage`: the prompt the model saw for that turn. The
 * journal keeps the last 1000 requests and swaps a body over 64 KB for a
 * truncation marker, so a miss can mean either.
 */
async function systemPromptSentWith(userMessage: string): Promise<string> {
  const res = await fetch(`${inject("llmockBaseUrl")}/__aimock/journal?path=/v1/messages`);
  if (!res.ok) throw new Error(`llmock journal: ${res.status}`);
  const entries = z.array(JournalEntrySchema).parse(await res.json());
  for (const entry of entries) {
    const body = ChatBodySchema.safeParse(entry.body);
    if (!body.success) continue;
    const users = body.data.messages.filter((m) => m.role === "user");
    if (users.at(-1)?.content !== userMessage) continue;
    const system = body.data.messages.find((m) => m.role === "system");
    return expectDefined(system?.content, "system prompt");
  }
  throw new Error(`no request in the llmock journal ends with "${userMessage}"`);
}

/** The body of a system prompt's `# heading` section, or "" when it has none. */
function section(system: string, heading: string): string {
  return system.split(`\n\n# ${heading}\n\n`)[1]?.split("\n\n# ")[0] ?? "";
}

describe("learning loop", () => {
  it("carries a core fact, a learned rule and a retained fact into a later conversation", {
    timeout: RECORDING ? 900_000 : 240_000,
  }, async () => {
    // ── Conversation 1: a core fact, a Hindsight detail, a correction ──
    const first = await startConversation();

    await turn(first, CORE_FACT);
    const blocksAfterFact = await db
      .select()
      .from(coreMemoryBlocks)
      .where(eq(coreMemoryBlocks.userId, userId))
      .orderBy(asc(coreMemoryBlocks.key));
    expect(formatUserContext(blocksAfterFact)).toMatch(/Lisbon/);

    await turn(first, DINNER);
    await turn(first, CORRECTION);

    const firstObservation = await observe(first);
    expect(firstObservation.corrections.extracted).toBeGreaterThanOrEqual(1);
    const learning = await bulletPointRule();
    expect(learning).toMatchObject({ active: false, observationCount: 1, profileId: null });

    expect(firstObservation.memories.extracted).toBeGreaterThanOrEqual(1);
    expect((await retainedFacts()).join("\n")).toMatch(/Taberna da Rua das Flores/);

    // ── Conversation 2: the same correction graduates the rule ──
    const second = await startConversation();
    await turn(second, DAY_TRIPS);
    await turn(second, CORRECTION_AGAIN);

    const secondObservation = await observe(second);
    expect(secondObservation.corrections.promoted).toBe(1);
    const rule = await bulletPointRule();
    expect(rule).toMatchObject({ id: learning.id, active: true, observationCount: 2 });

    // Conversation 2's own retains land before conversation 3 recalls.
    await retainedFacts();

    // ── Conversation 3: the model's request carries all three ──
    const blocks = await db
      .select()
      .from(coreMemoryBlocks)
      .where(eq(coreMemoryBlocks.userId, userId))
      .orderBy(asc(coreMemoryBlocks.key));
    const userSection = expectDefined(formatUserContext(blocks), "core memory");

    const third = await startConversation();
    await turn(third, PROBE);
    const system = await systemPromptSentWith(PROBE);

    expect(userSection).toMatch(/Lisbon/);
    expect(section(system, "User")).toBe(userSection);
    expect(section(system, "Rules").split("\n")).toContain(`- ${rule.rule}`);
    expect(section(system, "Recalled Context")).toMatch(/Taberna da Rua das Flores/);
  });
});
