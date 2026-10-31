/**
 * The Observer under Inngest's replay model, against PGlite: a turn's step
 * re-run after its apply committed, a memoized turn outcome, and a run of the
 * transcript-era build resumed by this one (design/observation.md → Slice 1a,
 * Failure modes), and two fires on one turn. Steps are memoized with
 * `@inngest/test`'s `steps:`.
 */

import { randomUUID } from "node:crypto";
import { InngestTestEngine } from "@inngest/test";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import type { LlmProvider } from "../../llm/provider.js";
import type { ChatParams, LlmResponse } from "../../llm/types.js";
import { expectDefined, expectOk } from "../../test/assertions.js";
import { mockProvider, mockResolver, mockTransportStore } from "../../test/factories.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleAgentStore } from "../store/index.js";
import { evolutionEvents, messages, steeringRules, turnObservations } from "../store/schema.js";
import { NO_CORRECTIONS } from "./extract-corrections.js";
import { discoverTurns } from "./observation/discover-turns.js";
import {
  createObserver,
  type ObserverDeps,
  type ObserverStepHarness,
  runObserver,
} from "./observer.js";

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

const CORRECTION = "Shorter please, you're far too verbose.";

/** Reinforces the first listed rule from every turn; answers every other prompt with nothing. */
function reinforcingProvider(): LlmProvider {
  return mockProvider({
    chat: vi.fn(async (params: ChatParams): Promise<LlmResponse> => {
      const answer = params.system.includes("behavioral correction extractor")
        ? {
            corrections: [
              {
                action: "reinforce",
                matchedExistingRuleId: "R1",
                rule: "Be concise",
                category: "style",
                reasoning: "shorter replies",
                evidence: "Shorter please",
              },
            ],
          }
        : params.system.includes("memory extraction engine")
          ? { memories: [] }
          : { groups: [] };
      return {
        content: [{ type: "text", text: JSON.stringify(answer) }],
        stopReason: "end_turn",
        model: "mock",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }),
  });
}

function correctionCalls(provider: LlmProvider): number {
  return vi
    .mocked(provider.chat)
    .mock.calls.filter(([p]) => p.system.includes("behavioral correction extractor")).length;
}

/** A conversation with two answered turns, the second carrying the correction, and a rule still learning. */
async function seed(): Promise<{ conversationId: string; ruleId: string }> {
  const { conversationId, profileId } = await tx(async (trx) => {
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
    const conv = await store.createConversation(trx, {
      userId: user.id,
      profileId: profile.id,
      isPrivate: true,
    });
    return { conversationId: conv.id, profileId: profile.id };
  });
  const turns = [
    ["Tell me about Lisbon.", "Lisbon is a city of seven hills, and ..."],
    [CORRECTION, "Hills, trams, tarts."],
  ] as const;
  for (const [said, reply] of turns) {
    const cursor = randomUUID();
    for (const [role, text] of [
      ["user", said],
      ["assistant", reply],
    ] as const) {
      await db.insert(messages).values({
        conversationId,
        role,
        content: [{ type: "text", text }],
        profileId,
        model: "m",
        lastInboundMessageId: cursor,
        firstInboundMessageId: null,
        outputTokens: -1,
      });
    }
  }
  const [rule] = await db
    .insert(steeringRules)
    .values({
      rule: "Be concise",
      category: "style",
      status: "learning",
      source: "correction",
      priority: 100,
      observationCount: 0,
      profileId: null,
      channelType: null,
    })
    .returning({ id: steeringRules.id });
  return { conversationId, ruleId: expectDefined(rule, "rule").id };
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

async function countOf(ruleId: string): Promise<number> {
  const [row] = await db
    .select({ observationCount: steeringRules.observationCount })
    .from(steeringRules)
    .where(eq(steeringRules.id, ruleId));
  return expectDefined(row, ruleId).observationCount;
}

function engine(conversationId: string, provider: LlmProvider, steps: InngestSteps = []) {
  return new InngestTestEngine({
    function: createObserver(deps(provider)),
    events: [{ name: "conversation/idle", data: { conversationId } }],
    steps,
  });
}
type InngestSteps = Array<{ id: string; handler: () => unknown }>;

describe("createObserver under replay", () => {
  it("re-runs a turn's step whose apply committed without calling the model or writing again", async () => {
    const { conversationId, ruleId } = await seed();
    const plan = await discoverTurns({ runInTx: tx, store }, { conversationId, limit: 10 });
    const memoizedPlan = [{ id: "discover-turns", handler: () => plan }];
    const first = reinforcingProvider();
    await engine(conversationId, first, memoizedPlan).execute();
    expect(await countOf(ruleId)).toBe(1);

    // The step's result was never recorded, so Inngest runs its body again.
    const retry = reinforcingProvider();
    const { error } = await engine(conversationId, retry, memoizedPlan).execute();

    expect(error).toBeUndefined();
    expect(correctionCalls(retry)).toBe(0);
    expect(await countOf(ruleId)).toBe(1);
  });

  it("replays a memoized turn outcome into the audit row, calling no model", async () => {
    const { conversationId, ruleId } = await seed();
    const plan = await discoverTurns({ runInTx: tx, store }, { conversationId, limit: 10 });
    const provider = reinforcingProvider();
    const steps = [
      { id: "discover-turns", handler: () => plan },
      ...plan.turns.map((t) => ({
        id: `observe-v1-corrections-${t.observationId}`,
        handler: () => ({
          kind: "applied",
          result: { ...NO_CORRECTIONS, reinforced: 1 },
          droppedNoEvidence: 0,
        }),
      })),
    ];

    await engine(conversationId, provider, steps).execute();

    expect(correctionCalls(provider)).toBe(0);
    expect(await countOf(ruleId)).toBe(0);
    const [audit] = await db.select({ payload: evolutionEvents.payload }).from(evolutionEvents);
    expect(audit?.payload.corrections.reinforced).toBe(plan.turns.length);
  });

  it("carries a run of the transcript-era build on from the database", async () => {
    const { conversationId, ruleId } = await seed();
    const provider = reinforcingProvider();
    // What that build memoized before the deploy: its whole-transcript phase.
    const steps = [
      { id: "extract-corrections", handler: () => ({ ...NO_CORRECTIONS, reinforced: 1 }) },
    ];

    const { error } = await engine(conversationId, provider, steps).execute();

    expect(error).toBeUndefined();
    expect(await countOf(ruleId)).toBe(1);
    const rows = await db.select({ status: turnObservations.status }).from(turnObservations);
    expect(rows.map((r) => r.status)).toEqual(["applied", "applied"]);
  });
});

describe("two fires at once", () => {
  it("writes a turn's corrections once when another fire applies it during this one's model call", async () => {
    const { conversationId, ruleId } = await seed();
    const plan = await discoverTurns({ runInTx: tx, store }, { conversationId, limit: 10 });
    const contested = expectDefined(plan.turns[1], "the correcting turn");
    const inner = reinforcingProvider();
    // While this fire waits on the model, the other fire applies the turn
    // with the same reinforcement.
    const provider = mockProvider({
      chat: vi.fn(async (params: ChatParams) => {
        const correcting =
          params.system.includes("behavioral correction extractor") &&
          params.messages.some(
            (m) => typeof m.content === "string" && m.content.includes(CORRECTION),
          );
        if (correcting) {
          await tx(async (trx) => {
            await store.transitionPendingTurn(trx, {
              id: contested.observationId,
              to: { status: "applied" },
            });
            await store.upsertCorrection(trx, {
              rule: "Be concise",
              category: "style",
              profileId: null,
              existingRuleId: ruleId,
            });
          });
        }
        return inner.chat(params);
      }),
    });
    const syncStep: ObserverStepHarness = { run: (_id, fn) => fn() };

    const result = await runObserver(
      { data: { conversationId } },
      syncStep,
      deps(provider),
      "idle",
    );

    expect(result).toMatchObject({ status: "processed", corrections: { reinforced: 0 } });
    expect(await countOf(ruleId)).toBe(1);
  });
});
