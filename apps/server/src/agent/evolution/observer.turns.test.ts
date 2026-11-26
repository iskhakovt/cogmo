/**
 * The Observer over a real store: which turns a fire observes, and that each
 * one's corrections apply once and its facts are retained once, however many
 * fires read the conversation. Runs `runObserver` against PGlite with a
 * scripted model.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import type { LlmProvider } from "../../llm/provider.js";
import type { ChatParams, LlmResponse } from "../../llm/types.js";
import type { MemoryProvider } from "../../memory/provider.js";
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

/** A fact the scripted memory extraction finds in any turn that states it. */
const HOMELAB_FACT = {
  fact: "homelab IP is 10.0.10.10",
  network: "world",
  compartment: "technical",
  trust: "first-party",
  evidence: "homelab IP is 10.0.10.10",
};

/**
 * Answers every correction prompt with `corrections`, every memory prompt with
 * `memories` of its message, and every other prompt with nothing.
 */
function scriptedProvider(
  corrections: ReadonlyArray<Record<string, unknown>>,
  memories: (message: string) => ReadonlyArray<Record<string, unknown>> = () => [],
): LlmProvider {
  return mockProvider({
    chat: vi.fn(async (params: ChatParams): Promise<LlmResponse> => {
      const message = params.messages.flatMap((m) =>
        typeof m.content === "string" ? [m.content] : [],
      )[0];
      const answer = params.system.includes("behavioral correction extractor")
        ? { corrections }
        : params.system.includes("memory extraction engine")
          ? { memories: memories(message ?? "") }
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

function deps(
  provider: LlmProvider,
  memory: Pick<MemoryProvider, "retainBatch"> = {
    retainBatch: vi.fn().mockResolvedValue(undefined),
  },
): ObserverDeps {
  return {
    runInTx: tx,
    agentStore: store,
    transportStore: mockTransportStore(),
    resolveProvider: mockResolver(provider),
    memory,
  };
}

/** Every item `memory` was asked to retain, in order. */
function retained(memory: Pick<MemoryProvider, "retainBatch">) {
  return vi.mocked(memory.retainBatch).mock.calls.flatMap(([, items]) => items);
}

describe("runObserver over the transcript it has already read", () => {
  it("reinforces a correction once, however many fires read its turn", async () => {
    const seeded = await seedConversation();
    await seedTurn(seeded, "Tell me about Lisbon.", "Lisbon is a city of seven hills, and ...");
    await seedTurn(seeded, CORRECTION, "Lisbon: hills, trams, custard tarts.");
    const ruleId = await seedLearningRule("Be concise", 0);
    const provider = scriptedProvider([REINFORCE_CONCISE]);
    const event = { data: { conversationId: seeded.conversationId } };

    await runObserver(event, syncStep, deps(provider), { triggeredBy: "idle", runId: "run-1" });
    await runObserver(event, syncStep, deps(provider), { triggeredBy: "idle", runId: "run-1" });

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
    await runObserver(event, syncStep, deps(provider), { triggeredBy: "idle", runId: "run-1" });
    expect(await ruleState(ruleId)).toEqual({ status: "learning", observationCount: 0 });

    await seedTurn(seeded, "Again: no bullet points, ever.", "Sorry, plain sentences.");
    await runObserver(event, syncStep, deps(provider), { triggeredBy: "idle", runId: "run-1" });

    expect(await ruleState(ruleId)).toMatchObject({ status: "retired" });
  });

  it("sends a later fire the turn it hasn't read, with the earlier one as context only", async () => {
    const seeded = await seedConversation();
    const event = { data: { conversationId: seeded.conversationId } };
    await seedTurn(seeded, "Tell me about Lisbon.", "Lisbon is a city of seven hills.");
    await seedTurn(seeded, "And Porto?", "Porto sits on the Douro.");
    await runObserver(event, syncStep, deps(scriptedProvider([])), {
      triggeredBy: "idle",
      runId: "run-1",
    });
    await seedTurn(seeded, CORRECTION, "Porto: river, port wine.");
    const provider = scriptedProvider([]);

    await runObserver(event, syncStep, deps(provider), { triggeredBy: "idle", runId: "run-1" });

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
      { triggeredBy: "idle", runId: "run-1" },
    );

    const turns = correctionMessages(provider).map(
      (m) => /<turn>\n([\s\S]*)\n<\/turn>/.exec(m)?.[1],
    );
    expect(turns).toEqual(["User: Thanks.\n\nAssistant: You're welcome."]);
  });
});

/** The user message of every correction-extraction call `provider` received. */
function correctionMessages(provider: LlmProvider): string[] {
  return messagesOf(provider, "behavioral correction extractor");
}

/** The user message of every memory-extraction call `provider` received. */
function memoryMessages(provider: LlmProvider): string[] {
  return messagesOf(provider, "memory extraction engine");
}

function messagesOf(provider: LlmProvider, prompt: string): string[] {
  return vi
    .mocked(provider.chat)
    .mock.calls.flatMap(([params]) =>
      params.system.includes(prompt)
        ? params.messages.flatMap((m) => (typeof m.content === "string" ? [m.content] : []))
        : [],
    );
}

describe("runObserver over the facts it has already retained", () => {
  it("retains a turn's facts once, however many fires read its turn", async () => {
    const seeded = await seedConversation();
    await seedTurn(seeded, "My homelab IP is 10.0.10.10.", "Noted.");
    await seedTurn(seeded, "Thanks.", "You're welcome.");
    const memory = { retainBatch: vi.fn().mockResolvedValue(undefined) };
    const provider = scriptedProvider([], () => [HOMELAB_FACT]);
    const event = { data: { conversationId: seeded.conversationId } };

    await runObserver(event, syncStep, deps(provider, memory), {
      triggeredBy: "idle",
      runId: "run-1",
    });
    await runObserver(event, syncStep, deps(provider, memory), {
      triggeredBy: "idle",
      runId: "run-2",
    });

    expect(retained(memory).map((i) => i.content)).toEqual([HOMELAB_FACT.fact]);
  });

  it("retains each fact under a document id keyed on its turn and its position", async () => {
    const seeded = await seedConversation();
    const cursor = await seedTurn(seeded, "My homelab IP is 10.0.10.10.", "Noted.");
    await seedTurn(seeded, "Thanks.", "You're welcome.");
    const memory = { retainBatch: vi.fn().mockResolvedValue(undefined) };

    await runObserver(
      { data: { conversationId: seeded.conversationId } },
      syncStep,
      deps(
        scriptedProvider([], () => [HOMELAB_FACT]),
        memory,
      ),
      { triggeredBy: "idle", runId: "run-1" },
    );

    expect(retained(memory)).toEqual([
      expect.objectContaining({
        content: HOMELAB_FACT.fact,
        documentId: `observer:turn:${cursor}:0`,
        tags: ["network:world", "compartment:technical", "trust:first-party"],
      }),
    ]);
  });

  it("sends a later fire's memory extraction the turn it hasn't read, with the earlier one as context only", async () => {
    const seeded = await seedConversation();
    const event = { data: { conversationId: seeded.conversationId } };
    await seedTurn(seeded, "Tell me about Lisbon.", "Lisbon is a city of seven hills.");
    await seedTurn(seeded, "And Porto?", "Porto sits on the Douro.");
    await runObserver(event, syncStep, deps(scriptedProvider([])), {
      triggeredBy: "idle",
      runId: "run-1",
    });
    await seedTurn(seeded, "And Braga?", "Braga is the oldest city.");
    const provider = scriptedProvider([]);

    await runObserver(event, syncStep, deps(provider), { triggeredBy: "idle", runId: "run-2" });

    expect(memoryMessages(provider)).toEqual([
      "<earlier_conversation>\nUser: And Porto?\n\nAssistant: Porto sits on the Douro.\n</earlier_conversation>\n\n<turn>\nUser: And Braga?\n\nAssistant: Braga is the oldest city.\n</turn>",
    ]);
  });

  it("drops a fact whose evidence only the context turn holds", async () => {
    const seeded = await seedConversation();
    const event = { data: { conversationId: seeded.conversationId } };
    await seedTurn(seeded, "My homelab IP is 10.0.10.10.", "Noted.");
    await runObserver(event, syncStep, deps(scriptedProvider([])), {
      triggeredBy: "idle",
      runId: "run-1",
    });
    await seedTurn(seeded, "Thanks.", "You're welcome.");
    const memory = { retainBatch: vi.fn().mockResolvedValue(undefined) };

    // The model reads the earlier turn as new and reports its fact again.
    await runObserver(
      event,
      syncStep,
      deps(
        scriptedProvider([], () => [HOMELAB_FACT]),
        memory,
      ),
      { triggeredBy: "idle", runId: "run-2" },
    );

    expect(retained(memory)).toEqual([]);
  });
});
