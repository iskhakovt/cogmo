import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../../db/index.js";
import { mockAgentStore } from "../../../test/factories.js";
import { recordTurnAttempt } from "./record-turn-attempt.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const PARSE = { kind: "parse" as const, message: "bad json" };
const EXHAUSTED = { kind: "exhausted" as const, message: "connection reset" };

describe("recordTurnAttempt", () => {
  it("counts a failure short of the cap, guarded on the count the caller read", async () => {
    const store = mockAgentStore();

    const outcome = await recordTurnAttempt(
      { runInTx: fakeRunInTx, store },
      { observationId: "obs-1", from: "pending", seen: 1, failure: PARSE },
    );

    expect(outcome).toEqual({ kind: "retryLater", attempts: 2, failure: "parse" });
    expect(store.recordTurnAttempt).toHaveBeenCalledWith(FAKE_TX, {
      id: "obs-1",
      from: "pending",
      seen: 1,
      failure: PARSE,
      giveUp: false,
    });
  });

  it("guards the count on the status the caller read, `extracted` included", async () => {
    const store = mockAgentStore();

    const outcome = await recordTurnAttempt(
      { runInTx: fakeRunInTx, store },
      { observationId: "obs-1", from: "extracted", seen: 0, failure: EXHAUSTED },
    );

    expect(outcome).toEqual({ kind: "retryLater", attempts: 1, failure: "exhausted" });
    expect(store.recordTurnAttempt).toHaveBeenCalledWith(FAKE_TX, {
      id: "obs-1",
      from: "extracted",
      seen: 0,
      failure: EXHAUSTED,
      giveUp: false,
    });
  });

  it("fails the turn at the third count", async () => {
    const store = mockAgentStore();

    const outcome = await recordTurnAttempt(
      { runInTx: fakeRunInTx, store },
      {
        observationId: "obs-1",
        from: "pending",
        seen: 2,
        failure: { kind: "exhausted", message: "reset" },
      },
    );

    expect(outcome).toEqual({ kind: "failed", attempts: 3, failure: "exhausted" });
    expect(store.recordTurnAttempt).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ giveUp: true }),
    );
  });

  it("fails the turn at once on a failure every attempt repeats", async () => {
    const store = mockAgentStore();

    const outcome = await recordTurnAttempt(
      { runInTx: fakeRunInTx, store },
      {
        observationId: "obs-1",
        from: "pending",
        seen: 0,
        failure: { kind: "refusal", message: "no" },
      },
    );

    expect(outcome).toEqual({ kind: "failed", attempts: 1, failure: "refusal" });
  });

  it("counts nothing once the row has moved since the count was read: a re-run after its commit", async () => {
    const store = mockAgentStore({
      recordTurnAttempt: vi.fn().mockResolvedValue({ kind: "stale", status: "pending" }),
    });

    const outcome = await recordTurnAttempt(
      { runInTx: fakeRunInTx, store },
      { observationId: "obs-1", from: "pending", seen: 0, failure: PARSE },
    );

    expect(outcome).toEqual({ kind: "taken", status: "pending" });
  });
});
