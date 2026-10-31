/**
 * The Observer over a real store: which turns a fire observes, and that each
 * one's corrections apply once, however many fires read the conversation.
 * Runs `runObserver` against PGlite with a scripted model.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import type { LlmProvider } from "../../llm/provider.js";
import type { ChatParams, LlmResponse } from "../../llm/types.js";
import { expectDefined, expectOk } from "../../test/assertions.js";
import { mockProvider, mockResolver, mockTransportStore } from "../../test/factories.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { inboundMessages } from "../../transport/store/schema.js";
import { DrizzleAgentStore } from "../store/index.js";
import { messages, steeringRules } from "../store/schema.js";
import { type ObserverDeps, type ObserverStepHarness, runObserver } from "./observer.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleAgentStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

const syncStep: ObserverStepHarness = { run: (_id, fn) => fn() };

/** The user's words the scripted correction quotes. */
const CORRECTION = "Shorter please, you're far too verbose.";

/** Answers every correction prompt with `corrections`, and every other prompt with nothing. */
function scriptedProvider(corrections: ReadonlyArray<Record<string, unknown>>): LlmProvider {
  return mockProvider({
    chat: vi.fn(async (params: ChatParams): Promise<LlmResponse> => {
      const answer = params.system.includes("behavioral correction extractor")
        ? { corrections }
        : params.system.includes("memory extraction engine")
          ? { memories: [] }
          : { groups: [] };
      return {
        content: [{ type: "text", text: JSON.stringify(answer) }],
        stopReason: "end_turn",
        model: "mock",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
  });
}

const REINFORCE_CONCISE = {
  action: "reinforce",
  matchedExistingRuleId: "R1",
  rule: "Be concise",
  category: "style",
  reasoning: "the user asked for shorter replies",
  evidence: "Shorter please",
};

interface Seeded {
  conversationId: string;
  profileId: string;
}

async function seedConversation(): Promise<Seeded> {
  return tx(async (trx) => {
    const user = await store.createUser(trx);
    const profile = expectOk(
      await store.createProfile(trx, {
        userId: null,
        name: "main",
        basePrompt: "",
        model: "m",
        toolSet: [],
      }),
    );
    const conversation = await store.createConversation(trx, {
      userId: user.id,
      profileId: profile.id,
      isPrivate: true,
    });
    return { conversationId: conversation.id, profileId: profile.id };
  });
}

/** One answered turn: the user's row and the reply, on a fresh cursor unless given. */
async function seedTurn(
  seeded: Seeded,
  userText: string,
  reply: string,
  cursor: string = randomUUID(),
): Promise<string> {
  await db.insert(messages).values(
    [
      { role: "user" as const, content: userText },
      { role: "assistant" as const, content: reply },
    ].map((m) => ({
      conversationId: seeded.conversationId,
      role: m.role,
      content: [{ type: "text" as const, text: m.content }],
      profileId: seeded.profileId,
      model: "m",
      lastInboundMessageId: cursor,
      firstInboundMessageId: null,
      outputTokens: -1,
    })),
  );
  return cursor;
}

/** A learned rule still learning, as a first contradiction leaves it. */
async function seedLearningRule(rule: string, observationCount: number): Promise<string> {
  const [row] = await db
    .insert(steeringRules)
    .values({
      rule,
      category: "style",
      status: "learning",
      source: "correction",
      priority: 100,
      observationCount,
      profileId: null,
      channelType: null,
    })
    .returning({ id: steeringRules.id });
  return expectDefined(row, rule).id;
}

async function ruleState(id: string): Promise<{ status: string; observationCount: number }> {
  const [row] = await db
    .select({ status: steeringRules.status, observationCount: steeringRules.observationCount })
    .from(steeringRules)
    .where(eq(steeringRules.id, id));
  return expectDefined(row, id);
}

function deps(provider: LlmProvider): ObserverDeps {
  return {
    runInTx: tx,
    agentStore: store,
    transportStore: mockTransportStore(),
    resolveProvider: mockResolver(provider),
    memory: { retainBatch: vi.fn().mockResolvedValue(undefined) },
  };
}

describe("runObserver over the transcript it has already read", () => {
  it("reinforces a correction once, however many fires read its turn", async () => {
    const seeded = await seedConversation();
    await seedTurn(seeded, "Tell me about Lisbon.", "Lisbon is a city of seven hills, and ...");
    await seedTurn(seeded, CORRECTION, "Lisbon: hills, trams, custard tarts.");
    const ruleId = await seedLearningRule("Be concise", 0);
    const provider = scriptedProvider([REINFORCE_CONCISE]);
    const event = { data: { conversationId: seeded.conversationId } };

    await runObserver(event, syncStep, deps(provider), "idle");
    await runObserver(event, syncStep, deps(provider), "idle");

    expect(await ruleState(ruleId)).toEqual({ status: "learning", observationCount: 1 });
  });

  it("retires a rule still learning that two turns of one conversation contradict", async () => {
    const seeded = await seedConversation();
    const ruleId = await seedLearningRule("Use bullet points", 1);
    const provider = scriptedProvider([
      {
        action: "contradiction",
        matchedExistingRuleId: "R1",
        rule: "Write in plain sentences",
        category: "style",
        reasoning: "the user takes the bullet points back",
        evidence: "no bullet points",
      },
    ]);
    const event = { data: { conversationId: seeded.conversationId } };
    await seedTurn(seeded, "Compare trams and buses.", "- Trams: rails\n- Buses: roads");
    await seedTurn(seeded, "Please, no bullet points.", "Understood.");
    await runObserver(event, syncStep, deps(provider), "idle");
    expect(await ruleState(ruleId)).toEqual({ status: "learning", observationCount: 0 });

    await seedTurn(seeded, "Again: no bullet points, ever.", "Sorry, plain sentences.");
    await runObserver(event, syncStep, deps(provider), "idle");

    expect(await ruleState(ruleId)).toMatchObject({ status: "retired" });
  });

  it("sends a later fire the turn it hasn't read, with the earlier one as context only", async () => {
    const seeded = await seedConversation();
    const event = { data: { conversationId: seeded.conversationId } };
    await seedTurn(seeded, "Tell me about Lisbon.", "Lisbon is a city of seven hills.");
    await seedTurn(seeded, "And Porto?", "Porto sits on the Douro.");
    await runObserver(event, syncStep, deps(scriptedProvider([])), "idle");
    await seedTurn(seeded, CORRECTION, "Porto: river, port wine.");
    const provider = scriptedProvider([]);

    await runObserver(event, syncStep, deps(provider), "idle");

    const turns = correctionMessages(provider).map(
      (m) => /<turn>\n([\s\S]*)\n<\/turn>/.exec(m)?.[1],
    );
    expect(turns).toEqual([`User: ${CORRECTION}\n\nAssistant: Porto: river, port wine.`]);
  });

  it("calls no correction model for a scheduled turn's prompt", async () => {
    const seeded = await seedConversation();
    const [scheduled] = await db
      .insert(inboundMessages)
      .values({
        source: "scheduled",
        idempotencyKey: `task:${randomUUID()}`,
        conversationId: seeded.conversationId,
        content: "Send the morning briefing.",
        platformTs: new Date(),
      })
      .returning({ id: inboundMessages.id });
    await seedTurn(seeded, "Send the morning briefing.", "Good morning: ...", scheduled?.id);
    await seedTurn(seeded, "Thanks.", "You're welcome.");
    const provider = scriptedProvider([]);

    await runObserver(
      { data: { conversationId: seeded.conversationId } },
      syncStep,
      deps(provider),
      "idle",
    );

    const turns = correctionMessages(provider).map(
      (m) => /<turn>\n([\s\S]*)\n<\/turn>/.exec(m)?.[1],
    );
    expect(turns).toEqual(["User: Thanks.\n\nAssistant: You're welcome."]);
  });
});

/** The user message of every correction-extraction call `provider` received. */
function correctionMessages(provider: LlmProvider): string[] {
  return vi
    .mocked(provider.chat)
    .mock.calls.flatMap(([params]) =>
      params.system.includes("behavioral correction extractor")
        ? params.messages.flatMap((m) => (typeof m.content === "string" ? [m.content] : []))
        : [],
    );
}
