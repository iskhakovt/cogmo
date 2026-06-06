import { describe, expect, it, vi } from "vitest";
import { fakeRunInTx, mockAgentStore } from "../../test/factories.js";
import { InvalidNameError, UnknownModelError } from "../store/errors.js";
import { createSubAgent } from "./create-sub-agent.js";

describe("createSubAgent use case", () => {
  it("rejects an invalid name before touching the store", async () => {
    const agentStore = mockAgentStore();
    await expect(
      createSubAgent(
        { runInTx: fakeRunInTx, agentStore },
        { userId: "u1", name: "Bad Name", description: "d", systemPrompt: null, model: "m" },
      ),
    ).rejects.toBeInstanceOf(InvalidNameError);
    expect(agentStore.listProvidersForModel).not.toHaveBeenCalled();
    expect(agentStore.createSubAgent).not.toHaveBeenCalled();
  });

  it("rejects a blank description before touching the store", async () => {
    const agentStore = mockAgentStore();
    await expect(
      createSubAgent(
        { runInTx: fakeRunInTx, agentStore },
        { userId: "u1", name: "writer", description: "   ", systemPrompt: null, model: "m" },
      ),
    ).rejects.toThrow(/description/);
    expect(agentStore.listProvidersForModel).not.toHaveBeenCalled();
    expect(agentStore.createSubAgent).not.toHaveBeenCalled();
  });

  it("rejects a model with no provider routing", async () => {
    // mockAgentStore defaults listProvidersForModel → [] (no routing).
    const agentStore = mockAgentStore();
    await expect(
      createSubAgent(
        { runInTx: fakeRunInTx, agentStore },
        { userId: "u1", name: "writer", description: "d", systemPrompt: null, model: "ghost" },
      ),
    ).rejects.toBeInstanceOf(UnknownModelError);
    expect(agentStore.createSubAgent).not.toHaveBeenCalled();
  });

  it("inserts when the name is valid and the model is routable", async () => {
    const agentStore = mockAgentStore({
      listProvidersForModel: vi.fn().mockResolvedValue([{ providerId: "p1" }]),
    });
    const res = await createSubAgent(
      { runInTx: fakeRunInTx, agentStore },
      {
        userId: "u1",
        name: "writer",
        description: "prose",
        systemPrompt: "Be terse.",
        model: "claude-test",
      },
    );
    expect(res).toEqual({ id: "sub-agent-1" });
    expect(agentStore.createSubAgent).toHaveBeenCalledWith(expect.anything(), {
      userId: "u1",
      name: "writer",
      description: "prose",
      systemPrompt: "Be terse.",
      model: "claude-test",
    });
  });
});
