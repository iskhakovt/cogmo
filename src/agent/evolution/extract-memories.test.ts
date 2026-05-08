import { describe, expect, it, vi } from "vitest";
import type { Message } from "../../llm/types.js";
import { mockProvider } from "../../test/factories.js";
import { extractMemories, type MemoryExtractionDeps } from "./extract-memories.js";

function mockExtractionDeps(
  chatTypedResponse: { memories: Array<Record<string, unknown>> },
  overrides?: Partial<MemoryExtractionDeps>,
): MemoryExtractionDeps {
  const provider = mockProvider({
    chat: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(chatTypedResponse) }],
      stopReason: "end_turn",
      model: "mock",
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
  });

  return {
    provider,
    model: "test-model",
    memory: {
      retainBatch: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

const sampleHistory: Message[] = [
  { role: "user", content: "My homelab IP is 10.0.10.10 and I prefer dark mode." },
  { role: "assistant", content: "Got it! I'll remember your homelab IP and preference." },
  { role: "user", content: "Also, I usually work on infrastructure stuff on weekends." },
  { role: "assistant", content: "Noted — weekends are infrastructure time." },
];

describe("extractMemories", () => {
  it("returns zeros for empty transcript", async () => {
    const deps = mockExtractionDeps({ memories: [] });
    const result = await extractMemories([], "user-1", null, deps);

    expect(result).toEqual({ extracted: 0, byNetwork: {} });
    expect(deps.memory.retainBatch).not.toHaveBeenCalled();
    expect(deps.provider.chat).not.toHaveBeenCalled();
  });

  it("returns zeros when no memories extracted", async () => {
    const deps = mockExtractionDeps({ memories: [] });
    const result = await extractMemories(sampleHistory, "user-1", null, deps);

    expect(result).toEqual({ extracted: 0, byNetwork: {} });
    expect(deps.memory.retainBatch).not.toHaveBeenCalled();
  });

  it("extracts and retains memories with network, compartment, and trust tags", async () => {
    const deps = mockExtractionDeps({
      memories: [
        {
          fact: "homelab IP is 10.0.10.10",
          network: "world",
          compartment: "technical",
          trust: "first-party",
        },
        {
          fact: "prefers dark mode",
          network: "bank",
          compartment: "personal",
          trust: "any",
        },
      ],
    });

    const result = await extractMemories(sampleHistory, "user-1", null, deps);

    expect(result.extracted).toBe(2);
    expect(result.byNetwork).toEqual({ world: 1, bank: 1 });
    expect(deps.memory.retainBatch).toHaveBeenCalledWith("user-1", [
      {
        content: "homelab IP is 10.0.10.10",
        tags: ["network:world", "compartment:technical", "trust:first-party"],
        metadata: { source: "conversation" },
        observationScopes: "per_tag",
      },
      {
        content: "prefers dark mode",
        tags: ["network:bank", "compartment:personal", "trust:any"],
        metadata: { source: "conversation" },
        observationScopes: "per_tag",
      },
    ]);
  });

  it("passes context when provided by extraction", async () => {
    const deps = mockExtractionDeps({
      memories: [
        {
          fact: "wife's birthday is March 15",
          network: "bank",
          compartment: "personal",
          trust: "first-party",
          context: "mentioned while planning a gift",
        },
      ],
    });

    const result = await extractMemories(sampleHistory, "user-1", null, deps);

    expect(result.extracted).toBe(1);
    expect(deps.memory.retainBatch).toHaveBeenCalledWith("user-1", [
      {
        content: "wife's birthday is March 15",
        context: "mentioned while planning a gift",
        tags: ["network:bank", "compartment:personal", "trust:first-party"],
        metadata: { source: "conversation" },
        observationScopes: "per_tag",
      },
    ]);
  });

  it("counts by network correctly", async () => {
    const deps = mockExtractionDeps({
      memories: [
        { fact: "fact 1", network: "world", compartment: "technical", trust: "first-party" },
        { fact: "fact 2", network: "world", compartment: "technical", trust: "first-party" },
        { fact: "fact 3", network: "observation", compartment: "personal", trust: "first-party" },
        { fact: "fact 4", network: "opinion", compartment: "personal", trust: "first-party" },
      ],
    });

    const result = await extractMemories(sampleHistory, "user-1", null, deps);

    expect(result.extracted).toBe(4);
    expect(result.byNetwork).toEqual({ world: 2, observation: 1, opinion: 1 });
  });

  it("uses bankId as the Hindsight bank", async () => {
    const deps = mockExtractionDeps({
      memories: [
        { fact: "a fact", network: "world", compartment: "technical", trust: "first-party" },
      ],
    });

    await extractMemories(sampleHistory, "ti", null, deps);

    expect(deps.memory.retainBatch).toHaveBeenCalledWith("ti", expect.any(Array));
  });

  it("catches chatTyped failure and returns zeros", async () => {
    const deps = mockExtractionDeps(
      { memories: [] },
      {
        provider: mockProvider({
          chat: vi.fn().mockRejectedValue(new Error("LLM timeout")),
        }),
      },
    );

    const result = await extractMemories(sampleHistory, "user-1", null, deps);

    expect(result).toEqual({ extracted: 0, byNetwork: {} });
    expect(deps.memory.retainBatch).not.toHaveBeenCalled();
  });

  it("appends profile_class tag when profileClass is non-null", async () => {
    const deps = mockExtractionDeps({
      memories: [
        { fact: "a fact", network: "world", compartment: "technical", trust: "first-party" },
      ],
    });

    await extractMemories(sampleHistory, "user-1", "intimate", deps);

    const call = vi.mocked(deps.memory.retainBatch).mock.calls[0];
    const items = call?.[1] ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.tags).toContain("profile_class:intimate");
  });

  it("omits profile_class tag when profileClass is null", async () => {
    const deps = mockExtractionDeps({
      memories: [
        { fact: "a fact", network: "world", compartment: "technical", trust: "first-party" },
      ],
    });

    await extractMemories(sampleHistory, "user-1", null, deps);

    const call = vi.mocked(deps.memory.retainBatch).mock.calls[0];
    const items = call?.[1] ?? [];
    expect(items[0]?.tags).not.toContainEqual(expect.stringMatching(/^profile_class:/));
  });
});
