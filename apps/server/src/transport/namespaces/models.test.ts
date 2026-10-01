import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import { mockAgentStore } from "../../test/factories.js";
import { createModels } from "./models.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

function setup(overrides?: { agentStore?: ReturnType<typeof mockAgentStore> }) {
  const agentStore = overrides?.agentStore ?? mockAgentStore();
  const models = createModels({ runInTx: fakeRunInTx, agentStore });
  return { models, agentStore };
}

describe("models.list", () => {
  it("delegates to agentStore.listDistinctUserSelectableModels", async () => {
    const agentStore = mockAgentStore({
      listDistinctUserSelectableModels: vi.fn().mockResolvedValue(["claude-sonnet-4-6", "gpt-4o"]),
    });
    const { models } = setup({ agentStore });
    expect(await models.list()).toEqual(["claude-sonnet-4-6", "gpt-4o"]);
  });
});
