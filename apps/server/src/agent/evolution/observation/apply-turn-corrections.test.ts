import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../../db/index.js";
import { expectDefined } from "../../../test/assertions.js";
import { mockAgentStore } from "../../../test/factories.js";
import type { ExtractionRule } from "../../store/index.js";
import type { CorrectionItem } from "../extraction-schema.js";
import { applyTurnCorrections } from "./apply-turn-corrections.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const RULE: ExtractionRule = {
  id: "rule-1",
  rule: "Be concise",
  category: "style",
  status: "live",
  observationCount: 2,
  priority: 100,
  channelType: null,
};

const REINFORCE: CorrectionItem = {
  action: "reinforce",
  matchedExistingRuleId: "R1",
  rule: "Be concise",
  category: "style",
  reasoning: "again",
  evidence: "shorter",
};

function args() {
  return {
    observationId: "obs-1",
    corrections: {
      items: [REINFORCE],
      rulesByLabel: new Map([["R1", { ...RULE, setByUser: false }]]),
    },
    droppedNoEvidence: 1,
    scope: { profileId: "profile-1", userId: "user-1", seesUserRules: true },
    activeChannelTypes: [],
  };
}

describe("applyTurnCorrections", () => {
  it("moves the row, then writes the rules, on one transaction", async () => {
    let transactions = 0;
    const runInTx: Transactor = (cb) => {
      transactions++;
      return cb(FAKE_TX);
    };
    const store = mockAgentStore();

    const outcome = await applyTurnCorrections({ runInTx, store }, args());

    expect(outcome).toMatchObject({
      kind: "applied",
      result: { reinforced: 1 },
      droppedNoEvidence: 1,
    });
    expect(transactions).toBe(1);
    expect(store.transitionPendingTurn).toHaveBeenCalledWith(FAKE_TX, {
      id: "obs-1",
      to: { status: "applied" },
    });
    const moved = vi.mocked(store.transitionPendingTurn).mock.invocationCallOrder[0];
    const wrote = vi.mocked(store.upsertCorrection).mock.invocationCallOrder[0];
    expect(expectDefined(moved, "move")).toBeLessThan(expectDefined(wrote, "write"));
  });

  it("writes nothing when another run moved the row first", async () => {
    const store = mockAgentStore({
      transitionPendingTurn: vi.fn().mockResolvedValue({ kind: "stale", status: "applied" }),
    });

    expect(await applyTurnCorrections({ runInTx: fakeRunInTx, store }, args())).toEqual({
      kind: "taken",
      status: "applied",
    });
    expect(store.upsertCorrection).not.toHaveBeenCalled();
    expect(store.countLiveLearnedRules).not.toHaveBeenCalled();
  });
});
