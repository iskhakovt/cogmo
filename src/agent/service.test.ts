import { describe, expect, it, vi } from "vitest";
import type { MemoryProvider } from "../memory/provider.js";
import type { Service } from "./service.js";
import { createService } from "./service.js";
import type { ProfileMemoryScope } from "./store/schema.js";

const stubFiles: Service["files"] = {
  read: async () => "",
  write: async () => {},
  list: async () => [],
};

const stubCoreMemory: Service["coreMemory"] = {
  get: async () => [],
  update: async () => {},
};

const stubStage: Service["memory"]["stageRetain"] = async () => {};

function mockMemory(): MemoryProvider {
  return {
    name: "mock",
    retain: vi.fn().mockResolvedValue(undefined),
    retainBatch: vi.fn().mockResolvedValue(undefined),
    recall: vi.fn().mockResolvedValue({ memories: [] }),
    reflect: vi.fn().mockResolvedValue({ answer: "" }),
  };
}

function workScope(): ProfileMemoryScope {
  return {
    compartments: ["work", "technical"],
    trust: ["first-party"],
  };
}

describe("createService — no scope (memoryScope: null)", () => {
  it("delegates recall to the MemoryProvider with the right bankId, no filter applied", async () => {
    const memory = mockMemory();
    const svc = createService(memory, "user-123", null, stubFiles, stubCoreMemory, stubStage);

    await svc.memory.recall("query");

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {});
  });

  it("preserves caller-supplied tags / tagsMatch when no scope is set", async () => {
    const memory = mockMemory();
    const svc = createService(memory, "user-123", null, stubFiles, stubCoreMemory, stubStage);

    await svc.memory.recall("query", { tags: ["preference"], tagsMatch: "all", maxTokens: 500 });

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {
      tags: ["preference"],
      tagsMatch: "all",
      maxTokens: 500,
    });
  });

  it("delegates retain to MemoryProvider unchanged (writes are never scope-filtered)", async () => {
    const memory = mockMemory();
    const svc = createService(memory, "user-123", null, stubFiles, stubCoreMemory, stubStage);

    await svc.memory.retain("a fact", { context: "hi", tags: ["x"] });

    expect(memory.retain).toHaveBeenCalledWith("user-123", "a fact", {
      context: "hi",
      tags: ["x"],
    });
  });

  it("delegates reflect with budget passthrough", async () => {
    const memory = mockMemory();
    const svc = createService(memory, "user-123", null, stubFiles, stubCoreMemory, stubStage);

    await svc.memory.reflect("query", { budget: "high" });

    expect(memory.reflect).toHaveBeenCalledWith("user-123", "query", { budget: "high" });
  });
});

describe("createService — scope filter (memoryScope set)", () => {
  it("recall builds tagGroups from the profile's compartments + trust", async () => {
    const memory = mockMemory();
    const svc = createService(
      memory,
      "user-123",
      workScope(),
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.recall("query");

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {
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

  it("merges caller-supplied tags into the AND group, stripping plain tags/tagsMatch", async () => {
    const memory = mockMemory();
    const svc = createService(
      memory,
      "user-123",
      workScope(),
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.recall("query", {
      tags: ["preference"],
      tagsMatch: "all",
      maxTokens: 500,
    });

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {
      maxTokens: 500,
      tagGroups: [
        {
          and: [
            { tags: ["compartment:work", "compartment:technical"], match: "any_strict" },
            { tags: ["trust:first-party"], match: "any_strict" },
            { tags: ["preference"], match: "all" },
          ],
        },
      ],
    });
  });

  it("treats caller-supplied empty tags array as no caller filter (drops it from the AND group)", async () => {
    const memory = mockMemory();
    const svc = createService(
      memory,
      "user-123",
      workScope(),
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.recall("query", { tags: [], tagsMatch: "all" });

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {
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

  it("appends caller-supplied tagGroups into the AND group", async () => {
    const memory = mockMemory();
    const svc = createService(
      memory,
      "user-123",
      workScope(),
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    const callerGroup = { not: { tags: ["network:opinion"], match: "any" as const } };
    await svc.memory.recall("query", { tagGroups: [callerGroup] });

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {
      tagGroups: [
        {
          and: [
            { tags: ["compartment:work", "compartment:technical"], match: "any_strict" },
            { tags: ["trust:first-party"], match: "any_strict" },
            callerGroup,
          ],
        },
      ],
    });
  });

  it("retain is NOT scope-filtered — writes pass through unchanged", async () => {
    const memory = mockMemory();
    const svc = createService(
      memory,
      "user-123",
      workScope(),
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.retain("a fact", { tags: ["custom"] });

    expect(memory.retain).toHaveBeenCalledWith("user-123", "a fact", { tags: ["custom"] });
  });

  it("reflect builds tagGroups and preserves budget", async () => {
    const memory = mockMemory();
    const svc = createService(
      memory,
      "user-123",
      workScope(),
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.reflect("query", { budget: "mid" });

    expect(memory.reflect).toHaveBeenCalledWith("user-123", "query", {
      budget: "mid",
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
});

describe("createService — stageRetain", () => {
  it("delegates stageRetain to the injected closure with content and context", async () => {
    const memory = mockMemory();
    const stage = vi.fn().mockResolvedValue(undefined);
    const svc = createService(memory, "user-123", null, stubFiles, stubCoreMemory, stage);

    await svc.memory.stageRetain("a fact", { context: "from morning chat" });

    expect(stage).toHaveBeenCalledWith("a fact", { context: "from morning chat" });
  });

  it("stageRetain works with no opts", async () => {
    const memory = mockMemory();
    const stage = vi.fn().mockResolvedValue(undefined);
    const svc = createService(memory, "user-123", null, stubFiles, stubCoreMemory, stage);

    await svc.memory.stageRetain("a fact");

    expect(stage).toHaveBeenCalledWith("a fact");
  });

  it("stageRetain does not touch MemoryProvider", async () => {
    const memory = mockMemory();
    const stage = vi.fn().mockResolvedValue(undefined);
    const svc = createService(memory, "user-123", null, stubFiles, stubCoreMemory, stage);

    await svc.memory.stageRetain("a fact");

    expect(memory.retain).not.toHaveBeenCalled();
  });
});
