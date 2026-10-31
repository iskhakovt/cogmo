import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../../db/index.js";
import { mockAgentStore } from "../../../test/factories.js";
import { skipEmptyTurn } from "./skip-empty-turn.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

describe("skipEmptyTurn", () => {
  it("skips a pending turn as empty", async () => {
    const store = mockAgentStore();

    expect(
      await skipEmptyTurn({ runInTx: fakeRunInTx, store }, { observationId: "obs-1" }),
    ).toEqual({ kind: "skipped", reason: "empty" });
    expect(store.transitionPendingTurn).toHaveBeenCalledWith(FAKE_TX, {
      id: "obs-1",
      to: { status: "skipped", reason: "empty" },
    });
  });

  it("reports the status another run moved the row to", async () => {
    const store = mockAgentStore({
      transitionPendingTurn: vi.fn().mockResolvedValue({ kind: "stale", status: "applied" }),
    });

    expect(
      await skipEmptyTurn({ runInTx: fakeRunInTx, store }, { observationId: "obs-1" }),
    ).toEqual({ kind: "taken", status: "applied" });
  });
});
