import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { fakeRunInTx, mockAgentStore } from "../../test/factories.js";
import { createSubAgent } from "./create-sub-agent.js";

describe("createSubAgent use case", () => {
  it("rejects an invalid name before touching the store", async () => {
    const agentStore = mockAgentStore();
    const res = await createSubAgent(
      { runInTx: fakeRunInTx, agentStore },
      { userId: "u1", name: "Bad Name", description: "d", systemPrompt: null, model: "m" },
    );
    expect(res).toEqual(err({ kind: "invalid_name", name: "Bad Name", subject: "sub_agent" }));
    expect(agentStore.listProvidersForModel).not.toHaveBeenCalled();
    expect(agentStore.createSubAgent).not.toHaveBeenCalled();
  });

  it("rejects a blank description before touching the store", async () => {
    const agentStore = mockAgentStore();
    const res = await createSubAgent(
      { runInTx: fakeRunInTx, agentStore },
      { userId: "u1", name: "writer", description: "   ", systemPrompt: null, model: "m" },
    );
    expect(res).toEqual(err({ kind: "description_empty" }));
    expect(agentStore.listProvidersForModel).not.toHaveBeenCalled();
    expect(agentStore.createSubAgent).not.toHaveBeenCalled();
  });

  it("rejects a model with no provider routing", async () => {
    // mockAgentStore defaults listProvidersForModel → [] (no routing).
    const agentStore = mockAgentStore();
    const res = await createSubAgent(
      { runInTx: fakeRunInTx, agentStore },
      { userId: "u1", name: "writer", description: "d", systemPrompt: null, model: "ghost" },
    );
    expect(res).toEqual(err({ kind: "unknown_model", model: "ghost" }));
    expect(agentStore.createSubAgent).not.toHaveBeenCalled();
  });

  it("passes the store's name collision through", async () => {
    const taken = { kind: "sub_agent_name_taken", name: "writer" } as const;
    const agentStore = mockAgentStore({
      listProvidersForModel: vi.fn().mockResolvedValue([{ providerId: "p1" }]),
      createSubAgent: vi.fn().mockResolvedValue(err(taken)),
    });
    const res = await createSubAgent(
      { runInTx: fakeRunInTx, agentStore },
      { userId: "u1", name: "writer", description: "d", systemPrompt: null, model: "m" },
    );
    expect(res).toEqual(err(taken));
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
    expect(res).toEqual(ok({ id: "sub-agent-1" }));
    expect(agentStore.createSubAgent).toHaveBeenCalledWith(expect.anything(), {
      userId: "u1",
      name: "writer",
      description: "prose",
      systemPrompt: "Be terse.",
      model: "claude-test",
    });
  });
});
