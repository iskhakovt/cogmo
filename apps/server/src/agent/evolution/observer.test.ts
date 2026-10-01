import { randomUUID } from "node:crypto";
import { InngestTestEngine } from "@inngest/test";
import { StepError } from "inngest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import type { LlmProvider } from "../../llm/provider.js";
import { constantResolver } from "../../llm/resolver.js";
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
import type { AgentStore, MemoryRule, ObservedPhase, PendingMemory } from "../store/index.js";
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

/** A conversation's messages and cursors as the store keeps them; ids sort in insertion order. */
interface MessageLog {
  messages: Array<Message & { id: string }>;
  cursors: Record<ObservedPhase, string | null>;
  summaries: Array<{ through: string; summary: string }>;
  append(...messages: Message[]): string[];
  store: Pick<
    AgentStore,
    | "getObserverBounds"
    | "listMessagesInRange"
    | "listMessagesThrough"
    | "getLatestSummaryThrough"
    | "advanceObserverCursor"
  >;
}

function messageLog(initial: ReadonlyArray<Message>): MessageLog {
  const log: MessageLog = {
    messages: [],
    cursors: { corrections: null, memories: null },
    summaries: [],
    append: (...messages) =>
      messages.map((m) => {
        const id = `msg-${String(log.messages.length + 1).padStart(3, "0")}`;
        log.messages.push({ ...m, id });
        return id;
      }),
    store: {
      getObserverBounds: vi.fn<AgentStore["getObserverBounds"]>(async () => ({
        messageCount: log.messages.length,
        lastMessageId: log.messages.at(-1)?.id ?? null,
        observedThrough: { ...log.cursors },
      })),
      listMessagesInRange: vi.fn<AgentStore["listMessagesInRange"]>(
        async (_tx, _conversationId, { after, through }) =>
          log.messages.filter((m) => (after === null || m.id > after) && m.id <= through),
      ),
      listMessagesThrough: vi.fn<AgentStore["listMessagesThrough"]>(
        async (_tx, _conversationId, through, limit) =>
          log.messages.filter((m) => m.id <= through).slice(-limit),
      ),
      getLatestSummaryThrough: vi.fn<AgentStore["getLatestSummaryThrough"]>(
        async (_tx, conversationId, through) => {
          const [widest] = log.summaries
            .filter((x) => x.through <= through)
            .sort((a, b) => (a.through < b.through ? 1 : -1));
          return widest === undefined
            ? undefined
            : {
                id: `summary-${widest.through}`,
                conversationId,
                summary: widest.summary,
                throughMessageId: widest.through,
                messagesSummarized: 1,
                model: "m",
                source: "turn" as const,
                createdAt: new Date(),
              };
        },
      ),
      advanceObserverCursor: vi.fn<AgentStore["advanceObserverCursor"]>(
        async (_tx, { phase, through }) => {
          const cursor = log.cursors[phase];
          if (cursor !== null && cursor >= through) return false;
          log.cursors[phase] = through;
          return true;
        },
      ),
    },
  };
  log.append(...initial);
  return log;
}

/** The `/reflect` harness: no retries, a body's error reaches the caller as is. */
const syncStep: ObserverStepHarness = { run: (_id, fn) => fn() };

function observerDeps(opts: {
  provider: LlmProvider;
  store?: Partial<AgentStore>;
  memory?: Pick<MemoryProvider, "retainBatch">;
  log?: MessageLog;
  resolveProvider?: ObserverDeps["resolveProvider"];
}): ObserverDeps & { agentStore: AgentStore; memory: Pick<MemoryProvider, "retainBatch"> } {
  return {
    runInTx: fakeRunInTx,
    agentStore: mockAgentStore({
      ...(opts.log ?? messageLog(HISTORY)).store,
      getPendingMemories: vi.fn().mockResolvedValue(PENDING),
      ...opts.store,
    }),
    transportStore: mockTransportStore(),
    resolveProvider: opts.resolveProvider ?? mockResolver(opts.provider),
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
        stepId: "extract-corrections-1",
        err: expect.any(StepError),
      }),
      expect.stringContaining("observer"),
    );
  });

  it("plans the same steps whether or not correction extraction fails, short of its cursor advance", async () => {
    const clean = exhaustedRetriesStep();
    await runObserver(EVENT, clean, observerDeps({ provider: routedProvider() }));
    const failing = exhaustedRetriesStep();
    await runObserver(
      EVENT,
      failing,
      observerDeps({ provider: routedProvider({ corrections: UNPARSEABLE_CORRECTIONS }) }),
    );

    expect(failing.ids).toEqual(clean.ids.filter((id) => id !== "advance-corrections-cursor-1"));
    expect(clean.ids).toEqual([
      "record-start-time",
      "load-conversation",
      "load-profile",
      "load-observer-bounds",
      "load-custom-compartments",
      "load-active-channel-types",
      "plan-observer-chunks",
      "extract-corrections-1",
      "advance-corrections-cursor-1",
      "extract-memories-1",
      "advance-memories-cursor-1",
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

    expect(deps.agentStore.getInstructionRules).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        profileId: "profile-1",
        userId: "user-1",
        seesUserRules: true,
      }),
    );
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
      drained: { drained: 0, withheld: 0, deferredToFirstParty: 1 },
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
      drained: { deferredToFirstParty: 0 },
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

    expect(result).toMatchObject({
      drained: { drained: 1, withheld: 0, deferredToFirstParty: 0 },
    });
    expect(deps.agentStore.deletePendingMemories).toHaveBeenCalledWith(expect.anything(), [
      "pending-1",
    ]);
  });

  it("drains a batch memoized as a bare row list", async () => {
    const step: ObserverStepHarness = {
      run: (id, fn) =>
        // The step result as an earlier deploy memoized it.
        id === "load-pending-memories" ? Promise.resolve(PENDING as never) : fn(),
    };
    const deps = observerDeps({ provider: routedProvider() });

    const result = await runObserver(EVENT, step, deps);

    expect(result).toMatchObject({
      drained: { drained: 1, withheld: 0, deferredToFirstParty: 0 },
    });
  });

  it("classifies on a third-party fire only what its own profile staged", async () => {
    const own = { ...expectDefined(PENDING[0], "row"), id: "pending-own" };
    const other = { ...own, id: "pending-other", profileId: "profile-main" };
    const rows = [other, own];
    const deps = observerDeps({
      provider: routedProvider(),
      store: {
        getProfile: thirdPartyProfile(),
        getPendingMemories: vi.fn(async (_tx, _userId, _limit, filter) =>
          rows.filter((r) => filter?.stagedBy === undefined || r.profileId === filter.stagedBy),
        ),
        countPendingMemories: vi.fn(async (_tx, _userId, filter) =>
          filter?.stagedBy === undefined ? 2 : 1,
        ),
      },
    });

    const result = await runObserver(EVENT, exhaustedRetriesStep(), deps);

    expect(result).toMatchObject({
      drained: { drained: 1, withheld: 0, deferredToFirstParty: 1 },
    });
    const retained = vi.mocked(deps.memory.retainBatch).mock.calls.flatMap(([, items]) => items);
    expect(retained.map((i) => i.documentId)).toContain("pending-own");
    expect(retained.map((i) => i.documentId)).not.toContain("pending-other");
  });
});

describe("runObserver observation window", () => {
  const CORRECTIONS = "behavioral correction extractor";
  const MEMORIES = "memory extraction engine";
  const MISO: Message[] = [
    { role: "user", content: "I adopted a cat named Miso." },
    { role: "assistant", content: "Lovely!" },
  ];

  /** The user message of each extraction call made with the prompt `marker` names. */
  function userMessagesOf(provider: LlmProvider, marker: string): string[] {
    return vi
      .mocked(provider.chat)
      .mock.calls.filter(([params]) => params.system.includes(marker))
      .map(([params]) => {
        const content = expectDefined(params.messages[0], "user message").content;
        return typeof content === "string" ? content : JSON.stringify(content);
      });
  }

  /** A transcript split at `<new_messages>`: what it shows as processed, and what as new. */
  function parts(transcript: string): { earlier: string; fresh: string } {
    const at = transcript.indexOf("<new_messages>");
    return { earlier: transcript.slice(0, at), fresh: transcript.slice(at) };
  }

  class Crash extends Error {}

  /**
   * Inngest's memoization: a step whose result was recorded replays it. A
   * crash at `crash.id` ends the run after that step's body, with its result
   * recorded or not.
   */
  function replayingStep(
    recorded: Map<string, unknown>,
    crash?: { id: string; recorded: boolean },
  ): ObserverStepHarness & { ran: string[] } {
    const ran: string[] = [];
    return {
      ran,
      async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
        // The map holds what this id's body returned.
        if (recorded.has(id)) return recorded.get(id) as T;
        ran.push(id);
        const value = await fn();
        if (crash?.id === id) {
          if (crash.recorded) recorded.set(id, value);
          throw new Crash(id);
        }
        recorded.set(id, value);
        return value;
      },
    };
  }

  it("extracts only the messages after each phase's cursor, with the earlier ones as context", async () => {
    const log = messageLog(HISTORY);
    log.cursors = { corrections: "msg-004", memories: "msg-004" };
    log.append(...MISO);
    const provider = routedProvider();

    const result = await runObserver(
      EVENT,
      exhaustedRetriesStep(),
      observerDeps({ provider, log }),
    );

    for (const marker of [CORRECTIONS, MEMORIES]) {
      const [transcript] = userMessagesOf(provider, marker);
      const { earlier, fresh } = parts(expectDefined(transcript, marker));
      expect(fresh).toContain("I adopted a cat named Miso.");
      expect(fresh).not.toContain("Berlin");
      expect(earlier).toMatch(/^<earlier_conversation>\n/);
      expect(earlier).toContain("I live in Berlin, by the way.");
    }
    expect(log.cursors).toEqual({ corrections: "msg-006", memories: "msg-006" });
    expect(result).toMatchObject({ newMessages: { corrections: 2, memories: 2 } });
  });

  it("sends the widest summary ending before the chunk and the last 10 messages before it", async () => {
    const log = messageLog(
      Array.from({ length: 14 }, (_, i) => ({
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `turn-${i + 1}.`,
      })),
    );
    log.cursors = { corrections: "msg-012", memories: "msg-012" };
    log.summaries.push(
      { through: "msg-001", summary: "A narrower summary." },
      { through: "msg-002", summary: "The summary before the window." },
      { through: "msg-013", summary: "A summary reaching into the window." },
    );
    const provider = routedProvider();

    await runObserver(EVENT, exhaustedRetriesStep(), observerDeps({ provider, log }));

    for (const marker of [CORRECTIONS, MEMORIES]) {
      const { earlier, fresh } = parts(expectDefined(userMessagesOf(provider, marker)[0], marker));
      expect(earlier).toContain("<summary>\nThe summary before the window.\n</summary>");
      expect(earlier).not.toContain("reaching into the window");
      expect(earlier).not.toContain("A narrower summary.");
      for (let i = 3; i <= 12; i++) expect(earlier).toContain(`turn-${i}.`);
      expect(earlier).not.toContain("turn-2.");
      expect(fresh).toContain("turn-13.");
      expect(fresh).toContain("turn-14.");
      expect(fresh).not.toContain("turn-12.");
    }
  });

  it("skips both extractions when nothing is new, and still drains and records the fire", async () => {
    const log = messageLog(HISTORY);
    log.cursors = { corrections: "msg-004", memories: "msg-004" };
    const provider = routedProvider();
    const deps = observerDeps({ provider, log });
    const step = exhaustedRetriesStep();

    const result = await runObserver(EVENT, step, deps);

    expect(step.ids.filter((id) => /^(plan|extract|advance)-/.test(id))).toEqual([]);
    expect(userMessagesOf(provider, CORRECTIONS)).toEqual([]);
    expect(userMessagesOf(provider, MEMORIES)).toEqual([]);
    expect(result).toMatchObject({
      status: "processed",
      drained: { drained: 1 },
      newMessages: { corrections: 0, memories: 0 },
      failedPhases: [],
    });
    expect(recordedPayload(deps)).toMatchObject({
      messageCount: 4,
      newMessages: { corrections: 0, memories: 0 },
    });
  });

  it("keeps a failed phase's cursor while the other advances, and reads its whole window next fire", async () => {
    const log = messageLog(HISTORY);
    await runObserver(
      EVENT,
      exhaustedRetriesStep(),
      observerDeps({ provider: routedProvider({ corrections: UNPARSEABLE_CORRECTIONS }), log }),
    );
    expect(log.cursors).toEqual({ corrections: null, memories: "msg-004" });

    log.append(...MISO);
    const provider = routedProvider();
    const result = await runObserver(
      EVENT,
      exhaustedRetriesStep(),
      observerDeps({ provider, log }),
    );

    const [corrections] = userMessagesOf(provider, CORRECTIONS);
    expect(corrections).not.toContain("<earlier_conversation>");
    expect(corrections).toContain("Berlin");
    expect(corrections).toContain("Miso");
    const memories = parts(expectDefined(userMessagesOf(provider, MEMORIES)[0], "memories"));
    expect(memories.fresh).toContain("Miso");
    expect(memories.fresh).not.toContain("Berlin");
    expect(result).toMatchObject({ newMessages: { corrections: 6, memories: 2 } });
    expect(log.cursors).toEqual({ corrections: "msg-006", memories: "msg-006" });
  });

  describe("a window over the chunk limit", () => {
    // 21k context, 1k output: a 10k-token budget, so a 2.5k-token chunk limit
    // that one ~1.5k-token message fills.
    const LIMITS = { contextWindow: 21_000, maxOutputTokens: 1_000 };
    const LONG: Message[] = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `${"x".repeat(6_000)} part-${i + 1}.`,
    }));

    it("extracts at most three chunks a fire, advancing the cursor after each", async () => {
      const log = messageLog(LONG);
      const provider = routedProvider();
      const deps = observerDeps({
        provider,
        log,
        resolveProvider: constantResolver(provider, LIMITS),
      });
      const step = exhaustedRetriesStep();

      const result = await runObserver(EVENT, step, deps);

      expect(step.ids.filter((id) => /^(extract|advance)-/.test(id))).toEqual([
        "extract-corrections-1",
        "advance-corrections-cursor-1",
        "extract-corrections-2",
        "advance-corrections-cursor-2",
        "extract-corrections-3",
        "advance-corrections-cursor-3",
        "extract-memories-1",
        "advance-memories-cursor-1",
        "extract-memories-2",
        "advance-memories-cursor-2",
        "extract-memories-3",
        "advance-memories-cursor-3",
      ]);
      expect(
        vi.mocked(deps.agentStore.advanceObserverCursor).mock.calls.map(([, a]) => a.through),
      ).toEqual(["msg-001", "msg-002", "msg-003", "msg-001", "msg-002", "msg-003"]);
      expect(userMessagesOf(provider, MEMORIES).map((t) => parts(t).fresh)).toEqual([
        expect.stringContaining("part-1."),
        expect.stringContaining("part-2."),
        expect.stringContaining("part-3."),
      ]);
      expect(result).toMatchObject({ newMessages: { corrections: 3, memories: 3 } });
      expect(log.cursors).toEqual({ corrections: "msg-003", memories: "msg-003" });

      await runObserver(EVENT, exhaustedRetriesStep(), deps);

      expect(log.cursors).toEqual({ corrections: "msg-006", memories: "msg-006" });
    });

    it("ends a phase at its failed chunk, keeping what the chunks before it found", async () => {
      const log = messageLog(LONG);
      const routed = routedProvider({
        corrections: {
          corrections: [
            {
              rule: "Prefer prose",
              category: "style",
              reasoning: "said so",
              action: "new",
              matchedExistingRuleId: null,
              channelType: null,
            },
          ],
        },
      });
      const chat = vi.fn(async (params: ChatParams) => {
        const content = params.messages[0]?.content;
        const second = typeof content === "string" && content.includes("part-2.\n</new_messages>");
        return second && params.system.includes(CORRECTIONS)
          ? routedProvider({ corrections: UNPARSEABLE_CORRECTIONS }).chat(params)
          : routed.chat(params);
      });
      const provider = { ...routed, chat };
      const step = exhaustedRetriesStep();

      const result = await runObserver(
        EVENT,
        step,
        observerDeps({ provider, log, resolveProvider: constantResolver(provider, LIMITS) }),
      );

      expect(step.ids).toContain("extract-corrections-2");
      expect(step.ids).not.toContain("advance-corrections-cursor-2");
      expect(step.ids).not.toContain("extract-corrections-3");
      expect(result).toMatchObject({
        corrections: { extracted: 1 },
        failedPhases: ["corrections"],
      });
      expect(log.cursors).toEqual({ corrections: "msg-001", memories: "msg-003" });
    });
  });

  describe("replays", () => {
    it("replays a recorded extraction and runs only its cursor advance", async () => {
      const log = messageLog(HISTORY);
      const provider = routedProvider();
      const deps = observerDeps({ provider, log });
      const recorded = new Map<string, unknown>();

      await expect(
        runObserver(
          EVENT,
          replayingStep(recorded, { id: "extract-memories-1", recorded: true }),
          deps,
        ),
      ).rejects.toThrow(Crash);
      expect(log.cursors.memories).toBeNull();
      const replay = replayingStep(recorded);
      await runObserver(EVENT, replay, deps);

      expect(replay.ran).not.toContain("extract-memories-1");
      expect(replay.ran).toContain("advance-memories-cursor-1");
      expect(userMessagesOf(provider, MEMORIES)).toHaveLength(1);
      expect(log.cursors.memories).toBe("msg-004");
    });

    it("re-runs an unrecorded extraction into the same Hindsight documents", async () => {
      const log = messageLog(HISTORY);
      const bank = documentBank();
      const provider = routedProvider();
      const deps = observerDeps({ provider, log, memory: bank.memory });
      const recorded = new Map<string, unknown>();

      await expect(
        runObserver(
          EVENT,
          replayingStep(recorded, { id: "extract-memories-1", recorded: false }),
          deps,
        ),
      ).rejects.toThrow(Crash);
      await runObserver(EVENT, replayingStep(recorded), deps);

      expect(userMessagesOf(provider, MEMORIES)).toHaveLength(2);
      const berlin = [...bank.documents.entries()].filter(
        ([, d]) => d.content === "Lives in Berlin",
      );
      expect(berlin.map(([id]) => id)).toEqual(["observer:conv-1:msg-004:0"]);
      expect(log.cursors.memories).toBe("msg-004");
    });

    it("re-applies an unrecorded chunk's contradiction under the same chunk", async () => {
      const log = messageLog(HISTORY);
      const provider = routedProvider({
        corrections: {
          corrections: [
            {
              rule: "Bullet points are fine",
              category: "style",
              reasoning: "takes it back",
              action: "contradiction",
              matchedExistingRuleId: "R1",
            },
          ],
        },
      });
      const deps = observerDeps({
        provider,
        log,
        store: {
          getCorrections: vi
            .fn()
            .mockResolvedValue([{ ...expectDefined(RULES[0], "rule"), active: false }]),
        },
      });
      const recorded = new Map<string, unknown>();

      await expect(
        runObserver(
          EVENT,
          replayingStep(recorded, { id: "extract-corrections-1", recorded: false }),
          deps,
        ),
      ).rejects.toThrow(Crash);
      await runObserver(EVENT, replayingStep(recorded), deps);

      expect(
        vi.mocked(deps.agentStore.contradictLearningRule).mock.calls.map(([, params]) => params),
      ).toEqual([
        { id: "rule-a", throughMessageId: "msg-004" },
        { id: "rule-a", throughMessageId: "msg-004" },
      ]);
    });

    it.each([
      { recorded: true, advances: 1 },
      { recorded: false, advances: 2 },
    ])(
      "leaves the cursor where one advance put it after a crash at the advance (recorded: $recorded)",
      async ({ recorded: wasRecorded, advances }) => {
        const log = messageLog(HISTORY);
        const provider = routedProvider();
        const deps = observerDeps({ provider, log });
        const recorded = new Map<string, unknown>();

        await expect(
          runObserver(
            EVENT,
            replayingStep(recorded, { id: "advance-corrections-cursor-1", recorded: wasRecorded }),
            deps,
          ),
        ).rejects.toThrow(Crash);
        const replay = replayingStep(recorded);
        await runObserver(EVENT, replay, deps);

        expect(replay.ran).not.toContain("extract-corrections-1");
        expect(userMessagesOf(provider, CORRECTIONS)).toHaveLength(1);
        const correctionAdvances = vi
          .mocked(deps.agentStore.advanceObserverCursor)
          .mock.calls.filter(([, a]) => a.phase === "corrections");
        expect(correctionAdvances).toHaveLength(advances);
        expect(log.cursors).toEqual({ corrections: "msg-004", memories: "msg-004" });
      },
    );
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
