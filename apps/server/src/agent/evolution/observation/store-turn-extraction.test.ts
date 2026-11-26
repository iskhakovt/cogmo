import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../../db/index.js";
import { mockAgentStore } from "../../../test/factories.js";
import { storeTurnExtraction } from "./store-turn-extraction.js";
import type { TurnExtraction } from "./turn-extraction.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const EXTRACTION: TurnExtraction = {
  phase: "memories",
  runId: "run-1",
  profileId: "profile-1",
  profileClass: "assistant",
  seesUserRules: true,
  items: [
    {
      fact: "homelab IP is 10.0.10.10",
      network: "world",
      compartment: "technical",
      trust: "first-party",
      evidence: "My homelab IP is 10.0.10.10",
    },
  ],
  dropped: { noEvidence: 1 },
};

describe("storeTurnExtraction", () => {
  it("moves a pending turn to `extracted`, writing the extraction with the move", async () => {
    const store = mockAgentStore();

    const stored = await storeTurnExtraction(
      { runInTx: fakeRunInTx, store },
      { observationId: "obs-1", extraction: EXTRACTION },
    );

    expect(stored).toEqual({ kind: "stored" });
    expect(store.transitionPendingTurn).toHaveBeenCalledOnce();
    expect(store.transitionPendingTurn).toHaveBeenCalledWith(FAKE_TX, {
      id: "obs-1",
      to: { status: "extracted", extraction: EXTRACTION },
    });
  });

  it("reports the status another run moved the row to", async () => {
    const store = mockAgentStore({
      transitionPendingTurn: vi.fn().mockResolvedValue({ kind: "stale", status: "extracted" }),
    });

    const stored = await storeTurnExtraction(
      { runInTx: fakeRunInTx, store },
      { observationId: "obs-1", extraction: EXTRACTION },
    );

    expect(stored).toEqual({ kind: "stale", status: "extracted" });
  });
});
