import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "../../db/index.js";
import { mockTransportStore } from "../../test/factories.js";
import { closeSession, missedClose } from "./close-session.js";

const FAKE_TX = { __mockTx: true } as never as Transaction;

describe("closeSession", () => {
  it("runs the store transition and returns its outcome", async () => {
    const transportStore = mockTransportStore({
      closeSession: vi.fn().mockResolvedValue({ kind: "stale", status: "closed" }),
    });

    const outcome = await closeSession({ transportStore }, FAKE_TX, "session-1");

    expect(transportStore.closeSession).toHaveBeenCalledWith(expect.anything(), "session-1");
    expect(outcome).toEqual({ kind: "stale", status: "closed" });
  });
});

describe("missedClose", () => {
  it("is undefined for a close that landed", () => {
    expect(missedClose({ kind: "closed" })).toBeUndefined();
  });

  it("hands back what a close found instead", () => {
    expect(missedClose({ kind: "stale", status: "closed" })).toEqual({
      kind: "stale",
      status: "closed",
    });
    expect(missedClose({ kind: "not_found" })).toEqual({ kind: "not_found" });
  });
});
