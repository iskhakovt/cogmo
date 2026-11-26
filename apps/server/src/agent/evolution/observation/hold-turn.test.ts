import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../../db/index.js";
import { mockAgentStore } from "../../../test/factories.js";
import { holdTurn } from "./hold-turn.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

describe("holdTurn", () => {
  it("holds a pending turn", async () => {
    const store = mockAgentStore();

    expect(await holdTurn({ runInTx: fakeRunInTx, store }, { observationId: "obs-1" })).toEqual({
      kind: "held",
    });
    expect(store.transitionPendingTurn).toHaveBeenCalledWith(FAKE_TX, {
      id: "obs-1",
      to: { status: "held" },
    });
  });

  it("reports the status another run moved the row to", async () => {
    const store = mockAgentStore({
      transitionPendingTurn: vi.fn().mockResolvedValue({ kind: "stale", status: "extracted" }),
    });

    expect(await holdTurn({ runInTx: fakeRunInTx, store }, { observationId: "obs-1" })).toEqual({
      kind: "taken",
      status: "extracted",
    });
  });
});
