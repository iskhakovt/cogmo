import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import { expectDefined } from "../../test/assertions.js";
import { mockProvider } from "../../test/factories.js";
import type { MemoryRule, PendingMemory } from "../store/index.js";
import {
  buildRetainItems,
  type ClassifiedRow,
  classifyPendingMemories,
  type DrainPendingDeps,
  drainPendingMemories,
} from "./drain-pending-memories.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

function pending(overrides: Partial<PendingMemory> = {}): PendingMemory {
  return {
    id: "pm-1",
    content: "homelab IP is 10.0.10.10",
    context: null,
    source: "live_retain",
    profileId: "profile-1",
    profileClass: null,
    skillName: null,
    createdAt: new Date("2026-05-06T10:00:00Z"),
    ...overrides,
  };
}

function mockDeps(
  pendingRows: PendingMemory[],
  classifierResponses: Array<{
    network: string;
    compartment: string;
    trust: string;
    withhold?: boolean;
  }>,
  memoryRules: ReadonlyArray<MemoryRule> = [],
  seesUserRules = true,
): DrainPendingDeps {
  let callIndex = 0;
  const provider = mockProvider({
    chat: vi.fn().mockImplementation(() => {
      const next = classifierResponses[callIndex++];
      if (!next) throw new Error("classifier called more times than mocked");
      return Promise.resolve({
        content: [{ type: "text", text: JSON.stringify(next) }],
        stopReason: "end_turn",
        model: "mock",
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    }),
  });

  return {
    provider,
    model: "test-model",
    runInTx: fakeRunInTx,
    memory: { retainBatch: vi.fn().mockResolvedValue(undefined) },
    store: {
      getPendingMemories: vi.fn().mockResolvedValue(pendingRows),
      deletePendingMemories: vi.fn().mockResolvedValue(undefined),
      // What the store returns: global rules and those of the profiles asked about.
      getMemoryRules: vi.fn(
        async (_tx: unknown, scope: { profileIds: ReadonlyArray<string>; userId: string }) =>
          memoryRules.filter((r) => r.profileId === null || scope.profileIds.includes(r.profileId)),
      ),
    },
    customCompartments: [],
    seesUserRules,
  };
}

const HEALTH_RULE = "Don't save anything about my health.";

function memoryRule(rule: string, overrides: Partial<MemoryRule> = {}): MemoryRule {
  return { rule, profileId: null, fromUser: true, ...overrides };
}

function systemPrompts(deps: DrainPendingDeps): string[] {
  return vi.mocked(deps.provider.chat).mock.calls.map(([params]) => params.system);
}

describe("drainPendingMemories — memory rules", () => {
  it("withholds a row a rule forbids: deleted without a retain, counted and logged", async () => {
    const rows = [
      pending({ id: "pm-health", content: "takes metformin" }),
      pending({ id: "pm-ip", content: "homelab IP is 10.0.10.10" }),
    ];
    const deps = mockDeps(
      rows,
      [
        { network: "bank", compartment: "health", trust: "first-party", withhold: true },
        { network: "world", compartment: "technical", trust: "first-party", withhold: false },
      ],
      [memoryRule(HEALTH_RULE)],
    );
    const info = vi.spyOn(logger, "info");

    const result = await drainPendingMemories("user-1", deps);

    expect(result).toEqual({ drained: 1, byNetwork: { world: 1 }, withheld: 1 });
    const items = expectDefined(vi.mocked(deps.memory.retainBatch).mock.calls[0], "retain")[1];
    expect(items.map((i) => i.documentId)).toEqual(["pm-ip"]);
    expect(deps.store.deletePendingMemories).toHaveBeenCalledWith(expect.anything(), [
      "pm-ip",
      "pm-health",
    ]);
    const withheldLogs = info.mock.calls.filter(([, msg]) => String(msg).includes("withheld"));
    expect(withheldLogs).toEqual([
      [
        { pendingId: "pm-health", source: "live_retain", memoryRules: [HEALTH_RULE] },
        expect.any(String),
      ],
    ]);
    expect(JSON.stringify(withheldLogs)).not.toContain("metformin");
    info.mockRestore();
  });

  it("deletes the rows without a retain when every row is withheld", async () => {
    const deps = mockDeps(
      [pending({ id: "pm-health", content: "takes metformin" })],
      [{ network: "bank", compartment: "health", trust: "first-party", withhold: true }],
      [memoryRule(HEALTH_RULE)],
    );

    const result = await drainPendingMemories("user-1", deps);

    expect(result).toEqual({ drained: 0, byNetwork: {}, withheld: 1 });
    expect(deps.memory.retainBatch).not.toHaveBeenCalled();
    expect(deps.store.deletePendingMemories).toHaveBeenCalledWith(expect.anything(), ["pm-health"]);
  });

  it("lists the rules each row's staging profile sees, from one read", async () => {
    const rows = [
      pending({ id: "pm-1", profileId: "profile-a", source: "skill", skillName: "notes" }),
      pending({ id: "pm-2", profileId: "profile-b" }),
      pending({ id: "pm-3", profileId: null }),
      pending({ id: "pm-4", profileId: "profile-a" }),
    ];
    const answer = { network: "world", compartment: "technical", trust: "first-party" };
    const deps = mockDeps(
      rows,
      [{ ...answer, withhold: false }, answer, answer, { ...answer, withhold: false }],
      [memoryRule(HEALTH_RULE, { profileId: "profile-a" })],
    );

    const result = await drainPendingMemories("user-1", deps);

    expect(result.drained).toBe(4);
    expect(vi.mocked(deps.store.getMemoryRules).mock.calls.map(([, scope]) => scope)).toEqual([
      { profileIds: ["profile-a", "profile-b"], userId: "user-1" },
    ]);
    expect(systemPrompts(deps).map((s) => s.includes(HEALTH_RULE))).toEqual([
      true,
      false,
      false,
      true,
    ]);
  });

  it("passes a migration row without consulting the rules", async () => {
    const deps = mockDeps(
      [pending({ id: "pm-1", source: "migration" })],
      [{ network: "world", compartment: "technical", trust: "first-party" }],
      [memoryRule(HEALTH_RULE)],
    );

    const result = await drainPendingMemories("user-1", deps);

    expect(result).toEqual({ drained: 1, byNetwork: { world: 1 }, withheld: 0 });
    expect(deps.store.getMemoryRules).not.toHaveBeenCalled();
    expect(systemPrompts(deps)[0]).not.toContain("withhold");
  });

  it("leaves a row a user's rule binds pending when the fire's profile is third-party", async () => {
    const rows = [
      pending({ id: "pm-bound", profileId: "profile-a" }),
      pending({ id: "pm-free", profileId: "profile-b" }),
    ];
    const deps = mockDeps(
      rows,
      [{ network: "world", compartment: "technical", trust: "first-party", withhold: false }],
      [
        memoryRule(HEALTH_RULE, { profileId: "profile-a" }),
        memoryRule("Never store passwords.", { fromUser: false }),
      ],
      false,
    );

    const result = await drainPendingMemories("user-1", deps);

    expect(result).toEqual({ drained: 1, byNetwork: { world: 1 }, withheld: 0 });
    expect(deps.provider.chat).toHaveBeenCalledOnce();
    const [prompt] = systemPrompts(deps);
    expect(prompt).toContain("Never store passwords.");
    expect(prompt).not.toContain(HEALTH_RULE);
    expect(deps.store.deletePendingMemories).toHaveBeenCalledWith(expect.anything(), ["pm-free"]);
  });

  it("reads again the staging profile of a replayed row that lacks it", async () => {
    const { profileId: _dropped, ...replayed } = pending({ id: "pm-1", profileId: "profile-a" });
    const deps = mockDeps(
      [pending({ id: "pm-1", profileId: "profile-a" })],
      [{ network: "bank", compartment: "health", trust: "first-party", withhold: true }],
      [memoryRule(HEALTH_RULE, { profileId: "profile-a" })],
    );

    // A replayed row memoized without `profileId`.
    const result = await classifyPendingMemories(
      [replayed as unknown as PendingMemory],
      "user-1",
      deps,
    );

    expect(deps.store.getPendingMemories).toHaveBeenCalledWith(expect.anything(), "user-1");
    expect(systemPrompts(deps)[0]).toContain(HEALTH_RULE);
    expect(result.withheld).toEqual(["pm-1"]);
  });

  it("skips a replayed row that is no longer pending", async () => {
    const { profileId: _dropped, ...replayed } = pending({ id: "pm-gone" });
    const deps = mockDeps([], [], [memoryRule(HEALTH_RULE)]);

    // A replayed row memoized without `profileId`.
    const result = await classifyPendingMemories(
      [replayed as unknown as PendingMemory],
      "user-1",
      deps,
    );

    expect(result).toEqual({ successful: [], withheld: [], byNetwork: {} });
    expect(deps.provider.chat).not.toHaveBeenCalled();
  });
});

describe("drainPendingMemories", () => {
  it("returns zeros and skips work when nothing pending", async () => {
    const deps = mockDeps([], []);

    const result = await drainPendingMemories("user-1", deps);

    expect(result).toEqual({ drained: 0, byNetwork: {}, withheld: 0 });
    expect(deps.memory.retainBatch).not.toHaveBeenCalled();
    expect(deps.store.deletePendingMemories).not.toHaveBeenCalled();
    expect(deps.provider.chat).not.toHaveBeenCalled();
  });

  it("classifies live retains and stamps source:live_retain in metadata", async () => {
    const rows = [pending({ id: "pm-1", content: "homelab IP is 10.0.10.10" })];
    const deps = mockDeps(rows, [
      { network: "world", compartment: "technical", trust: "first-party" },
    ]);

    const result = await drainPendingMemories("user-1", deps);

    expect(result.drained).toBe(1);
    expect(result.byNetwork).toEqual({ world: 1 });
    expect(deps.memory.retainBatch).toHaveBeenCalledWith("user-1", [
      {
        content: "homelab IP is 10.0.10.10",
        documentId: "pm-1",
        tags: ["network:world", "compartment:technical", "trust:first-party"],
        metadata: { source: "live_retain" },
        observationScopes: "per_tag",
      },
    ]);
    expect(deps.store.deletePendingMemories).toHaveBeenCalledWith(expect.anything(), ["pm-1"]);
  });

  it("forwards context when present on the pending row", async () => {
    const rows = [
      pending({ id: "pm-1", content: "wife's birthday March 15", context: "while planning" }),
    ];
    const deps = mockDeps(rows, [
      { network: "bank", compartment: "personal", trust: "first-party" },
    ]);

    await drainPendingMemories("user-1", deps);

    expect(deps.memory.retainBatch).toHaveBeenCalledWith("user-1", [
      {
        content: "wife's birthday March 15",
        documentId: "pm-1",
        context: "while planning",
        tags: ["network:bank", "compartment:personal", "trust:first-party"],
        metadata: { source: "live_retain" },
        observationScopes: "per_tag",
      },
    ]);
  });

  it("stamps source:migration in metadata for migration-sourced rows", async () => {
    const rows = [pending({ id: "pm-1", source: "migration" })];
    const deps = mockDeps(rows, [
      { network: "world", compartment: "technical", trust: "first-party" },
    ]);

    await drainPendingMemories("user-1", deps);

    expect(deps.memory.retainBatch).toHaveBeenCalledWith("user-1", [
      expect.objectContaining({ metadata: { source: "migration" } }),
    ]);
  });

  it("stamps source:skill and the skill's name in metadata for skill-staged rows", async () => {
    const rows = [pending({ id: "pm-1", source: "skill", skillName: "ci_watch" })];
    const deps = mockDeps(rows, [
      { network: "world", compartment: "technical", trust: "first-party" },
    ]);

    await drainPendingMemories("user-1", deps);

    expect(deps.memory.retainBatch).toHaveBeenCalledWith("user-1", [
      expect.objectContaining({ metadata: { source: "skill", skill: "ci_watch" } }),
    ]);
  });

  it("leaves rows in the store when retainBatch fails — no delete attempt", async () => {
    const rows = [pending({ id: "pm-1" })];
    const deps = mockDeps(rows, [
      { network: "world", compartment: "technical", trust: "first-party" },
    ]);
    (deps.memory.retainBatch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Hindsight unreachable"),
    );

    await expect(drainPendingMemories("user-1", deps)).rejects.toThrow("Hindsight unreachable");
    expect(deps.store.deletePendingMemories).not.toHaveBeenCalled();
  });

  it("skips rows whose classification fails — keeps them in the table for retry", async () => {
    const rows = [
      pending({ id: "pm-good", content: "fact A" }),
      pending({ id: "pm-bad", content: "fact B" }),
    ];
    let call = 0;
    const provider = mockProvider({
      chat: vi.fn().mockImplementation(() => {
        const i = call++;
        if (i === 1) return Promise.reject(new Error("LLM down"));
        return Promise.resolve({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                network: "world",
                compartment: "technical",
                trust: "first-party",
              }),
            },
          ],
          stopReason: "end_turn",
          model: "mock",
          usage: { inputTokens: 10, outputTokens: 5 },
        });
      }),
    });
    const deps: DrainPendingDeps = {
      provider,
      model: "test-model",
      runInTx: fakeRunInTx,
      memory: { retainBatch: vi.fn().mockResolvedValue(undefined) },
      store: {
        getPendingMemories: vi.fn().mockResolvedValue(rows),
        deletePendingMemories: vi.fn().mockResolvedValue(undefined),
        getMemoryRules: vi.fn().mockResolvedValue([]),
      },
      seesUserRules: true,
      customCompartments: [],
    };

    const result = await drainPendingMemories("user-1", deps);

    expect(result.drained).toBe(1);
    expect(deps.memory.retainBatch).toHaveBeenCalledWith("user-1", [
      expect.objectContaining({ content: "fact A" }),
    ]);
    expect(deps.store.deletePendingMemories).toHaveBeenCalledWith(expect.anything(), ["pm-good"]);
  });

  it("returns zeros and skips IO when every classification fails", async () => {
    const rows = [pending({ id: "pm-1" }), pending({ id: "pm-2" })];
    const deps: DrainPendingDeps = {
      provider: mockProvider({
        chat: vi.fn().mockRejectedValue(new Error("boom")),
      }),
      model: "test-model",
      runInTx: fakeRunInTx,
      memory: { retainBatch: vi.fn().mockResolvedValue(undefined) },
      store: {
        getPendingMemories: vi.fn().mockResolvedValue(rows),
        deletePendingMemories: vi.fn().mockResolvedValue(undefined),
        getMemoryRules: vi.fn().mockResolvedValue([]),
      },
      seesUserRules: true,
      customCompartments: [],
    };

    const result = await drainPendingMemories("user-1", deps);

    expect(result).toEqual({ drained: 0, byNetwork: {}, withheld: 0 });
    expect(deps.memory.retainBatch).not.toHaveBeenCalled();
    expect(deps.store.deletePendingMemories).not.toHaveBeenCalled();
  });

  it("recovers a trailing-comma classifier response via chatTyped repair (jsonrepair pre-pass)", async () => {
    // Regression: the classifier callsite passes `repair: {}` into chatTyped,
    // so jsonrepair runs unconditionally as a pre-pass. A trailing comma in
    // the structured-output response — a common provider sloppiness — must
    // not crash the drain, and must not consume a feedback retry budget.
    const rows = [pending({ id: "pm-1", content: "homelab IP is 10.0.10.10" })];
    const provider = mockProvider({
      chat: vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: '{"network":"world","compartment":"technical","trust":"first-party",}',
          },
        ],
        stopReason: "end_turn",
        model: "mock",
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });
    const deps: DrainPendingDeps = {
      provider,
      model: "test-model",
      runInTx: fakeRunInTx,
      memory: { retainBatch: vi.fn().mockResolvedValue(undefined) },
      store: {
        getPendingMemories: vi.fn().mockResolvedValue(rows),
        deletePendingMemories: vi.fn().mockResolvedValue(undefined),
        getMemoryRules: vi.fn().mockResolvedValue([]),
      },
      seesUserRules: true,
      customCompartments: [],
    };

    const result = await drainPendingMemories("user-1", deps);

    expect(result.drained).toBe(1);
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });
});

describe("drainPendingMemories — customCompartments threading", () => {
  it("templates customs into the classifier system prompt", async () => {
    const customs = [{ name: "dnd", description: "tabletop campaign notes" }];
    const rows = [pending({ id: "pm-1", content: "campaign uses SWN rules" })];
    const provider = mockProvider({
      chat: vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              network: "world",
              compartment: "dnd",
              trust: "first-party",
            }),
          },
        ],
        stopReason: "end_turn",
        model: "mock",
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });
    const deps: DrainPendingDeps = {
      provider,
      model: "test-model",
      runInTx: fakeRunInTx,
      memory: { retainBatch: vi.fn().mockResolvedValue(undefined) },
      store: {
        getPendingMemories: vi.fn().mockResolvedValue(rows),
        deletePendingMemories: vi.fn().mockResolvedValue(undefined),
        getMemoryRules: vi.fn().mockResolvedValue([]),
      },
      seesUserRules: true,
      customCompartments: customs,
    };

    await drainPendingMemories("user-1", deps);

    const call = vi.mocked(provider.chat).mock.calls[0]?.[0];
    const system = (call as { system?: string } | undefined)?.system ?? "";
    expect(system).toContain("**dnd**: tabletop campaign notes");
    expect(system).toContain("Custom compartments");
  });

  it("retains rows tagged with a custom compartment when the classifier emits it", async () => {
    const rows = [pending({ id: "pm-1", content: "campaign uses SWN rules" })];
    const deps: DrainPendingDeps = {
      provider: mockProvider({
        chat: vi.fn().mockResolvedValue({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                network: "world",
                compartment: "dnd",
                trust: "first-party",
              }),
            },
          ],
          stopReason: "end_turn",
          model: "mock",
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
      }),
      model: "test-model",
      runInTx: fakeRunInTx,
      memory: { retainBatch: vi.fn().mockResolvedValue(undefined) },
      store: {
        getPendingMemories: vi.fn().mockResolvedValue(rows),
        deletePendingMemories: vi.fn().mockResolvedValue(undefined),
        getMemoryRules: vi.fn().mockResolvedValue([]),
      },
      seesUserRules: true,
      customCompartments: [{ name: "dnd", description: "x" }],
    };

    const result = await drainPendingMemories("user-1", deps);

    expect(result.drained).toBe(1);
    expect(deps.memory.retainBatch).toHaveBeenCalledWith("user-1", [
      expect.objectContaining({
        tags: ["network:world", "compartment:dnd", "trust:first-party"],
      }),
    ]);
  });

  it("treats a classifier emission outside core ∪ customs as a per-row failure (skip, not crash)", async () => {
    // When the structured-output parse fails on the strict compartment
    // enum, classifyOne logs and returns null — the row stays in
    // `pending_memories` for the next drain attempt. Other rows in the
    // same batch still drain. Without per-fire schema construction the
    // bad value would land in Hindsight unfilterable; this exercises
    // the safety net.
    const rows = [
      pending({ id: "pm-good", content: "valid" }),
      pending({ id: "pm-bad", content: "invalid" }),
    ];
    let call = 0;
    const provider = mockProvider({
      chat: vi.fn().mockImplementation(() => {
        const i = call++;
        const compartment = i === 0 ? "dnd" : "music";
        return Promise.resolve({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                network: "world",
                compartment,
                trust: "first-party",
              }),
            },
          ],
          stopReason: "end_turn",
          model: "mock",
          usage: { inputTokens: 10, outputTokens: 5 },
        });
      }),
    });
    const deps: DrainPendingDeps = {
      provider,
      model: "test-model",
      runInTx: fakeRunInTx,
      memory: { retainBatch: vi.fn().mockResolvedValue(undefined) },
      store: {
        getPendingMemories: vi.fn().mockResolvedValue(rows),
        deletePendingMemories: vi.fn().mockResolvedValue(undefined),
        getMemoryRules: vi.fn().mockResolvedValue([]),
      },
      seesUserRules: true,
      customCompartments: [{ name: "dnd", description: "x" }],
    };

    const result = await drainPendingMemories("user-1", deps);

    expect(result.drained).toBe(1);
    // Only the good row's id is deleted — the bad row stays for retry.
    expect(deps.store.deletePendingMemories).toHaveBeenCalledWith(expect.anything(), ["pm-good"]);
  });
});

describe("buildRetainItems", () => {
  function classified(overrides: Partial<ClassifiedRow> = {}): ClassifiedRow {
    return {
      id: "pm-1",
      content: "user prefers tea",
      context: null,
      source: "live_retain",
      profileClass: null,
      skillName: null,
      tags: { network: "bank", compartment: "personal", trust: "first-party" },
      ...overrides,
    };
  }

  it("appends profile_class:<class> when row carries a non-null profileClass", () => {
    const items = buildRetainItems([classified({ profileClass: "intimate" })]);
    expect(items[0]?.tags).toEqual([
      "network:bank",
      "compartment:personal",
      "trust:first-party",
      "profile_class:intimate",
    ]);
  });

  it("omits profile_class tag when row's profileClass is null", () => {
    const items = buildRetainItems([classified()]);
    expect(items[0]?.tags).toEqual(["network:bank", "compartment:personal", "trust:first-party"]);
  });

  it("treats undefined profileClass as untagged (Inngest replay safety)", () => {
    // Regression: a row from an in-flight Inngest run started under
    // earlier code that didn't include `profileClass` on ClassifiedRow
    // deserializes with the field as `undefined`, not `null`. The bare
    // `!== null` check would slip past it and emit
    // `profile_class:undefined`. The typeof guard rejects both.
    // Reconstruct without the `profileClass` key — the actual shape
    // Inngest replay yields (the field is missing entirely on the
    // deserialized object), which is what `typeof === "string"` is
    // guarding against. `_dropped` rebinds via destructuring without
    // tripping `noUnusedLocals` on the discard.
    const { profileClass: _dropped, ...withoutClass } = classified();
    void _dropped;
    const items = buildRetainItems([withoutClass as ClassifiedRow]);
    expect(items[0]?.tags).not.toContainEqual(expect.stringMatching(/^profile_class:/));
  });

  it("names no skill when a replayed row has no skillName (Inngest replay safety)", () => {
    // A classify step memoized by an earlier deploy deserializes without
    // `skillName`.
    const { skillName: _dropped, ...withoutSkill } = classified();
    void _dropped;
    const items = buildRetainItems([withoutSkill as ClassifiedRow]);
    expect(items[0]?.metadata).toStrictEqual({ source: "live_retain" });
  });

  it("keys each item on its pending row id, so a repeat drain of a row replaces its document", () => {
    const items = buildRetainItems([classified({ id: "pm-a" }), classified({ id: "pm-b" })]);
    expect(items.map((i) => i.documentId)).toEqual(["pm-a", "pm-b"]);
  });

  it("stamps each row with its OWN class — speaker isolation under mixed batches", () => {
    // Regression for the bug where a single drain batch containing rows
    // staged by different profiles got tagged with the firing
    // conversation's class, leaking across the speaker-isolation
    // boundary. Each row's profileClass is now carried through from the
    // pending row's snapshot.
    const items = buildRetainItems([
      classified({ id: "pm-intimate", profileClass: "intimate" }),
      classified({ id: "pm-general", profileClass: "general" }),
      classified({ id: "pm-untagged", profileClass: null }),
    ]);
    expect(items[0]?.tags).toContain("profile_class:intimate");
    expect(items[0]?.tags).not.toContain("profile_class:general");
    expect(items[1]?.tags).toContain("profile_class:general");
    expect(items[1]?.tags).not.toContain("profile_class:intimate");
    expect(items[2]?.tags).not.toContainEqual(expect.stringMatching(/^profile_class:/));
  });
});
