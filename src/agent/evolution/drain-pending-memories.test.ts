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

    const result = await drainPendingMemories("user-1", null, deps);

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

    const result = await drainPendingMemories("user-1", null, deps);

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

    await drainPendingMemories("user-1", null, deps);

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

    await drainPendingMemories("user-1", null, deps);

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

    await expect(drainPendingMemories("user-1", null, deps)).rejects.toThrow(
      "Hindsight unreachable",
    );
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

    const result = await drainPendingMemories("user-1", null, deps);

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

    const result = await drainPendingMemories("user-1", null, deps);

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
      tags: { network: "bank", compartment: "personal", trust: "first-party" },
      ...overrides,
    };
  }

  it("appends profile_class:<class> when profileClass is non-null", () => {
    const items = buildRetainItems([classified()], "intimate");
    expect(items[0]?.tags).toEqual([
      "network:bank",
      "compartment:personal",
      "trust:first-party",
      "profile_class:intimate",
    ]);
  });

  it("omits profile_class tag when profileClass is null", () => {
    const items = buildRetainItems([classified()], null);
    expect(items[0]?.tags).toEqual(["network:bank", "compartment:personal", "trust:first-party"]);
  });

  it("stamps every row in a multi-row batch with the same class", () => {
    const items = buildRetainItems(
      [classified({ id: "pm-1" }), classified({ id: "pm-2", content: "lives in Berlin" })],
      "general",
    );
    for (const item of items) {
      expect(item.tags).toContain("profile_class:general");
    }
  });
});
