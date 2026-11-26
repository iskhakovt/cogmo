/**
 * The Observer under Inngest's replay model, against PGlite: a turn's step
 * re-run after its apply committed or its extraction was stored, a memoized
 * turn outcome, a run of the transcript-era build resumed by this one
 * (design/observation.md → Slices 1a and 2a, Failure modes), and two fires on
 * one turn. Steps are memoized with `@inngest/test`'s `steps:`.
 */

import { randomUUID } from "node:crypto";
import { InngestTestEngine } from "@inngest/test";
import { eq } from "drizzle-orm";
import { StepError } from "inngest";
import { errors } from "inngest/internals";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { RefusalError } from "../../llm/fallback.js";
import type { LlmProvider } from "../../llm/provider.js";
import type { ChatParams, LlmResponse } from "../../llm/types.js";
import type { MemoryProvider, RetainBatchItem } from "../../memory/provider.js";
import { expectDefined, expectOk } from "../../test/assertions.js";
import { mockProvider, mockResolver, mockTransportStore } from "../../test/factories.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { type AgentStore, DrizzleAgentStore } from "../store/index.js";
import { evolutionEvents, messages, steeringRules, turnObservations } from "../store/schema.js";
import { NO_CORRECTIONS } from "./extract-corrections.js";
import { discoverTurns } from "./observation/discover-turns.js";
import type { StoredMemory } from "./observation/turn-extraction.js";
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

/** A fact the first seeded turn states. */
const LISBON_FACT: StoredMemory = {
  fact: "Lisbon is a city of seven hills",
  network: "world",
  compartment: "misc",
  trust: "any",
  evidence: "Lisbon is a city of seven hills",
};

/**
 * Reinforces the first listed rule from every turn, and states `LISBON_FACT`
 * for the turn that holds it; answers every other prompt with nothing.
 */
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
          ? { memories: observedTurn(params).includes(LISBON_FACT.evidence) ? [LISBON_FACT] : [] }
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

/** The `<turn>` element of an extraction's message. */
function observedTurn(params: ChatParams): string {
  const message = params.messages.flatMap((m) =>
    typeof m.content === "string" ? [m.content] : [],
  );
  return /<turn>\n([\s\S]*)\n<\/turn>/.exec(message[0] ?? "")?.[1] ?? "";
}

function correctionCalls(provider: LlmProvider): number {
  return vi
    .mocked(provider.chat)
    .mock.calls.filter(([p]) => p.system.includes("behavioral correction extractor")).length;
}

function memoryCalls(provider: LlmProvider): number {
  return vi
    .mocked(provider.chat)
    .mock.calls.filter(([p]) => p.system.includes("memory extraction engine")).length;
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

function deps(
  provider: LlmProvider,
  opts: { agentStore?: AgentStore; memory?: Pick<MemoryProvider, "retainBatch"> } = {},
): ObserverDeps {
  return {
    runInTx: tx,
    agentStore: opts.agentStore ?? store,
    transportStore: mockTransportStore(),
    resolveProvider: mockResolver(provider),
    memory: opts.memory ?? { retainBatch: vi.fn().mockResolvedValue(undefined) },
  };
}

/** The memories rows, with what the walk left on them. */
async function memoryRows() {
  return db
    .select({
      id: turnObservations.id,
      status: turnObservations.status,
      attempts: turnObservations.attempts,
      failureKind: turnObservations.failureKind,
      extraction: turnObservations.extraction,
    })
    .from(turnObservations)
    .where(eq(turnObservations.phase, "memories"));
}

async function memoryRow(id: string) {
  return expectDefined(
    (await memoryRows()).find((r) => r.id === id),
    id,
  );
}

/** Store the first turn's extraction, as a step that committed it and then died left it. */
async function storeLisbonExtraction(
  conversationId: string,
): Promise<{ observationId: string; cursor: string }> {
  const plan = await discoverTurns(
    { runInTx: tx, store },
    { conversationId, phase: "memories", limit: 10 },
  );
  const first = expectDefined(plan.turns[0], "first turn");
  const conversation = expectDefined(
    await tx((trx) => store.getConversation(trx, conversationId)),
    "conversation",
  );
  await tx((trx) =>
    store.transitionPendingTurn(trx, {
      id: first.observationId,
      to: {
        status: "extracted",
        extraction: {
          phase: "memories",
          runId: "run-dead",
          profileId: conversation.profileId,
          profileClass: null,
          seesUserRules: true,
          items: [LISBON_FACT],
          dropped: { noEvidence: 0 },
        },
      },
    }),
  );
  return first;
}

/** The harness the SDK is to the walk once a step has failed for good. */
const sdkFailingStep: ObserverStepHarness = {
  async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new StepError(id, errors.serializeError(err));
    }
  },
};

async function countOf(ruleId: string): Promise<number> {
  const [row] = await db
    .select({ observationCount: steeringRules.observationCount })
    .from(steeringRules)
    .where(eq(steeringRules.id, ruleId));
  return expectDefined(row, ruleId).observationCount;
}

function engine(conversationId: string, provider: LlmProvider, steps: InngestSteps) {
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
    const plan = await discoverTurns(
      { runInTx: tx, store },
      { conversationId, phase: "corrections", limit: 10 },
    );
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
    const plan = await discoverTurns(
      { runInTx: tx, store },
      { conversationId, phase: "corrections", limit: 10 },
    );
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
    const rows = await db
      .select({ status: turnObservations.status })
      .from(turnObservations)
      .where(eq(turnObservations.phase, "corrections"));
    expect(rows.map((r) => r.status)).toEqual(["applied", "applied"]);
  });

  /**
   * A fire whose second turn's step fails for good: the real step body
   * throws, and the error reaches the walk as the SDK hands a step's failure
   * back, serialized (`errors.serializeError`) and rebuilt as a `StepError`.
   * `@inngest/test`'s mocked steps resolve a throwing handler as `undefined`,
   * so the harness applies the SDK's own serialization instead.
   */
  async function secondTurnFails(failure: "unavailable" | "database") {
    const { conversationId } = await seed();
    const plan = await discoverTurns(
      { runInTx: tx, store },
      { conversationId, phase: "corrections", limit: 10 },
    );
    const second = expectDefined(plan.turns[1], "second turn");
    const secondStep = `observe-v1-corrections-${second.observationId}`;
    const inner = reinforcingProvider();
    const provider = mockProvider({
      chat: vi.fn(async (params: ChatParams) => {
        const correcting = params.system.includes("behavioral correction extractor");
        const onSecond = params.messages.some(
          (m) => typeof m.content === "string" && m.content.includes(CORRECTION),
        );
        if (correcting && onSecond && failure === "unavailable") {
          throw Object.assign(new Error("overloaded"), { status: 529 });
        }
        return inner.chat(params);
      }),
    });
    const sdkStep: ObserverStepHarness = {
      async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
        try {
          if (id === secondStep && failure === "database") throw new Error("connection reset");
          return await fn();
        } catch (err) {
          throw new StepError(id, errors.serializeError(err));
        }
      },
    };

    await runObserver({ data: { conversationId } }, sdkStep, deps(provider), {
      triggeredBy: "idle",
      runId: "run-1",
    });

    const [row] = await db
      .select({
        status: turnObservations.status,
        attempts: turnObservations.attempts,
        failureKind: turnObservations.failureKind,
      })
      .from(turnObservations)
      .where(eq(turnObservations.id, second.observationId));
    const [audit] = await db.select({ payload: evolutionEvents.payload }).from(evolutionEvents);
    return { row, failedPhases: audit?.payload.failedPhases };
  }

  it("leaves a turn uncounted when its step failed with an unavailable extraction", async () => {
    const { row, failedPhases } = await secondTurnFails("unavailable");

    expect(row).toEqual({ status: "pending", attempts: 0, failureKind: null });
    expect(failedPhases).toEqual(["corrections"]);
  });

  it("counts a turn whose step failed with anything else", async () => {
    const { row, failedPhases } = await secondTurnFails("database");

    expect(row).toEqual({ status: "pending", attempts: 1, failureKind: "exhausted" });
    expect(failedPhases).toEqual(["corrections"]);
  });
});

describe("two fires at once", () => {
  it("writes a turn's corrections once when another fire applies it during this one's model call", async () => {
    const { conversationId, ruleId } = await seed();
    const plan = await discoverTurns(
      { runInTx: tx, store },
      { conversationId, phase: "corrections", limit: 10 },
    );
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

    const result = await runObserver({ data: { conversationId } }, syncStep, deps(provider), {
      triggeredBy: "idle",
      runId: "run-1",
    });

    expect(result).toMatchObject({ status: "processed", corrections: { reinforced: 0 } });
    expect(await countOf(ruleId)).toBe(1);
  });
});

describe("the memories phase under replay", () => {
  it("re-runs a turn's step whose extraction committed: retains the stored facts and calls no model", async () => {
    const { conversationId } = await seed();
    const { observationId, cursor } = await storeLisbonExtraction(conversationId);
    const retainBatch = vi.fn<MemoryProvider["retainBatch"]>().mockResolvedValue(undefined);
    const provider = reinforcingProvider();
    const syncStep: ObserverStepHarness = { run: (_id, fn) => fn() };

    await runObserver(
      { data: { conversationId } },
      syncStep,
      deps(provider, { memory: { retainBatch } }),
      { triggeredBy: "idle", runId: "run-1" },
    );

    expect(await memoryRow(observationId)).toMatchObject({
      status: "applied",
      extraction: { runId: "run-dead" },
    });
    expect((await memoryRows()).map((r) => r.status)).toEqual(["applied", "applied"]);
    // Only the second turn, which had no extraction, is sent to the model.
    expect(memoryCalls(provider)).toBe(1);
    expect(retainBatch).toHaveBeenCalledWith(expect.any(String), [
      expect.objectContaining({
        content: LISBON_FACT.fact,
        documentId: `observer:turn:${cursor}:0`,
      }),
    ]);
  });

  it("re-sends the same documents when the retain was acknowledged and the move to applied was lost", async () => {
    const { conversationId } = await seed();
    const sent: RetainBatchItem[][] = [];
    const memory = {
      retainBatch: vi.fn(async (_bank: string, items: RetainBatchItem[]) => {
        sent.push(items);
      }),
    };
    const provider = reinforcingProvider();
    const failingMove: AgentStore = {
      ...store,
      transitionExtractedTurn: vi.fn().mockRejectedValue(new Error("connection reset")),
    };

    await runObserver(
      { data: { conversationId } },
      sdkFailingStep,
      deps(provider, { agentStore: failingMove, memory }),
      { triggeredBy: "idle", runId: "run-1" },
    );
    await runObserver({ data: { conversationId } }, sdkFailingStep, deps(provider, { memory }), {
      triggeredBy: "idle",
      runId: "run-2",
    });

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    // The first turn's model call ran once; the second fire re-sent its stored facts.
    const lisbonCalls = vi
      .mocked(provider.chat)
      .mock.calls.filter(
        ([p]) =>
          p.system.includes("memory extraction engine") &&
          observedTurn(p).includes(LISBON_FACT.evidence),
      );
    expect(lisbonCalls).toHaveLength(1);
    // The step stored the extraction before it failed, so the plan's `pending` no longer guards the row.
    expect((await memoryRows()).map((r) => [r.status, r.attempts])).toEqual([
      ["applied", 0],
      ["applied", 0],
    ]);
  });

  it("counts a step that fails for good on an extracted row, keeping the extraction", async () => {
    const { conversationId } = await seed();
    const { observationId } = await storeLisbonExtraction(conversationId);
    const failingMove: AgentStore = {
      ...store,
      transitionExtractedTurn: vi.fn().mockRejectedValue(new Error("connection reset")),
    };

    await runObserver(
      { data: { conversationId } },
      sdkFailingStep,
      deps(reinforcingProvider(), { agentStore: failingMove }),
      { triggeredBy: "idle", runId: "run-1" },
    );

    expect(await memoryRow(observationId)).toMatchObject({
      status: "extracted",
      attempts: 1,
      failureKind: "exhausted",
      extraction: { items: [LISBON_FACT] },
    });
  });

  it("carries a run of the transcript-era build on from the database", async () => {
    const { conversationId } = await seed();
    const retainBatch = vi.fn<MemoryProvider["retainBatch"]>().mockResolvedValue(undefined);
    // What that build memoized before the deploy: its whole-transcript read and phase.
    const steps = [
      { id: "load-history", handler: () => [] },
      {
        id: "extract-memories",
        handler: () => ({ extracted: 1, byNetwork: { world: 1 }, skippedForUnseenRules: 0 }),
      },
    ];

    const { error } = await new InngestTestEngine({
      function: createObserver(deps(reinforcingProvider(), { memory: { retainBatch } })),
      events: [{ name: "conversation/idle", data: { conversationId } }],
      steps,
    }).execute();

    expect(error).toBeUndefined();
    expect((await memoryRows()).map((r) => r.status)).toEqual(["applied", "applied"]);
    expect(retainBatch).toHaveBeenCalledOnce();
  });

  it("counts nothing on a turn another run extracted while this run's call failed", async () => {
    const { conversationId } = await seed();
    const plan = await discoverTurns(
      { runInTx: tx, store },
      { conversationId, phase: "memories", limit: 10 },
    );
    const contested = expectDefined(plan.turns[0], "the first turn");
    const conversation = expectDefined(
      await tx((trx) => store.getConversation(trx, conversationId)),
      "conversation",
    );
    // While this run waits on the model, the other run stores the turn's
    // extraction; this run's call then fails in a way that ends a turn.
    const provider = mockProvider({
      chat: vi.fn(async (params: ChatParams) => {
        if (params.system.includes("memory extraction engine")) {
          await tx((trx) =>
            store.transitionPendingTurn(trx, {
              id: contested.observationId,
              to: {
                status: "extracted",
                extraction: {
                  phase: "memories",
                  runId: "run-other",
                  profileId: conversation.profileId,
                  profileClass: null,
                  seesUserRules: true,
                  items: [LISBON_FACT],
                  dropped: { noEvidence: 0 },
                },
              },
            }),
          );
          throw new RefusalError("refused");
        }
        return reinforcingProvider().chat(params);
      }),
    });
    const syncStep: ObserverStepHarness = { run: (_id, fn) => fn() };

    await runObserver({ data: { conversationId } }, syncStep, deps(provider), {
      triggeredBy: "idle",
      runId: "run-1",
    });

    expect(await memoryRow(contested.observationId)).toMatchObject({
      status: "extracted",
      attempts: 0,
      failureKind: null,
      extraction: { runId: "run-other" },
    });
  });

  it("replays a memoized memories plan and turn outcomes into the audit row, calling no model", async () => {
    const { conversationId } = await seed();
    const plan = await discoverTurns(
      { runInTx: tx, store },
      { conversationId, phase: "memories", limit: 10 },
    );
    const retainBatch = vi.fn<MemoryProvider["retainBatch"]>().mockResolvedValue(undefined);
    const provider = reinforcingProvider();
    const steps = [
      { id: "discover-memory-turns", handler: () => ({ ...plan, released: 0 }) },
      ...plan.turns.map((t) => ({
        id: `observe-v1-memories-${t.observationId}`,
        handler: () => ({ kind: "applied", byNetwork: { world: 2 }, droppedNoEvidence: 0 }),
      })),
    ];

    const { error } = await new InngestTestEngine({
      function: createObserver(deps(provider, { memory: { retainBatch } })),
      events: [{ name: "conversation/idle", data: { conversationId } }],
      steps,
    }).execute();

    expect(error).toBeUndefined();
    expect(memoryCalls(provider)).toBe(0);
    expect(retainBatch).not.toHaveBeenCalled();
    const [audit] = await db.select({ payload: evolutionEvents.payload }).from(evolutionEvents);
    expect(audit?.payload.memories).toEqual({
      extracted: 2 * plan.turns.length,
      byNetwork: { world: 2 * plan.turns.length },
      skippedForUnseenRules: 0,
    });
  });

  it("plans a released turn on the next fire when discovery fails after the release committed", async () => {
    const { conversationId } = await seed();
    const plan = await discoverTurns(
      { runInTx: tx, store },
      { conversationId, phase: "memories", limit: 10 },
    );
    const first = expectDefined(plan.turns[0], "first turn");
    await tx((trx) =>
      store.transitionPendingTurn(trx, { id: first.observationId, to: { status: "held" } }),
    );
    const failingDiscovery: AgentStore = {
      ...store,
      listUndiscoveredTurns: vi.fn(async (trx, params) => {
        if (params.phase === "memories") throw new Error("connection reset");
        return store.listUndiscoveredTurns(trx, params);
      }),
    };

    await runObserver(
      { data: { conversationId } },
      sdkFailingStep,
      deps(reinforcingProvider(), { agentStore: failingDiscovery }),
      { triggeredBy: "idle", runId: "run-1" },
    );
    // The release committed before discovery failed.
    expect(await memoryRow(first.observationId)).toMatchObject({ status: "pending" });

    await runObserver({ data: { conversationId } }, sdkFailingStep, deps(reinforcingProvider()), {
      triggeredBy: "idle",
      runId: "run-2",
    });

    expect(await memoryRow(first.observationId)).toMatchObject({ status: "applied" });
  });
});
