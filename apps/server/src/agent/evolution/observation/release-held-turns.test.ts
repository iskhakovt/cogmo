import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../../db/index.js";
import { mockAgentStore } from "../../../test/factories.js";
import type { AgentStore, HeldExtractedTurn, MemoryRule } from "../../store/index.js";
import type { ObserverFire } from "../drain-pending-memories.js";
import { releaseHeldTurns } from "./release-held-turns.js";
import type { TurnExtraction } from "./turn-extraction.js";

const FAKE_TX = { __mockTx: true } as never;

const FIRE: ObserverFire = {
  conversationId: "conv-1",
  userId: "user-1",
  profileId: "profile-fire",
  seesUserRules: false,
};

function userRule(profileId: string | null): MemoryRule {
  return { rule: `Don't save my health (${profileId ?? "all"})`, profileId, fromUser: true };
}

/** An operator's rule every profile sees: it binds no one. */
const OPERATOR_RULE: MemoryRule = { rule: "Keep facts short", profileId: null, fromUser: false };

function heldExtracted(
  id: string,
  extraction: Pick<TurnExtraction, "profileId" | "seesUserRules">,
): HeldExtractedTurn {
  return {
    id,
    extraction: {
      phase: "memories",
      runId: "run-0",
      profileClass: null,
      items: [],
      dropped: { noEvidence: 0 },
      ...extraction,
    },
  };
}

function setup(opts: {
  rules: ReadonlyArray<MemoryRule>;
  heldExtracted?: ReadonlyArray<HeldExtractedTurn>;
  store?: Partial<AgentStore>;
}) {
  let transactions = 0;
  const runInTx: Transactor = (cb) => {
    transactions++;
    return cb(FAKE_TX);
  };
  const store = mockAgentStore({
    getMemoryRules: vi.fn().mockResolvedValue(opts.rules),
    listHeldExtractedTurns: vi.fn().mockResolvedValue(opts.heldExtracted ?? []),
    releaseHeldTurns: vi.fn().mockResolvedValue(2),
    releaseHeldExtractedTurns: vi.fn(async (_tx, { ids }) => ids.length),
    ...opts.store,
  });
  return {
    store,
    transactions: () => transactions,
    release: (fire: ObserverFire) => releaseHeldTurns({ runInTx, store }, { fire }),
  };
}

describe("releaseHeldTurns", () => {
  it("releases the held turns once the fire's profile isn't bound", async () => {
    const { store, release } = setup({ rules: [OPERATOR_RULE, userRule("profile-other")] });

    expect(await release(FIRE)).toEqual({ released: 2 });
    expect(store.releaseHeldTurns).toHaveBeenCalledWith(FAKE_TX, { conversationId: "conv-1" });
  });

  it("releases the held turns of a fire that sees the user's rules, whatever rule applies", async () => {
    const { store, release } = setup({ rules: [userRule(null), userRule("profile-fire")] });

    expect(await release({ ...FIRE, seesUserRules: true })).toEqual({ released: 2 });
    expect(store.releaseHeldTurns).toHaveBeenCalledOnce();
  });

  it("keeps the held turns while a user's rule binds the fire's profile", async () => {
    const { store, release } = setup({ rules: [userRule("profile-fire")] });

    expect(await release(FIRE)).toEqual({ released: 0 });
    expect(store.releaseHeldTurns).not.toHaveBeenCalled();
  });

  it("judges each held extraction by the profile it recorded, not the fire's", async () => {
    const { store, release } = setup({
      rules: [userRule("profile-fire"), userRule("profile-bound"), userRule("profile-first-party")],
      heldExtracted: [
        heldExtracted("bound", { profileId: "profile-bound", seesUserRules: false }),
        heldExtracted("unbound", { profileId: "profile-free", seesUserRules: false }),
        heldExtracted("first-party", { profileId: "profile-first-party", seesUserRules: true }),
      ],
    });

    // The fire's profile is bound, so `held` stays; two extractions are released.
    expect(await release(FIRE)).toEqual({ released: 2 });
    expect(store.releaseHeldTurns).not.toHaveBeenCalled();
    expect(store.releaseHeldExtractedTurns).toHaveBeenCalledWith(FAKE_TX, {
      ids: ["unbound", "first-party"],
    });
  });

  it("keeps a held extraction its own profile is bound for, while releasing the fire's held turns", async () => {
    const { store, release } = setup({
      rules: [userRule("profile-bound")],
      heldExtracted: [heldExtracted("bound", { profileId: "profile-bound", seesUserRules: false })],
    });

    expect(await release({ ...FIRE, seesUserRules: true })).toEqual({ released: 2 });
    expect(store.releaseHeldExtractedTurns).toHaveBeenCalledWith(FAKE_TX, { ids: [] });
  });

  it("reads the rules once, for the fire's profile and every held extraction's", async () => {
    const { store, release } = setup({
      rules: [],
      heldExtracted: [
        heldExtracted("a", { profileId: "profile-a", seesUserRules: false }),
        heldExtracted("b", { profileId: "profile-fire", seesUserRules: false }),
        heldExtracted("c", { profileId: "profile-a", seesUserRules: false }),
      ],
    });

    await release(FIRE);

    expect(store.listHeldExtractedTurns).toHaveBeenCalledWith(FAKE_TX, {
      conversationId: "conv-1",
    });
    expect(store.getMemoryRules).toHaveBeenCalledOnce();
    expect(store.getMemoryRules).toHaveBeenCalledWith(FAKE_TX, {
      profileIds: ["profile-fire", "profile-a"],
      userId: "user-1",
    });
  });

  it("reads and releases in one transaction", async () => {
    const { transactions, release } = setup({
      rules: [],
      heldExtracted: [heldExtracted("a", { profileId: "profile-a", seesUserRules: false })],
    });

    expect(await release(FIRE)).toEqual({ released: 3 });
    expect(transactions()).toBe(1);
  });
});
