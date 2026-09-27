import { describe, expect, it, vi } from "vitest";
import { fakeRunInTx, mockAgentStore } from "../../test/factories.js";
import type { Profile } from "../store/index.js";
import type { ProfileMemoryScope } from "../store/schema.js";
import { loadCoreMemoryScope } from "./load-core-memory-scope.js";

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "p1",
    userId: "user-1",
    name: "assistant",
    basePrompt: "",
    model: "m",
    summarizationModel: null,
    extractionModel: null,
    autoRecall: "heuristic",
    voiceMode: "auto",
    toolSet: [],
    memoryScope: null,
    profileClass: null,
    streamChunkChars: 4000,
    streamEdits: true,
    codingAutoapproveMode: "off",
    ...overrides,
  };
}

function scopeWithTrust(trust: ProfileMemoryScope["trust"]): ProfileMemoryScope {
  return { compartments: ["work"], trust };
}

async function load(p: Profile | undefined) {
  const agentStore = mockAgentStore({
    listProfileClasses: vi.fn().mockResolvedValue([
      { name: "coder", restricted: false },
      { name: "game", restricted: true },
    ]),
  });
  const scope = await loadCoreMemoryScope(
    { runInTx: fakeRunInTx, agentStore },
    { userId: "user-7", profile: p },
  );
  return { scope, agentStore };
}

describe("loadCoreMemoryScope", () => {
  it("gives a profile without a class the unclassed bucket, without reading the registry", async () => {
    const { scope, agentStore } = await load(profile());

    expect(scope).toEqual({ kind: "unclassed" });
    expect(agentStore.listProfileClasses).not.toHaveBeenCalled();
  });

  it("gives a classed profile its class and the class's restricted flag from the user's registry", async () => {
    expect((await load(profile({ profileClass: "coder" }))).scope).toEqual({
      kind: "classed",
      profileClass: "coder",
      restricted: false,
    });
    const restricted = await load(profile({ profileClass: "game" }));
    expect(restricted.scope).toEqual({ kind: "classed", profileClass: "game", restricted: true });
    expect(restricted.agentStore.listProfileClasses).toHaveBeenCalledWith(
      expect.anything(),
      "user-7",
    );
  });

  it("admits a profile whose trust includes first-party", async () => {
    const { scope } = await load(
      profile({ profileClass: "coder", memoryScope: scopeWithTrust(["first-party", "any"]) }),
    );

    expect(scope).toEqual({ kind: "classed", profileClass: "coder", restricted: false });
  });

  it.each<[string, Profile | undefined]>([
    ["a third-party profile", profile({ memoryScope: scopeWithTrust(["any"]) })],
    [
      "a classed third-party profile",
      profile({ profileClass: "game", memoryScope: scopeWithTrust(["any"]) }),
    ],
    ["an unloadable profile", undefined],
  ])("gives %s no core memory", async (_name, p) => {
    expect((await load(p)).scope).toEqual({ kind: "none" });
  });
});
