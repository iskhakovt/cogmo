import { StepError } from "inngest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import type { LlmProvider } from "../../llm/provider.js";
import type { ChatParams, LlmResponse, Message } from "../../llm/types.js";
import { logger } from "../../logger.js";
import type { MemoryProvider } from "../../memory/provider.js";
import {
  mockAgentStore,
  mockProvider,
  mockResolver,
  mockTransportStore,
} from "../../test/factories.js";
import type { AgentStore, PendingMemory } from "../store/index.js";
import { type ObserverDeps, type ObserverStepHarness, runObserver } from "./observer.js";

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
    profileClass: null,
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
    channelType: null,
  },
  {
    id: "rule-b",
    rule: "Keep replies short",
    category: "style",
    active: true,
    observationCount: 3,
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
});

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
        countActiveRules: vi.fn().mockResolvedValue(31),
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
