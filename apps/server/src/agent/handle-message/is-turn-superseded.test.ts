import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import { FAKE_TX } from "../../test/factories.js";
import type { AgentStore } from "../store/index.js";
import { type IsTurnSupersededArgs, isTurnSuperseded } from "./is-turn-superseded.js";

const ARGS: IsTurnSupersededArgs = {
  conversationId: "conv",
  cursor: "in-2",
  afterMessageId: "asst-prev",
};

function harness(store: { answered: boolean; rebatched: boolean }) {
  const agentStore = mock<AgentStore>();
  agentStore.isCursorAnswered.mockResolvedValue(store.answered);
  agentStore.isCursorRebatched.mockResolvedValue(store.rebatched);
  const transactions: string[] = [];
  const runInTx: Transactor = (cb) => {
    transactions.push("tx");
    return cb(FAKE_TX);
  };
  return { deps: { runInTx, agentStore }, agentStore, transactions };
}

describe("isTurnSuperseded", () => {
  it("holds when another run answered the batch", async () => {
    const { deps } = harness({ answered: true, rebatched: false });

    expect(await isTurnSuperseded(deps, ARGS)).toBe(true);
  });

  it("holds when a later turn row re-batched the cursor", async () => {
    const { deps } = harness({ answered: false, rebatched: true });

    expect(await isTurnSuperseded(deps, ARGS)).toBe(true);
  });

  it("does not hold while no other reply owns the inbounds", async () => {
    const { deps } = harness({ answered: false, rebatched: false });

    expect(await isTurnSuperseded(deps, ARGS)).toBe(false);
  });

  it("asks both questions about rows newer than the answered reply, in one transaction", async () => {
    const { deps, agentStore, transactions } = harness({ answered: false, rebatched: false });

    await isTurnSuperseded(deps, ARGS);

    expect(transactions).toHaveLength(1);
    expect(agentStore.isCursorAnswered).toHaveBeenCalledWith(FAKE_TX, ARGS);
    expect(agentStore.isCursorRebatched).toHaveBeenCalledWith(FAKE_TX, ARGS);
  });
});
