import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import { mockProvider } from "../../test/factories.js";
import type { PendingMemory } from "../store/index.js";
import {
  buildRetainItems,
  type ClassifiedRow,
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
    profileClass: null,
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
  }>,
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
    },
  };
}

describe("drainPendingMemories", () => {
  it("returns zeros and skips work when nothing pending", async () => {
    const deps = mockDeps([], []);

    const result = await drainPendingMemories("user-1", deps);

    expect(result).toEqual({ drained: 0, byNetwork: {} });
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
      },
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
      },
    };

    const result = await drainPendingMemories("user-1", deps);

    expect(result).toEqual({ drained: 0, byNetwork: {} });
    expect(deps.memory.retainBatch).not.toHaveBeenCalled();
    expect(deps.store.deletePendingMemories).not.toHaveBeenCalled();
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
