import { describe, expect, it, vi } from "vitest";
import type { MemoryProvider } from "../memory/provider.js";
import { createService } from "./service.js";

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
    const svc = createService(memory, "user-123", []);

    await svc.memory.recall("some query");

    expect(memory.recall).toHaveBeenCalledWith("user-123", "some query", { tags: [] });
  });

  it("delegates retain to MemoryProvider with correct bankId", async () => {
    const memory = mockMemory();
    const svc = createService(memory, "user-123", []);

    await svc.memory.retain("a fact");

    expect(memory.retain).toHaveBeenCalledWith("user-123", "a fact", { tags: [] });
  });

  it("merges profileTags with caller-provided tags on recall", async () => {
    const memory = mockMemory();
    const svc = createService(memory, "user-123", ["network:world", "network:opinion"]);

    await svc.memory.recall("query", { tags: ["extra"] });

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {
      tags: ["network:world", "network:opinion", "extra"],
    });
  });

  it("merges profileTags with caller-provided tags on retain", async () => {
    const memory = mockMemory();
    const svc = createService(memory, "user-123", ["network:world"]);

    await svc.memory.retain("fact", { tags: ["custom"] });

    expect(memory.retain).toHaveBeenCalledWith("user-123", "fact", {
      tags: ["network:world", "custom"],
    });
  });

  it("preserves non-tag options on recall", async () => {
    const memory = mockMemory();
    const svc = createService(memory, "user-123", []);

    await svc.memory.recall("query", { maxTokens: 500 });

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {
      maxTokens: 500,
      tags: [],
    });
  });

  it("preserves non-tag options on retain", async () => {
    const memory = mockMemory();
    const svc = createService(memory, "user-123", []);

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
    const svc = createService(memory, "bank-1", ["tag-a"]);

    await svc.memory.recall("q");
    await svc.memory.retain("f");

    expect(memory.recall).toHaveBeenCalledWith("bank-1", "q", { tags: ["tag-a"] });
    expect(memory.retain).toHaveBeenCalledWith("bank-1", "f", { tags: ["tag-a"] });
  });
});
