import { describe, expect, it, vi } from "vitest";
import type { MemoryProvider } from "../memory/provider.js";
import type { Service } from "./service.js";
import { createService } from "./service.js";

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
    recall: vi.fn().mockResolvedValue({ memories: [] }),
    reflect: vi.fn().mockResolvedValue({ answer: "" }),
  };
}

describe("createService", () => {
  it("delegates recall to MemoryProvider with correct bankId", async () => {
    const memory = mockMemory();
    const svc = createService(memory, "user-123", [], stubFiles, stubCoreMemory, stubStage);

    await svc.memory.recall("some query");

    expect(memory.recall).toHaveBeenCalledWith("user-123", "some query", { tags: [] });
  });

  it("delegates retain to MemoryProvider with correct bankId", async () => {
    const memory = mockMemory();
    const svc = createService(memory, "user-123", [], stubFiles, stubCoreMemory, stubStage);

    await svc.memory.retain("a fact");

    expect(memory.retain).toHaveBeenCalledWith("user-123", "a fact", { tags: [] });
  });

  it("merges profileTags with caller-provided tags on recall", async () => {
    const memory = mockMemory();
    const svc = createService(
      memory,
      "user-123",
      ["network:world", "network:opinion"],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.recall("query", { tags: ["extra"] });

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {
      tags: ["network:world", "network:opinion", "extra"],
    });
  });

  it("merges profileTags with caller-provided tags on retain", async () => {
    const memory = mockMemory();
    const svc = createService(
      memory,
      "user-123",
      ["network:world"],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.retain("fact", { tags: ["custom"] });

    expect(memory.retain).toHaveBeenCalledWith("user-123", "fact", {
      tags: ["network:world", "custom"],
    });
  });

  it("preserves non-tag options on recall", async () => {
    const memory = mockMemory();
    const svc = createService(memory, "user-123", [], stubFiles, stubCoreMemory, stubStage);

    await svc.memory.recall("query", { maxTokens: 500 });

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {
      maxTokens: 500,
      tags: [],
    });
  });

  it("preserves non-tag options on retain", async () => {
    const memory = mockMemory();
    const svc = createService(memory, "user-123", [], stubFiles, stubCoreMemory, stubStage);

    await svc.memory.retain("fact", {
      context: "from conversation",
      metadata: { source: "chat" },
    });

    expect(memory.retain).toHaveBeenCalledWith("user-123", "fact", {
      context: "from conversation",
      metadata: { source: "chat" },
      tags: [],
    });
  });

  it("works with no opts provided", async () => {
    const memory = mockMemory();
    const svc = createService(memory, "bank-1", ["tag-a"], stubFiles, stubCoreMemory, stubStage);

    await svc.memory.recall("q");
    await svc.memory.retain("f");
    await svc.memory.reflect("q");

    expect(memory.recall).toHaveBeenCalledWith("bank-1", "q", { tags: ["tag-a"] });
    expect(memory.retain).toHaveBeenCalledWith("bank-1", "f", { tags: ["tag-a"] });
    expect(memory.reflect).toHaveBeenCalledWith("bank-1", "q", { tags: ["tag-a"] });
  });

  it("delegates reflect to MemoryProvider with correct bankId", async () => {
    const memory = mockMemory();
    const svc = createService(memory, "user-123", [], stubFiles, stubCoreMemory, stubStage);

    await svc.memory.reflect("who is Alice?");

    expect(memory.reflect).toHaveBeenCalledWith("user-123", "who is Alice?", { tags: [] });
  });

  it("merges profileTags with caller-provided tags on reflect", async () => {
    const memory = mockMemory();
    const svc = createService(
      memory,
      "user-123",
      ["network:world"],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.reflect("query", { tags: ["extra"], budget: "mid" });

    expect(memory.reflect).toHaveBeenCalledWith("user-123", "query", {
      tags: ["network:world", "extra"],
      budget: "mid",
    });
  });

  it("delegates stageRetain to the injected closure with content and context", async () => {
    const memory = mockMemory();
    const stage = vi.fn().mockResolvedValue(undefined);
    const svc = createService(memory, "user-123", [], stubFiles, stubCoreMemory, stage);

    await svc.memory.stageRetain("a fact", { context: "from morning chat" });

    expect(stage).toHaveBeenCalledWith("a fact", { context: "from morning chat" });
  });

  it("stageRetain works with no opts", async () => {
    const memory = mockMemory();
    const stage = vi.fn().mockResolvedValue(undefined);
    const svc = createService(memory, "user-123", [], stubFiles, stubCoreMemory, stage);

    await svc.memory.stageRetain("a fact");

    expect(stage).toHaveBeenCalledWith("a fact");
  });

  it("stageRetain does not touch MemoryProvider", async () => {
    const memory = mockMemory();
    const stage = vi.fn().mockResolvedValue(undefined);
    const svc = createService(memory, "user-123", [], stubFiles, stubCoreMemory, stage);

    await svc.memory.stageRetain("a fact");

    expect(memory.retain).not.toHaveBeenCalled();
  });

  it("forwards reflect budget and tagsMatch, returns provider answer", async () => {
    const memory = mockMemory();
    const reflectMock = vi.fn().mockResolvedValue({ answer: "synthesized" });
    memory.reflect = reflectMock;
    const svc = createService(memory, "user-123", [], stubFiles, stubCoreMemory, stubStage);

    const result = await svc.memory.reflect("query", { budget: "high", tagsMatch: "any" });

    expect(reflectMock).toHaveBeenCalledWith("user-123", "query", {
      tags: [],
      budget: "high",
      tagsMatch: "any",
    });
    expect(result).toEqual({ answer: "synthesized" });
  });
});
