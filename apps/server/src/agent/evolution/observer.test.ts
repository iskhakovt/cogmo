import { randomUUID } from "node:crypto";
import { InngestTestEngine } from "@inngest/test";
import { StepError } from "inngest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import type { LlmProvider } from "../../llm/provider.js";
import type { ChatParams, LlmResponse, Message } from "../../llm/types.js";
import { logger } from "../../logger.js";
import type { MemoryProvider, RetainBatchItem } from "../../memory/provider.js";
import { expectDefined } from "../../test/assertions.js";
import {
  mockAgentStore,
  mockProvider,
  mockResolver,
  mockTransportStore,
} from "../../test/factories.js";
import type { AgentStore, MemoryRule, PendingMemory } from "../store/index.js";
import {
  createObserver,
  type ObserverDeps,
  type ObserverStepHarness,
  runObserver,
} from "./observer.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const HISTORY: Message[] = [
  { role: "user", content: "Search for the weather" },
  { role: "assistant", content: "It is sunny." },
  { role: "user", content: "I live in Berlin, by the way." },
  { role: "assistant", content: "Noted." },
];

const PENDING: PendingMemory[] = [
  {
    id: "pending-1",
    content: "Prefers tea over coffee",
    context: null,
    source: "live_retain",
    profileId: "profile-1",
    profileClass: null,
    skillName: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
  },
];

const RULES = [
  {
    id: "rule-a",
    rule: "Be concise",
    category: "style",
    active: true,
    observationCount: 2,
    priority: 100,
    channelType: null,
  },
  {
    id: "rule-b",
    rule: "Keep replies short",
    category: "style",
    active: true,
    observationCount: 3,
    priority: 100,
    channelType: null,
  },
];

/** The payloads each Observer prompt answers with; a function throws instead. */
interface Answers {
  corrections: unknown;
  consolidation: unknown;
  memories: unknown;
  classification: unknown;
}

const VALID_ANSWERS: Answers = {
  corrections: { corrections: [] },
  consolidation: { groups: [] },
  memories: {
    memories: [
      { fact: "Lives in Berlin", network: "bank", compartment: "personal", trust: "first-party" },
    ],
  },
  classification: { network: "bank", compartment: "personal", trust: "first-party" },
};

/** Routes each structured-output call to its answer by the system prompt. */
function routedProvider(overrides: Partial<Answers> = {}): LlmProvider {
  const answers = { ...VALID_ANSWERS, ...overrides };
  return mockProvider({
    chat: vi.fn(async (params: ChatParams): Promise<LlmResponse> => {
      const answer = params.system.includes("behavioral correction extractor")
        ? answers.corrections
        : params.system.includes("rule consolidation assistant")
          ? answers.consolidation
          : params.system.includes("memory extraction engine")
            ? answers.memories
            : answers.classification;
      return {
        content: [{ type: "text", text: JSON.stringify(answer) }],
        stopReason: "end_turn",
        model: "mock",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
  });
}

/**
 * A correction the schema cannot accept on any retry: a reinforcement has to
 * name the rule it reinforces.
 */
const UNPARSEABLE_CORRECTIONS = {
  corrections: [{ rule: "Be concise", category: "style", reasoning: "again", action: "reinforce" }],
};

/**
 * What the Inngest SDK does once a step has used up its retries: the body's
 * failure reaches the function as a `StepError`. Records every step id so a
 * test can compare the plan of two runs.
 */
function exhaustedRetriesStep(): ObserverStepHarness & { ids: string[] } {
  const ids: string[] = [];
  return {
    ids,
    async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
      ids.push(id);
      try {
        return await fn();
      } catch (err) {
        throw new StepError(id, err);
      }
    },
  };
}

/** Keeps one document per id, as Hindsight does; an item without one gets a fresh id, as the adapter mints. */
function documentBank(): {
  memory: Pick<MemoryProvider, "retainBatch">;
  documents: Map<string, RetainBatchItem>;
} {
  const documents = new Map<string, RetainBatchItem>();
  return {
    documents,
    memory: {
      retainBatch: vi.fn(async (_bankId: string, items: RetainBatchItem[]) => {
        for (const item of items) documents.set(item.documentId ?? randomUUID(), item);
      }),
    },
  };
}

/** The `/reflect` harness: no retries, a body's error reaches the caller as is. */
const syncStep: ObserverStepHarness = { run: (_id, fn) => fn() };

function observerDeps(opts: {
  provider: LlmProvider;
  store?: Partial<AgentStore>;
  memory?: Pick<MemoryProvider, "retainBatch">;
}): ObserverDeps & { agentStore: AgentStore; memory: Pick<MemoryProvider, "retainBatch"> } {
  return {
    runInTx: fakeRunInTx,
    agentStore: mockAgentStore({
      listMessages: vi.fn().mockResolvedValue(HISTORY),
      getPendingMemories: vi.fn().mockResolvedValue(PENDING),
      ...opts.store,
    }),
    transportStore: mockTransportStore(),
    resolveProvider: mockResolver(opts.provider),
    memory: opts.memory ?? { retainBatch: vi.fn().mockResolvedValue(undefined) },
  };
}

const EVENT = { data: { conversationId: "conv-1" } };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function recordedPayload(deps: { agentStore: AgentStore }): unknown {
  const call = expectDefined(
    vi.mocked(deps.agentStore.recordEvolutionEvent).mock.calls[0],
    "recordEvolutionEvent call",
  );
  return call[1].payload;
}

describe("runObserver phase isolation", () => {
  it("extracts memories and drains pending rows when correction extraction fails", async () => {
    const deps = observerDeps({
      provider: routedProvider({ corrections: UNPARSEABLE_CORRECTIONS }),
    });
    const warn = vi.spyOn(logger, "warn");

    const result = await runObserver(EVENT, exhaustedRetriesStep(), deps);

    expect(result).toMatchObject({
      status: "processed",
      corrections: { extracted: 0, reinforced: 0, consolidationNeeded: false },
      memories: { extracted: 1 },
      drained: { drained: 1 },
    });
    expect(deps.memory.retainBatch).toHaveBeenCalledTimes(2);
    expect(deps.agentStore.deletePendingMemories).toHaveBeenCalledWith(expect.anything(), [
      "pending-1",
    ]);
    expect(deps.agentStore.recordEvolutionEvent).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-1",
        phase: "corrections",
        stepId: "extract-corrections",
        err: expect.any(StepError),
      }),
      expect.stringContaining("observer"),
    );
  });

  it("plans the same steps whether or not correction extraction fails", async () => {
    const clean = exhaustedRetriesStep();
    await runObserver(EVENT, clean, observerDeps({ provider: routedProvider() }));
    const failing = exhaustedRetriesStep();
    await runObserver(
      EVENT,
      failing,
      observerDeps({ provider: routedProvider({ corrections: UNPARSEABLE_CORRECTIONS }) }),
    );

    expect(failing.ids).toEqual(clean.ids);
    expect(clean.ids).toEqual([
      "record-start-time",
      "load-conversation",
      "load-profile",
      "load-history",
      "load-custom-compartments",
      "load-active-channel-types",
      "extract-corrections",
      "extract-memories",
      "load-pending-memories",
      "classify-pending-memories",
      "retain-pending-memories",
      "delete-pending-memories",
      "persist-evolution-event",
    ]);
  });

  it("keeps the correction result and extracts memories when consolidation fails", async () => {
    const deps = observerDeps({
      provider: routedProvider({ consolidation: { groups: "not-an-array" } }),
      store: {
        getCorrections: vi.fn().mockResolvedValue(RULES),
        countActiveLearnedRules: vi.fn().mockResolvedValue(21),
      },
    });

    const result = await runObserver(EVENT, exhaustedRetriesStep(), deps);

    expect(result).toMatchObject({
      status: "processed",
      corrections: { consolidationNeeded: true },
      consolidation: null,
      memories: { extracted: 1 },
      drained: { drained: 1 },
    });
    expect(deps.agentStore.replaceRules).not.toHaveBeenCalled();
  });

  it("drains pending rows when memory extraction fails", async () => {
    const retainBatch = vi
      .fn<MemoryProvider["retainBatch"]>()
      .mockRejectedValueOnce(new Error("hindsight unavailable"))
      .mockResolvedValue(undefined);
    const deps = observerDeps({ provider: routedProvider(), memory: { retainBatch } });

    const result = await runObserver(EVENT, exhaustedRetriesStep(), deps);

    expect(result).toMatchObject({
      status: "processed",
      memories: { extracted: 0, byNetwork: {} },
      drained: { drained: 1 },
    });
    expect(retainBatch).toHaveBeenCalledTimes(2);
    expect(deps.agentStore.deletePendingMemories).toHaveBeenCalledOnce();
  });

  it("records the fire and leaves the rows pending when the drain's retain fails", async () => {
    const retainBatch = vi
      .fn<MemoryProvider["retainBatch"]>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("hindsight unavailable"));
    const deps = observerDeps({ provider: routedProvider(), memory: { retainBatch } });

    const result = await runObserver(EVENT, exhaustedRetriesStep(), deps);

    expect(result).toMatchObject({
      status: "processed",
      memories: { extracted: 1 },
      drained: { drained: 0, byNetwork: {} },
    });
    expect(deps.agentStore.deletePendingMemories).not.toHaveBeenCalled();
    expect(deps.agentStore.recordEvolutionEvent).toHaveBeenCalledOnce();
  });

  it("keeps one copy of a staged row when the drain's delete fails for good", async () => {
    const bank = documentBank();
    const deletePendingMemories = vi
      .fn<AgentStore["deletePendingMemories"]>()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValue(undefined);
    const deps = observerDeps({
      provider: routedProvider(),
      memory: bank.memory,
      store: { deletePendingMemories },
    });

    const first = await runObserver(EVENT, exhaustedRetriesStep(), deps);
    const second = await runObserver(EVENT, exhaustedRetriesStep(), deps);

    expect(first).toMatchObject({ drained: { drained: 0 } });
    expect(second).toMatchObject({ drained: { drained: 1 } });
    const staged = [...bank.documents.values()].filter(
      (d) => d.content === "Prefers tea over coffee",
    );
    expect(staged).toHaveLength(1);
  });

  it("propagates a failure that did not come from a step with exhausted retries", async () => {
    // `/reflect` runs the Observer through a harness with no retries; its
    // caller surfaces the error to the user instead of reporting zeros.
    const deps = observerDeps({
      provider: routedProvider({ corrections: UNPARSEABLE_CORRECTIONS }),
    });

    await expect(runObserver(EVENT, syncStep, deps)).rejects.toThrow(/matchedExistingRuleId/);
    expect(deps.memory.retainBatch).not.toHaveBeenCalled();
  });
});

describe("runObserver phase outcomes", () => {
  it("records no failed phase on a fire where every phase completes", async () => {
    const deps = observerDeps({ provider: routedProvider() });

    const result = await runObserver(EVENT, exhaustedRetriesStep(), deps);

    expect(result).toMatchObject({ status: "processed", failedPhases: [] });
    expect(recordedPayload(deps)).toMatchObject({ failedPhases: [] });
  });

  it("records a failed correction extraction", async () => {
    const deps = observerDeps({
      provider: routedProvider({ corrections: UNPARSEABLE_CORRECTIONS }),
    });

    const result = await runObserver(EVENT, exhaustedRetriesStep(), deps);

    expect(result).toMatchObject({ failedPhases: ["corrections"] });
    expect(recordedPayload(deps)).toMatchObject({ failedPhases: ["corrections"] });
  });

  it("records each later phase that fails, in run order", async () => {
    const retainBatch = vi
      .fn<MemoryProvider["retainBatch"]>()
      .mockRejectedValueOnce(new Error("hindsight unavailable"))
      .mockResolvedValue(undefined);
    const deps = observerDeps({
      provider: routedProvider({ consolidation: { groups: "not-an-array" } }),
      store: {
        getCorrections: vi.fn().mockResolvedValue(RULES),
        countActiveLearnedRules: vi.fn().mockResolvedValue(21),
        deletePendingMemories: vi.fn().mockRejectedValue(new Error("connection reset")),
      },
      memory: { retainBatch },
    });

    const result = await runObserver(EVENT, exhaustedRetriesStep(), deps);

    expect(result).toMatchObject({
      corrections: { consolidationNeeded: true },
      failedPhases: ["consolidation", "memories", "drain"],
    });
    expect(recordedPayload(deps)).toMatchObject({
      failedPhases: ["consolidation", "memories", "drain"],
    });
  });
});

describe("runObserver rules", () => {
  const HEALTH_RULE = "Don't save anything about my health.";
  const USER_HEALTH_RULE: MemoryRule = { rule: HEALTH_RULE, profileId: null, fromUser: true };

  function promptsOf(provider: LlmProvider, marker: string): string[] {
    return vi
      .mocked(provider.chat)
      .mock.calls.map(([params]) => params.system)
      .filter((system) => system.includes(marker));
  }

  /** The default profile, made third-party: its trust admits no first-party memory. */
  function thirdPartyProfile() {
    return vi.fn(async (tx: Parameters<AgentStore["getProfile"]>[0], id: string) => {
      const profile = expectDefined(await mockAgentStore().getProfile(tx, id), "profile");
      return { ...profile, memoryScope: { compartments: ["misc"], trust: ["any" as const] } };
    });
  }

  it("reads the instruction rules of the conversation's user for correction extraction", async () => {
    const deps = observerDeps({ provider: routedProvider() });

    await runObserver(EVENT, exhaustedRetriesStep(), deps);

    expect(deps.agentStore.getInstructionRules).toHaveBeenCalledWith(expect.anything(), {
      profileId: "profile-1",
      userId: "user-1",
      seesUserRules: true,
    });
  });

  it("extracts memories under the memory rules the conversation's profile sees", async () => {
    const provider = routedProvider();
    const deps = observerDeps({
      provider,
      store: { getMemoryRules: vi.fn().mockResolvedValue([USER_HEALTH_RULE]) },
    });

    await runObserver(EVENT, exhaustedRetriesStep(), deps);

    expect(deps.agentStore.getMemoryRules).toHaveBeenCalledWith(expect.anything(), {
      profileIds: ["profile-1"],
      userId: "user-1",
    });
    const [extraction] = promptsOf(provider, "memory extraction engine");
    expect(extraction).toContain(`- ${HEALTH_RULE}`);
  });

  it("shows a third-party profile's model none of the user's rules, and stores nothing they bind", async () => {
    const provider = routedProvider({
      classification: { network: "bank", compartment: "health", trust: "first-party" },
    });
    const deps = observerDeps({
      provider,
      store: {
        getProfile: thirdPartyProfile(),
        getInstructionRules: vi
          .fn()
          .mockResolvedValue([{ ...RULES[0], id: "mine", rule: "No bullet points" }]),
        getMemoryRules: vi.fn().mockResolvedValue([USER_HEALTH_RULE]),
      },
    });

    const result = await runObserver(EVENT, exhaustedRetriesStep(), deps);

    expect(deps.agentStore.getInstructionRules).not.toHaveBeenCalled();
    const prompts = vi.mocked(provider.chat).mock.calls.map(([params]) => params.system);
    expect(prompts.join("\n")).not.toContain(HEALTH_RULE);
    expect(prompts.join("\n")).not.toContain("No bullet points");
    expect(promptsOf(provider, "memory extraction engine")).toEqual([]);
    expect(deps.memory.retainBatch).not.toHaveBeenCalled();
    expect(deps.agentStore.deletePendingMemories).not.toHaveBeenCalled();
    const deferral = {
      memories: { extracted: 0, skippedForUnseenRules: 1 },
      drained: { drained: 0, withheld: 0, deferredForUnseenRules: 1 },
    };
    expect(result).toMatchObject(deferral);
    expect(recordedPayload(deps)).toMatchObject(deferral);
  });

  it("records no deferral on a first-party fire", async () => {
    const deps = observerDeps({
      provider: routedProvider(),
      store: { getMemoryRules: vi.fn().mockResolvedValue([USER_HEALTH_RULE]) },
    });

    await runObserver(EVENT, exhaustedRetriesStep(), deps);

    expect(recordedPayload(deps)).toMatchObject({
      memories: { skippedForUnseenRules: 0 },
      drained: { deferredForUnseenRules: 0 },
    });
  });

  it("withholds a staged row a memory rule forbids, deleting it unretained and counting it", async () => {
    const deps = observerDeps({
      provider: routedProvider({
        classification: {
          network: "bank",
          compartment: "health",
          trust: "first-party",
          withhold: true,
        },
      }),
      store: { getMemoryRules: vi.fn().mockResolvedValue([USER_HEALTH_RULE]) },
    });
    const step = exhaustedRetriesStep();

    const result = await runObserver(EVENT, step, deps);

    expect(result).toMatchObject({ drained: { drained: 0, byNetwork: {}, withheld: 1 } });
    expect(step.ids).not.toContain("retain-pending-memories");
    expect(deps.memory.retainBatch).toHaveBeenCalledOnce();
    expect(deps.agentStore.deletePendingMemories).toHaveBeenCalledWith(expect.anything(), [
      "pending-1",
    ]);
    expect(recordedPayload(deps)).toMatchObject({ drained: { drained: 0, withheld: 1 } });
  });

  it("finishes the drain from a classification memoized without `withheld`", async () => {
    const memoized = {
      successful: [
        {
          id: "pending-1",
          content: "Prefers tea over coffee",
          context: null,
          source: "live_retain",
          profileClass: null,
          skillName: null,
          tags: { network: "bank", compartment: "personal", trust: "first-party" },
        },
      ],
      byNetwork: { bank: 1 },
    };
    const step: ObserverStepHarness = {
      run: (id, fn) =>
        // The step result as an earlier deploy memoized it.
        id === "classify-pending-memories" ? Promise.resolve(memoized as never) : fn(),
    };
    const deps = observerDeps({ provider: routedProvider() });

    const result = await runObserver(EVENT, step, deps);

    expect(result).toMatchObject({ drained: { drained: 1, withheld: 0 } });
    expect(deps.agentStore.deletePendingMemories).toHaveBeenCalledWith(expect.anything(), [
      "pending-1",
    ]);
  });
});

describe("createObserver duration", () => {
  it("records the whole fire's duration, though every step boundary re-invokes the body", async () => {
    const callMs = 30_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T12:00:00Z"));
    const routed = routedProvider();
    const chat = vi.fn(async (params: ChatParams) => {
      vi.setSystemTime(Date.now() + callMs);
      return routed.chat(params);
    });
    const deps = observerDeps({ provider: { ...routed, chat } });

    await new InngestTestEngine({
      function: createObserver(deps),
      events: [{ name: "conversation/idle", data: { conversationId: "conv-1" } }],
    }).execute();

    expect(chat).toHaveBeenCalled();
    expect(recordedPayload(deps)).toMatchObject({ durationMs: chat.mock.calls.length * callMs });
  });
});
