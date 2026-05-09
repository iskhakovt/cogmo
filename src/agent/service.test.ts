import { describe, expect, it, vi } from "vitest";
import type { MemoryProvider } from "../memory/provider.js";
import { expectDefined } from "../test/assertions.js";
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
  it("delegates recall to the MemoryProvider with the right bankId, no filter applied, and returns its result", async () => {
    const memory = mockMemory();
    const expected = { memories: [{ content: "hi", type: "world" }] };
    memory.recall = vi.fn().mockResolvedValue(expected);
    const svc = createService(
      memory,
      "user-123",
      null,
      null,
      [],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    const result = await svc.memory.recall("query");

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {});
    expect(result).toBe(expected);
  });

  it("preserves caller-supplied tags / tagsMatch when no scope is set", async () => {
    const memory = mockMemory();
    const svc = createService(
      memory,
      "user-123",
      null,
      null,
      [],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.recall("query", { tags: ["preference"], tagsMatch: "all", maxTokens: 500 });

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {
      tags: ["preference"],
      tagsMatch: "all",
      maxTokens: 500,
    });
  });

  it("delegates retain to MemoryProvider unchanged (writes are never scope-filtered)", async () => {
    const memory = mockMemory();
    const svc = createService(
      memory,
      "user-123",
      null,
      null,
      [],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.retain("a fact", { context: "hi", tags: ["x"] });

    expect(memory.retain).toHaveBeenCalledWith("user-123", "a fact", {
      context: "hi",
      tags: ["x"],
    });
  });

  it("delegates reflect with budget passthrough", async () => {
    const memory = mockMemory();
    const svc = createService(
      memory,
      "user-123",
      null,
      null,
      [],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

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
      null,
      [],
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
      null,
      [],
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
      null,
      [],
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
      null,
      [],
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
      null,
      [],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.retain("a fact", { tags: ["custom"] });

    expect(memory.retain).toHaveBeenCalledWith("user-123", "a fact", { tags: ["custom"] });
  });

  it("reflect builds tagGroups, preserves budget, and returns the provider's result", async () => {
    const memory = mockMemory();
    const expected = { answer: "synthesized answer" };
    memory.reflect = vi.fn().mockResolvedValue(expected);
    const svc = createService(
      memory,
      "user-123",
      workScope(),
      null,
      [],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    const result = await svc.memory.reflect("query", { budget: "mid" });

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
    expect(result).toBe(expected);
  });
});

describe("createService — stageRetain", () => {
  it("delegates stageRetain to the injected closure with content and context", async () => {
    const memory = mockMemory();
    const stage = vi.fn().mockResolvedValue(undefined);
    const svc = createService(memory, "user-123", null, null, [], stubFiles, stubCoreMemory, stage);

    await svc.memory.stageRetain("a fact", { context: "from morning chat" });

    expect(stage).toHaveBeenCalledWith("a fact", { context: "from morning chat" });
  });

  it("stageRetain works with no opts", async () => {
    const memory = mockMemory();
    const stage = vi.fn().mockResolvedValue(undefined);
    const svc = createService(memory, "user-123", null, null, [], stubFiles, stubCoreMemory, stage);

    await svc.memory.stageRetain("a fact");

    expect(stage).toHaveBeenCalledWith("a fact");
  });

  it("stageRetain does not touch MemoryProvider", async () => {
    const memory = mockMemory();
    const stage = vi.fn().mockResolvedValue(undefined);
    const svc = createService(memory, "user-123", null, null, [], stubFiles, stubCoreMemory, stage);

    await svc.memory.stageRetain("a fact");

    expect(memory.retain).not.toHaveBeenCalled();
  });
});

describe("createService — speaker-isolation (profileClasses)", () => {
  it("emits a third any_strict leaf when scope.profileClasses is set", async () => {
    const memory = mockMemory();
    const scope: ProfileMemoryScope = {
      compartments: ["personal"],
      trust: ["first-party"],
      profileClasses: ["intimate"],
    };
    const svc = createService(
      memory,
      "user-123",
      scope,
      null,
      [],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.recall("query");

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {
      tagGroups: [
        {
          and: [
            { tags: ["compartment:personal"], match: "any_strict" },
            { tags: ["trust:first-party"], match: "any_strict" },
            { tags: ["profile_class:intimate"], match: "any_strict" },
          ],
        },
      ],
    });
  });

  it("ORs multiple profileClasses within the leaf (any_strict)", async () => {
    const memory = mockMemory();
    const scope: ProfileMemoryScope = {
      compartments: ["personal"],
      trust: ["first-party"],
      profileClasses: ["intimate", "general"],
    };
    const svc = createService(
      memory,
      "user-123",
      scope,
      null,
      [],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.recall("query");

    const call = vi.mocked(memory.recall).mock.calls[0];
    const tagGroups = call?.[2]?.tagGroups ?? [];
    const top = expectDefined(tagGroups[0]);
    if (!("and" in top)) throw new Error("expected top-level AND group");
    expect(top.and).toContainEqual({
      tags: ["profile_class:intimate", "profile_class:general"],
      match: "any_strict",
    });
  });

  it("omits the class leaf entirely when profileClasses is undefined (back-compat)", async () => {
    const memory = mockMemory();
    const scope: ProfileMemoryScope = {
      compartments: ["personal"],
      trust: ["first-party"],
    };
    const svc = createService(
      memory,
      "user-123",
      scope,
      null,
      [],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.recall("query");

    const call = vi.mocked(memory.recall).mock.calls[0];
    const tagGroups = call?.[2]?.tagGroups ?? [];
    const top = expectDefined(tagGroups[0]);
    if (!("and" in top)) throw new Error("expected top-level AND group");
    // No leaf with profile_class:* tags.
    for (const leaf of top.and) {
      if ("tags" in leaf) {
        for (const t of leaf.tags) {
          expect(t.startsWith("profile_class:")).toBe(false);
        }
      }
    }
  });

  it("retain stays unscoped on the speaker dimension too — writes are never gated", async () => {
    const memory = mockMemory();
    const scope: ProfileMemoryScope = {
      compartments: ["personal"],
      trust: ["first-party"],
      profileClasses: ["intimate"],
    };
    const svc = createService(
      memory,
      "user-123",
      scope,
      null,
      [],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.retain("a fact");

    expect(memory.retain).toHaveBeenCalledWith("user-123", "a fact", undefined);
  });
});

describe("createService — restricted-class fail-closed (NOT leaf)", () => {
  it("emits a NOT leaf for restricted classes when scope is null and speaker doesn't speak as them", async () => {
    const memory = mockMemory();
    const svc = createService(
      memory,
      "user-123",
      null,
      null,
      ["intimate"],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.recall("query");

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {
      tagGroups: [
        {
          and: [{ not: { tags: ["profile_class:intimate"], match: "any" } }],
        },
      ],
    });
  });

  it("preserves the today-fast-path when no scope and no restricted classes are configured", async () => {
    const memory = mockMemory();
    const svc = createService(
      memory,
      "user-123",
      null,
      null,
      [],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.recall("query");

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {});
  });

  it("auto-includes the speaker's own class even when scope is null — restricted speakers read their own writes", async () => {
    const memory = mockMemory();
    const svc = createService(
      memory,
      "user-123",
      null,
      "intimate",
      ["intimate", "secret"],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.recall("query");

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {
      tagGroups: [
        {
          and: [{ not: { tags: ["profile_class:secret"], match: "any" } }],
        },
      ],
    });
  });

  it("composes the NOT leaf alongside compartment/trust scope leaves", async () => {
    const memory = mockMemory();
    const scope: ProfileMemoryScope = {
      compartments: ["work"],
      trust: ["first-party"],
    };
    const svc = createService(
      memory,
      "user-123",
      scope,
      null,
      ["intimate"],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.recall("query");

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {
      tagGroups: [
        {
          and: [
            { tags: ["compartment:work"], match: "any_strict" },
            { tags: ["trust:first-party"], match: "any_strict" },
            { not: { tags: ["profile_class:intimate"], match: "any" } },
          ],
        },
      ],
    });
  });

  it("a restricted class explicitly opted into scope.profileClasses is dropped from the NOT leaf", async () => {
    const memory = mockMemory();
    const scope: ProfileMemoryScope = {
      compartments: ["personal"],
      trust: ["first-party"],
      profileClasses: ["intimate"],
    };
    const svc = createService(
      memory,
      "user-123",
      scope,
      null,
      ["intimate", "secret"],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.recall("query");

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {
      tagGroups: [
        {
          and: [
            { tags: ["compartment:personal"], match: "any_strict" },
            { tags: ["trust:first-party"], match: "any_strict" },
            { tags: ["profile_class:intimate"], match: "any_strict" },
            { not: { tags: ["profile_class:secret"], match: "any" } },
          ],
        },
      ],
    });
  });

  it("emits no NOT leaf when every restricted class is opted in via scope or speaker", async () => {
    const memory = mockMemory();
    const scope: ProfileMemoryScope = {
      compartments: ["personal"],
      trust: ["first-party"],
      profileClasses: ["secret"],
    };
    const svc = createService(
      memory,
      "user-123",
      scope,
      "intimate",
      ["intimate", "secret"],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.recall("query");

    const call = vi.mocked(memory.recall).mock.calls[0];
    const tagGroups = call?.[2]?.tagGroups ?? [];
    const top = expectDefined(tagGroups[0]);
    if (!("and" in top)) throw new Error("expected top-level AND group");
    for (const leaf of top.and) {
      expect("not" in leaf).toBe(false);
    }
  });

  it("retain is not affected by restricted classes — writes pass through", async () => {
    const memory = mockMemory();
    const svc = createService(
      memory,
      "user-123",
      null,
      null,
      ["intimate"],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.retain("a fact");

    expect(memory.retain).toHaveBeenCalledWith("user-123", "a fact", undefined);
  });

  it("reflect applies the NOT leaf the same way recall does", async () => {
    const memory = mockMemory();
    const svc = createService(
      memory,
      "user-123",
      null,
      null,
      ["intimate"],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.reflect("query", { budget: "low" });

    expect(memory.reflect).toHaveBeenCalledWith("user-123", "query", {
      budget: "low",
      tagGroups: [
        {
          and: [{ not: { tags: ["profile_class:intimate"], match: "any" } }],
        },
      ],
    });
  });
});

describe("createService — speaker auto-include in explicit any_strict leaf", () => {
  // Identity-aware filter: self-recall is structural, not a configuration
  // option. When the operator sets `classes=…` and forgets to include the
  // profile's own class, the Service still adds it — so a profile always
  // sees its own writes, matching the convention of every personal-context
  // system (email Sent folder, Drive owner-read, RLS `owner=current_user`).

  it("adds speakerClass to the any_strict leaf when not already in scope.profileClasses", async () => {
    const memory = mockMemory();
    const scope: ProfileMemoryScope = {
      compartments: ["personal"],
      trust: ["first-party"],
      profileClasses: ["general"],
    };
    const svc = createService(
      memory,
      "user-123",
      scope,
      "intimate",
      [],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.recall("query");

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {
      tagGroups: [
        {
          and: [
            { tags: ["compartment:personal"], match: "any_strict" },
            { tags: ["trust:first-party"], match: "any_strict" },
            {
              tags: ["profile_class:general", "profile_class:intimate"],
              match: "any_strict",
            },
          ],
        },
      ],
    });
  });

  it("does not duplicate the speaker class when already in the explicit list", async () => {
    const memory = mockMemory();
    const scope: ProfileMemoryScope = {
      compartments: ["personal"],
      trust: ["first-party"],
      profileClasses: ["general", "intimate"],
    };
    const svc = createService(
      memory,
      "user-123",
      scope,
      "intimate",
      [],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.recall("query");

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {
      tagGroups: [
        {
          and: [
            { tags: ["compartment:personal"], match: "any_strict" },
            { tags: ["trust:first-party"], match: "any_strict" },
            {
              tags: ["profile_class:general", "profile_class:intimate"],
              match: "any_strict",
            },
          ],
        },
      ],
    });
  });

  it("leaves the leaf unchanged when speakerClass is null (unclassed profile)", async () => {
    const memory = mockMemory();
    const scope: ProfileMemoryScope = {
      compartments: ["personal"],
      trust: ["first-party"],
      profileClasses: ["general"],
    };
    const svc = createService(
      memory,
      "user-123",
      scope,
      null,
      [],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.recall("query");

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {
      tagGroups: [
        {
          and: [
            { tags: ["compartment:personal"], match: "any_strict" },
            { tags: ["trust:first-party"], match: "any_strict" },
            { tags: ["profile_class:general"], match: "any_strict" },
          ],
        },
      ],
    });
  });

  it("composes with restricted-class NOT leaf: own class always recallable, other restricted classes excluded", async () => {
    // The motivating combined case: speaker = intimate (restricted),
    // operator scoped to ["general"] only, "secret" is also restricted.
    // Speaker should auto-include in any_strict; secret should still be
    // excluded by NOT leaf.
    const memory = mockMemory();
    const scope: ProfileMemoryScope = {
      compartments: ["personal"],
      trust: ["first-party"],
      profileClasses: ["general"],
    };
    const svc = createService(
      memory,
      "user-123",
      scope,
      "intimate",
      ["intimate", "secret"],
      stubFiles,
      stubCoreMemory,
      stubStage,
    );

    await svc.memory.recall("query");

    expect(memory.recall).toHaveBeenCalledWith("user-123", "query", {
      tagGroups: [
        {
          and: [
            { tags: ["compartment:personal"], match: "any_strict" },
            { tags: ["trust:first-party"], match: "any_strict" },
            {
              tags: ["profile_class:general", "profile_class:intimate"],
              match: "any_strict",
            },
            { not: { tags: ["profile_class:secret"], match: "any" } },
          ],
        },
      ],
    });
  });
});
