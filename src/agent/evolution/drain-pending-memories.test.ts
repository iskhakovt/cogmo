import { describe, expect, it, vi } from "vitest";
import { mockProvider } from "../../test/factories.js";
import type { PendingMemory } from "../store/index.js";
import { type DrainPendingDeps, drainPendingMemories } from "./drain-pending-memories.js";

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

  it("classifies pending rows and retains with full tag set", async () => {
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
        metadata: { source: "conversation" },
        observationScopes: "per_tag",
      },
    ]);
    expect(deps.store.deletePendingMemories).toHaveBeenCalledWith(["pm-1"]);
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
        metadata: { source: "conversation" },
        observationScopes: "per_tag",
      },
    ]);
  });

  it("tags migration-sourced rows with source:migration in metadata", async () => {
    const rows = [pending({ id: "pm-1", source: "migration" })];
    const deps = mockDeps(rows, [
      { network: "world", compartment: "technical", trust: "first-party" },
    ]);

    await drainPendingMemories("user-1", deps);

    expect(deps.memory.retainBatch).toHaveBeenCalledWith("user-1", [
      expect.objectContaining({ metadata: { source: "migration" } }),
    ]);
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
    expect(deps.store.deletePendingMemories).toHaveBeenCalledWith(["pm-good"]);
  });

  it("returns zeros and skips IO when every classification fails", async () => {
    const rows = [pending({ id: "pm-1" }), pending({ id: "pm-2" })];
    const deps: DrainPendingDeps = {
      provider: mockProvider({
        chat: vi.fn().mockRejectedValue(new Error("boom")),
      }),
      model: "test-model",
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
