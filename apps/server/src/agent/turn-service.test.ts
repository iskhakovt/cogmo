import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { expectDefined } from "../test/assertions.js";
import {
  FAKE_TX,
  fakeRunInTx,
  mockAgentStore,
  mockFilesService,
  mockMemoryProvider,
} from "../test/factories.js";
import type { PipelinesService } from "./pipeline/pipelines-service.js";
import type { SchedulingService } from "./scheduling/scheduling-service.js";
import { buildTurnService, type TurnServiceArgs } from "./turn-service.js";

async function harness() {
  const agentStore = mockAgentStore({
    listProfileClasses: vi.fn().mockResolvedValue([
      { name: "intimate", restricted: true },
      { name: "general", restricted: false },
    ]),
  });
  const profile = expectDefined(await agentStore.getProfile(FAKE_TX, "profile-1"), "profile");
  const memory = mockMemoryProvider();
  const deps = { runInTx: fakeRunInTx, agentStore, memory, fileService: mockFilesService() };
  return { deps, agentStore, memory, profile };
}

const noNamespaces: Omit<TurnServiceArgs, "userId" | "profile"> = {
  coreMemoryScope: { kind: "unclassed" },
  coding: undefined,
  skills: undefined,
  scheduling: undefined,
  pipelines: undefined,
};

describe("buildTurnService", () => {
  it("scopes memory to the conversation user's bank and reads their restricted classes", async () => {
    const { deps, agentStore, memory, profile } = await harness();

    const service = await buildTurnService(deps, { userId: "user-7", profile, ...noNamespaces });
    await service.memory.retain("fact");

    expect(agentStore.listProfileClasses).toHaveBeenCalledWith(expect.anything(), "user-7");
    expect(memory.retain).toHaveBeenCalledWith("user-7", "fact", undefined);
  });

  it("routes core memory reads and writes to the user's unclassed scope", async () => {
    const { deps, agentStore, profile } = await harness();

    const service = await buildTurnService(deps, { userId: "user-7", profile, ...noNamespaces });
    await service.coreMemory.get();
    await service.coreMemory.update("persona", "terse");

    expect(agentStore.getCoreMemoryBlocks).toHaveBeenCalledWith(expect.anything(), "user-7", null);
    expect(agentStore.upsertCoreMemoryBlock).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-7",
      profileClass: null,
      key: "persona",
      content: "terse",
    });
  });

  it("confines core memory to the frozen class, not the profile row's", async () => {
    const { deps, agentStore, profile } = await harness();

    const service = await buildTurnService(deps, {
      userId: "user-7",
      profile: { ...profile, profileClass: null },
      ...noNamespaces,
      coreMemoryScope: { kind: "classed", profileClass: "intimate", restricted: true },
    });
    await service.coreMemory.get();
    const written = await service.coreMemory.update("identity", "Name: Thorin");

    expect(agentStore.getCoreMemoryBlocks).toHaveBeenCalledWith(
      expect.anything(),
      "user-7",
      "intimate",
    );
    expect(written._unsafeUnwrap()).toEqual({
      kind: "override",
      profileClass: "intimate",
      leftOut: [],
    });
    expect(agentStore.upsertCoreMemoryBlock).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-7",
      profileClass: "intimate",
      key: "identity",
      content: "Name: Thorin",
    });
  });

  it("gives a turn without core memory no blocks and refuses its writes", async () => {
    const { deps, agentStore, profile } = await harness();

    const service = await buildTurnService(deps, {
      userId: "user-7",
      profile,
      ...noNamespaces,
      coreMemoryScope: { kind: "none" },
    });

    expect(await service.coreMemory.get()).toEqual({ scope: { kind: "none" }, blocks: [] });
    expect((await service.coreMemory.update("identity", "x"))._unsafeUnwrapErr()).toEqual({
      code: "core_memory_unavailable",
    });
    expect(agentStore.getCoreMemoryBlocks).not.toHaveBeenCalled();
    expect(agentStore.upsertCoreMemoryBlock).not.toHaveBeenCalled();
  });

  it("stages live retains with the speaking profile's id snapshotted", async () => {
    const { deps, agentStore, profile } = await harness();

    const service = await buildTurnService(deps, { userId: "user-7", profile, ...noNamespaces });
    await service.memory.stageRetain("likes tea", { context: "chat" });

    expect(agentStore.stagePendingMemory).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-7",
      profileId: "profile-1",
      content: "likes tea",
      context: "chat",
      source: "live_retain",
    });
  });

  it("exposes exactly the optional namespaces the caller supplies", async () => {
    const { deps, profile } = await harness();
    const scheduling = mock<SchedulingService>();

    const withScheduling = await buildTurnService(deps, {
      userId: "user-7",
      profile,
      ...noNamespaces,
      scheduling,
    });
    expect(withScheduling.scheduling).toBe(scheduling);
    expect(withScheduling.pipelines).toBeUndefined();
    expect(withScheduling.coding).toBeUndefined();

    const pipelines = mock<PipelinesService>();
    const withPipelines = await buildTurnService(deps, {
      userId: "user-7",
      profile,
      ...noNamespaces,
      pipelines,
    });
    expect(withPipelines.pipelines).toBe(pipelines);
  });
});
