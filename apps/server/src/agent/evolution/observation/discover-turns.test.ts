import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../../db/index.js";
import { mockAgentStore } from "../../../test/factories.js";
import type { PendingTurn } from "../../store/index.js";
import { discoverTurns } from "./discover-turns.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

function pendingTurns(n: number): PendingTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    observationId: `obs-${i}`,
    cursor: `cursor-${i}`,
    firstMessageId: `msg-${i}`,
    attempts: 0,
  }));
}

describe("discoverTurns", () => {
  it("observes chat turns, and skips a scheduled or pipeline turn's corrections", async () => {
    const store = mockAgentStore({
      listUndiscoveredTurns: vi.fn().mockResolvedValue([
        { cursor: "c-chat", kind: "chat" },
        { cursor: "c-scheduled", kind: "scheduled" },
        { cursor: "c-pipeline", kind: "pipeline" },
      ]),
    });

    const plan = await discoverTurns(
      { runInTx: fakeRunInTx, store },
      { conversationId: "conv-1", limit: 10 },
    );

    expect(store.insertTurnObservations).toHaveBeenCalledWith(expect.anything(), {
      conversationId: "conv-1",
      phase: "corrections",
      turns: [
        { cursor: "c-chat", kind: "chat", disposition: { status: "pending" } },
        {
          cursor: "c-scheduled",
          kind: "scheduled",
          disposition: { status: "skipped", reason: "not_user_speech" },
        },
        {
          cursor: "c-pipeline",
          kind: "pipeline",
          disposition: { status: "skipped", reason: "not_user_speech" },
        },
      ],
    });
    expect(plan.notUserSpeech).toBe(2);
  });

  it("plans up to the cap, oldest first, and counts the rest", async () => {
    const store = mockAgentStore({ listPendingTurns: vi.fn().mockResolvedValue(pendingTurns(5)) });

    const plan = await discoverTurns(
      { runInTx: fakeRunInTx, store },
      { conversationId: "conv-1", limit: 3 },
    );

    expect(plan.turns.map((t) => t.observationId)).toEqual(["obs-0", "obs-1", "obs-2"]);
    expect(plan.remaining).toBe(2);
  });

  it("inserts and plans in one transaction, so a retry plans from the rows it wrote", async () => {
    let transactions = 0;
    const runInTx: Transactor = (cb) => {
      transactions++;
      return cb(FAKE_TX);
    };
    const store = mockAgentStore();

    await discoverTurns({ runInTx, store }, { conversationId: "conv-1", limit: 3 });

    expect(transactions).toBe(1);
  });
});
