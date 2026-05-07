import { describe, expect, it, vi } from "vitest";
import type { MemoryProvider } from "../memory/provider.js";
import { memoryRecall, memoryReflect, memoryRetain, memoryTools } from "./memory-tools.js";
import type { Service } from "./service.js";
import { createService } from "./service.js";

function mockService(overrides?: Partial<Service["memory"]>): Service {
  return {
    memory: {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
      retain: vi.fn().mockResolvedValue(undefined),
      reflect: vi.fn().mockResolvedValue({ answer: "" }),
      stageRetain: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    },
    files: {
      read: vi.fn().mockResolvedValue(""),
      write: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    coreMemory: {
      get: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("memory_recall", () => {
  it("passes query to service.memory.recall", async () => {
    const caps = mockService();
    await memoryRecall.handler({ query: "Alice" }, caps);

    expect(caps.memory.recall).toHaveBeenCalledWith("Alice");
  });

  it("returns formatted memories", async () => {
    const caps = mockService({
      recall: vi.fn().mockResolvedValue({
        memories: [
          { content: "Alice likes coffee", type: "world" },
          { content: "Met Alice in 2023", type: "observation" },
        ],
      }),
    });

    const result = await memoryRecall.handler({ query: "Alice" }, caps);

    expect(result).toBe("[world] Alice likes coffee\n[observation] Met Alice in 2023");
  });

  it("returns message when no memories found", async () => {
    const caps = mockService();
    const result = await memoryRecall.handler({ query: "unknown" }, caps);

    expect(result).toBe("No relevant memories found.");
  });

  it("rejects invalid input (missing query)", async () => {
    const caps = mockService();
    await expect(memoryRecall.handler({}, caps)).rejects.toThrow();
  });

  it("has valid tool definition", () => {
    expect(memoryRecall.name).toBe("memory_recall");
    expect(memoryRecall.description).toBeTruthy();
    expect(memoryRecall.inputSchema.type).toBe("object");
  });
});

describe("memory_retain", () => {
  it("stages the fact via service.memory.stageRetain", async () => {
    const caps = mockService();
    await memoryRetain.handler({ content: "Alice likes coffee" }, caps);

    expect(caps.memory.stageRetain).toHaveBeenCalledWith("Alice likes coffee");
  });

  it("forwards context when provided", async () => {
    const caps = mockService();
    await memoryRetain.handler(
      { content: "Alice likes coffee", context: "mentioned during lunch chat" },
      caps,
    );

    expect(caps.memory.stageRetain).toHaveBeenCalledWith("Alice likes coffee", {
      context: "mentioned during lunch chat",
    });
  });

  it("does not write directly to MemoryProvider — staging only", async () => {
    const caps = mockService();
    await memoryRetain.handler({ content: "Alice likes coffee" }, caps);

    expect(caps.memory.retain).not.toHaveBeenCalled();
  });

  it("returns confirmation", async () => {
    const caps = mockService();
    const result = await memoryRetain.handler({ content: "a fact" }, caps);

    expect(result).toBe("Remembered.");
  });

  it("rejects invalid input (missing content)", async () => {
    const caps = mockService();
    await expect(memoryRetain.handler({}, caps)).rejects.toThrow();
  });

  it("has valid tool definition", () => {
    expect(memoryRetain.name).toBe("memory_retain");
    expect(memoryRetain.description).toBeTruthy();
    expect(memoryRetain.inputSchema.type).toBe("object");
  });
});

describe("memory_reflect", () => {
  it("calls service.memory.reflect with query and default low budget", async () => {
    const caps = mockService();
    await memoryReflect.handler({ query: "what do I know about Alice?" }, caps);

    expect(caps.memory.reflect).toHaveBeenCalledWith("what do I know about Alice?", {
      budget: "low",
    });
  });

  it("passes explicit budget through to the service", async () => {
    const caps = mockService();
    await memoryReflect.handler({ query: "project risks", budget: "high" }, caps);

    expect(caps.memory.reflect).toHaveBeenCalledWith("project risks", { budget: "high" });
  });

  it("forwards tags and tagsMatch when provided", async () => {
    const caps = mockService();
    await memoryReflect.handler(
      {
        query: "summarise",
        budget: "mid",
        tags: ["network:opinion"],
        tagsMatch: "any_strict",
      },
      caps,
    );

    expect(caps.memory.reflect).toHaveBeenCalledWith("summarise", {
      budget: "mid",
      tags: ["network:opinion"],
      tagsMatch: "any_strict",
    });
  });

  it("returns the synthesized answer from the provider", async () => {
    const caps = mockService({
      reflect: vi.fn().mockResolvedValue({ answer: "Alice prefers dark roast coffee." }),
    });

    const result = await memoryReflect.handler({ query: "Alice coffee" }, caps);

    expect(result).toBe("Alice prefers dark roast coffee.");
  });

  it("rejects invalid input (missing query)", async () => {
    const caps = mockService();
    await expect(memoryReflect.handler({}, caps)).rejects.toThrow();
  });

  it("rejects invalid budget value", async () => {
    const caps = mockService();
    await expect(memoryReflect.handler({ query: "q", budget: "extreme" }, caps)).rejects.toThrow();
  });

  it("has valid tool definition", () => {
    expect(memoryReflect.name).toBe("memory_reflect");
    expect(memoryReflect.description).toBeTruthy();
    expect(memoryReflect.description.toLowerCase()).toContain("synthes");
    expect(memoryReflect.inputSchema.type).toBe("object");
  });

  it("is registered in memoryTools", () => {
    expect(memoryTools.map((t) => t.name)).toContain("memory_reflect");
  });
});

describe("memory tools through a scope-filtered Service", () => {
  // The scope filter lives on Service.memory.recall / .reflect; tools that
  // call those methods must inherit the filter without doing anything
  // tag-aware themselves. These tests pin the join between the tool's
  // input schema and the Service's tag_groups construction.
  function buildScopedService(): { svc: Service; provider: MemoryProvider } {
    const provider: MemoryProvider = {
      name: "mock",
      retain: vi.fn().mockResolvedValue(undefined),
      retainBatch: vi.fn().mockResolvedValue(undefined),
      recall: vi.fn().mockResolvedValue({ memories: [] }),
      reflect: vi.fn().mockResolvedValue({ answer: "" }),
    };
    const svc = createService(
      provider,
      "user-123",
      { compartments: ["work", "technical"], trust: ["first-party"] },
      {
        read: vi.fn().mockResolvedValue(""),
        write: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
      },
      { get: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue(undefined) },
      vi.fn().mockResolvedValue(undefined),
    );
    return { svc, provider };
  }

  it("memory_recall through a scoped service applies the tag_groups filter", async () => {
    const { svc, provider } = buildScopedService();

    await memoryRecall.handler({ query: "deadlines" }, svc);

    expect(provider.recall).toHaveBeenCalledWith("user-123", "deadlines", {
      tagGroups: [
        {
          and: [
            { tags: ["compartment:work", "compartment:technical"], match: "any_strict" },
            { tags: ["trust:first-party"], match: "any_strict" },
          ],
        },
      ],
    });
  });

  it("memory_reflect through a scoped service folds caller tags + budget into the filter", async () => {
    const { svc, provider } = buildScopedService();

    await memoryReflect.handler(
      { query: "summarise", budget: "mid", tags: ["preference"], tagsMatch: "any" },
      svc,
    );

    expect(provider.reflect).toHaveBeenCalledWith("user-123", "summarise", {
      budget: "mid",
      tagGroups: [
        {
          and: [
            { tags: ["compartment:work", "compartment:technical"], match: "any_strict" },
            { tags: ["trust:first-party"], match: "any_strict" },
            { tags: ["preference"], match: "any" },
          ],
        },
      ],
    });
  });
});
