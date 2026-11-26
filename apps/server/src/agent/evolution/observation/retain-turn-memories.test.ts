import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../../db/index.js";
import type { MemoryProvider } from "../../../memory/provider.js";
import { expectDefined } from "../../../test/assertions.js";
import { mockAgentStore } from "../../../test/factories.js";
import type { AgentStore, MemoryRule, OpenTurn, TurnObservation } from "../../store/index.js";
import type { ObserverFire } from "../drain-pending-memories.js";
import { RetainUnavailableError } from "./failure.js";
import { retainTurnMemories } from "./retain-turn-memories.js";
import type { StoredMemory, TurnExtraction } from "./turn-extraction.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const TURN: OpenTurn = {
  observationId: "obs-1",
  cursor: "cursor-1",
  status: "extracted",
  firstMessageId: "msg-1",
  attempts: 0,
};

/** A first-party fire. */
const FIRE: ObserverFire = {
  conversationId: "conv-1",
  userId: "user-1",
  profileId: "profile-fire",
  seesUserRules: true,
};

/** A rule the user set for every profile, which a third-party profile can't see. */
const USER_RULE: MemoryRule = {
  rule: "Don't save anything about my health.",
  profileId: null,
  fromUser: true,
};

const HOMELAB: StoredMemory = {
  fact: "homelab IP is 10.0.10.10",
  network: "world",
  compartment: "technical",
  trust: "first-party",
  evidence: "My homelab IP is 10.0.10.10",
};

const TRAINS: StoredMemory = {
  fact: "prefers trains to flying",
  network: "bank",
  compartment: "personal",
  trust: "first-party",
  context: "while planning a trip",
  evidence: "I'd rather take the train",
};

const EXTRACTION: TurnExtraction = {
  phase: "memories",
  runId: "run-0",
  profileId: "profile-extracting",
  profileClass: "assistant",
  seesUserRules: true,
  items: [HOMELAB, TRAINS],
  dropped: { noEvidence: 2 },
};

function setup(opts: {
  extraction?: TurnExtraction;
  rules?: ReadonlyArray<MemoryRule>;
  fire?: ObserverFire;
  store?: Partial<AgentStore>;
}) {
  const row: TurnObservation = {
    status: "extracted",
    attempts: 0,
    extraction: opts.extraction ?? EXTRACTION,
  };
  const store = mockAgentStore({
    getTurnObservation: vi.fn().mockResolvedValue(row),
    getMemoryRules: vi.fn().mockResolvedValue(opts.rules ?? []),
    ...opts.store,
  });
  const memory = mock<Pick<MemoryProvider, "retainBatch">>();
  const run = () =>
    retainTurnMemories(
      { runInTx: fakeRunInTx, store, memory },
      { turn: TURN, fire: opts.fire ?? FIRE },
    );
  return { store, memory, run };
}

describe("retainTurnMemories", () => {
  it("retains each stored fact under the turn's positional document id, then applies the row", async () => {
    const { store, memory, run } = setup({});

    const outcome = await run();

    expect(outcome).toEqual({
      kind: "applied",
      byNetwork: { world: 1, bank: 1 },
      droppedNoEvidence: 2,
    });
    // Strict: an item without a context carries no `context` key.
    expect(memory.retainBatch).toHaveBeenCalledOnce();
    expect(memory.retainBatch.mock.calls[0]).toStrictEqual([
      "user-1",
      [
        {
          content: "homelab IP is 10.0.10.10",
          documentId: "observer:turn:cursor-1:0",
          tags: [
            "network:world",
            "compartment:technical",
            "trust:first-party",
            "profile_class:assistant",
          ],
          metadata: { source: "conversation" },
          observationScopes: "per_tag",
        },
        {
          content: "prefers trains to flying",
          documentId: "observer:turn:cursor-1:1",
          context: "while planning a trip",
          tags: [
            "network:bank",
            "compartment:personal",
            "trust:first-party",
            "profile_class:assistant",
          ],
          metadata: { source: "conversation" },
          observationScopes: "per_tag",
        },
      ],
    ]);
    expect(store.transitionExtractedTurn).toHaveBeenCalledWith(FAKE_TX, {
      id: "obs-1",
      to: "applied",
    });
    const retained = memory.retainBatch.mock.invocationCallOrder[0];
    const moved = vi.mocked(store.transitionExtractedTurn).mock.invocationCallOrder[0];
    expect(expectDefined(retained, "retain")).toBeLessThan(expectDefined(moved, "move"));
  });

  it("reads the rules of the profile the extraction recorded, on the row's transaction", async () => {
    const { store, run } = setup({});

    await run();

    expect(store.getMemoryRules).toHaveBeenCalledWith(FAKE_TX, {
      profileIds: ["profile-extracting"],
      userId: "user-1",
    });
  });

  it("tags no profile class when the extraction recorded none", async () => {
    const { memory, run } = setup({ extraction: { ...EXTRACTION, profileClass: null } });

    await run();

    const [, items] = expectDefined(memory.retainBatch.mock.calls[0], "retain");
    expect(items.map((i) => i.tags)).toEqual([
      ["network:world", "compartment:technical", "trust:first-party"],
      ["network:bank", "compartment:personal", "trust:first-party"],
    ]);
  });

  it("applies a turn with no facts without a retain", async () => {
    const { store, memory, run } = setup({
      extraction: { ...EXTRACTION, items: [], dropped: { noEvidence: 1 } },
    });

    expect(await run()).toEqual({ kind: "applied", byNetwork: {}, droppedNoEvidence: 1 });
    expect(memory.retainBatch).not.toHaveBeenCalled();
    expect(store.transitionExtractedTurn).toHaveBeenCalledWith(FAKE_TX, {
      id: "obs-1",
      to: "applied",
    });
  });

  it("holds the row when a rule binds the extracting profile, though the fire's profile is first-party", async () => {
    const { store, memory, run } = setup({
      extraction: { ...EXTRACTION, profileId: "profile-third-party", seesUserRules: false },
      rules: [USER_RULE],
      fire: FIRE,
    });

    expect(await run()).toEqual({ kind: "held" });
    expect(store.getMemoryRules).toHaveBeenCalledWith(FAKE_TX, {
      profileIds: ["profile-third-party"],
      userId: "user-1",
    });
    expect(memory.retainBatch).not.toHaveBeenCalled();
    expect(store.transitionExtractedTurn).toHaveBeenCalledOnce();
    expect(store.transitionExtractedTurn).toHaveBeenCalledWith(FAKE_TX, {
      id: "obs-1",
      to: "held_extracted",
    });
  });

  it("applies a bound extraction with no facts, since nothing in it can be forbidden", async () => {
    const { store, run } = setup({
      extraction: {
        ...EXTRACTION,
        profileId: "profile-third-party",
        seesUserRules: false,
        items: [],
      },
      rules: [USER_RULE],
    });

    expect(await run()).toMatchObject({ kind: "applied" });
    expect(store.transitionExtractedTurn).toHaveBeenCalledWith(FAKE_TX, {
      id: "obs-1",
      to: "applied",
    });
  });

  it("never holds an extraction whose profile saw the user's rules, though the fire's is bound", async () => {
    const { store, memory, run } = setup({
      rules: [USER_RULE],
      fire: { ...FIRE, seesUserRules: false },
    });

    expect(await run()).toMatchObject({ kind: "applied" });
    expect(memory.retainBatch).toHaveBeenCalledOnce();
    expect(store.transitionExtractedTurn).toHaveBeenCalledWith(FAKE_TX, {
      id: "obs-1",
      to: "applied",
    });
  });

  it("rethrows a failed retain as unavailable and leaves the row `extracted`", async () => {
    const { store, memory, run } = setup({});
    const refused = new Error("hindsight: 503 Service Unavailable");
    memory.retainBatch.mockRejectedValue(refused);

    const thrown = await run().catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(RetainUnavailableError);
    expect(thrown).toMatchObject({ name: "RetainUnavailableError", cause: refused });
    expect(store.transitionExtractedTurn).not.toHaveBeenCalled();
  });

  it.each<TurnObservation>([
    { status: "applied", attempts: 0 },
    { status: "held_extracted", attempts: 0, extraction: EXTRACTION },
    { status: "failed", attempts: 3 },
  ])("retains nothing on a row another run moved to $status", async (row) => {
    const { store, memory, run } = setup({
      store: { getTurnObservation: vi.fn().mockResolvedValue(row) },
    });

    expect(await run()).toEqual({ kind: "taken", status: row.status });
    expect(store.getMemoryRules).not.toHaveBeenCalled();
    expect(memory.retainBatch).not.toHaveBeenCalled();
    expect(store.transitionExtractedTurn).not.toHaveBeenCalled();
  });

  it("reports another run's move when the row left `extracted` during the retain", async () => {
    const { memory, run } = setup({
      store: {
        transitionExtractedTurn: vi.fn().mockResolvedValue({ kind: "stale", status: "applied" }),
      },
    });

    expect(await run()).toEqual({ kind: "taken", status: "applied" });
    expect(memory.retainBatch).toHaveBeenCalledOnce();
  });

  it("reports another run's move when the row left `extracted` before the hold", async () => {
    const { run } = setup({
      extraction: { ...EXTRACTION, seesUserRules: false },
      rules: [USER_RULE],
      store: {
        transitionExtractedTurn: vi.fn().mockResolvedValue({ kind: "stale", status: "applied" }),
      },
    });

    expect(await run()).toEqual({ kind: "taken", status: "applied" });
  });
});
