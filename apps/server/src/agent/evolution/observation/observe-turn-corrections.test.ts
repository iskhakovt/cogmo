import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../../db/index.js";
import { RefusalError } from "../../../llm/fallback.js";
import type { LlmProvider } from "../../../llm/provider.js";
import { expectDefined } from "../../../test/assertions.js";
import { mockAgentStore, mockProvider } from "../../../test/factories.js";
import type { AgentStore, ExtractionRule, TurnMessage } from "../../store/index.js";
import { observeTurnCorrections } from "./observe-turn-corrections.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const TURN = { observationId: "obs-1", cursor: "cursor-1", firstMessageId: "msg-1" };
const SCOPE = { profileId: "profile-1", userId: "user-1", seesUserRules: true };
const SAID = "No, shorter please. I keep asking.";

const IMAGE = {
  type: "image_ref" as const,
  path: "a.png",
  mediaType: "image/png" as const,
  width: 1,
  height: 1,
  bytes: 1,
  original: { path: "a.png", mediaType: "image/png" },
};

const LEARNING: ExtractionRule = {
  id: "rule-1",
  rule: "Keep replies long",
  category: "style",
  status: "learning",
  observationCount: 1,
  priority: 100,
  channelType: null,
};

function rows(userText: string, extra: ReadonlyArray<TurnMessage>): TurnMessage[] {
  return [
    ...extra,
    { id: "msg-1", role: "user", content: userText, cursor: TURN.cursor },
    { id: "msg-2", role: "assistant", content: "Fine.", cursor: TURN.cursor },
  ];
}

function answering(corrections: ReadonlyArray<Record<string, unknown>>): LlmProvider {
  return mockProvider({
    chat: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ corrections }) }],
      stopReason: "end_turn",
      model: "mock",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  });
}

function throwing(err: unknown): LlmProvider {
  return mockProvider({ chat: vi.fn().mockRejectedValue(err) });
}

const CONTRADICTION = {
  action: "contradiction",
  matchedExistingRuleId: "R1",
  rule: "Short replies",
  category: "style",
  reasoning: "retracts",
  evidence: "shorter please",
};

function setup(opts: {
  provider: LlmProvider;
  status?: "pending" | "applied";
  attempts?: number;
  store?: Partial<AgentStore>;
}) {
  const store = mockAgentStore({
    getTurnObservation: vi.fn().mockResolvedValue({
      status: opts.status ?? "pending",
      attempts: opts.attempts ?? 0,
    }),
    listTurnMessages: vi.fn().mockResolvedValue(rows(SAID, [])),
    getCorrections: vi.fn().mockResolvedValue([LEARNING]),
    ...opts.store,
  });
  const deps = { provider: opts.provider, model: "m", runInTx: fakeRunInTx, store };
  const run = () =>
    observeTurnCorrections(deps, {
      conversationId: "conv-1",
      turn: TURN,
      scope: SCOPE,
      activeChannelTypes: [],
    });
  return { store, provider: opts.provider, run };
}

describe("observeTurnCorrections", () => {
  it("applies the turn's corrections on the transaction that moves its row, keyed on the row", async () => {
    const { store, run } = setup({ provider: answering([CONTRADICTION]) });

    const outcome = await run();

    expect(outcome).toMatchObject({ kind: "applied", result: { reset: 1 }, droppedNoEvidence: 0 });
    expect(store.transitionPendingTurn).toHaveBeenCalledWith(FAKE_TX, {
      id: "obs-1",
      to: { status: "applied" },
    });
    expect(store.contradictLearningRule).toHaveBeenCalledWith(FAKE_TX, {
      id: "rule-1",
      turnObservationId: "obs-1",
    });
    const moved = vi.mocked(store.transitionPendingTurn).mock.invocationCallOrder[0];
    const wrote = vi.mocked(store.contradictLearningRule).mock.invocationCallOrder[0];
    expect(expectDefined(moved, "move")).toBeLessThan(expectDefined(wrote, "write"));
  });

  it("calls no model for a row that already left `pending`", async () => {
    const { store, provider, run } = setup({ provider: answering([]), status: "applied" });

    expect(await run()).toEqual({ kind: "done", status: "applied" });
    expect(provider.chat).not.toHaveBeenCalled();
    expect(store.listTurnMessages).not.toHaveBeenCalled();
  });

  it("writes nothing when another run moved the row first", async () => {
    const { store, run } = setup({
      provider: answering([CONTRADICTION]),
      store: {
        transitionPendingTurn: vi.fn().mockResolvedValue({ kind: "stale", status: "applied" }),
      },
    });

    expect(await run()).toEqual({ kind: "taken", status: "applied" });
    expect(store.contradictLearningRule).not.toHaveBeenCalled();
    expect(store.upsertCorrection).not.toHaveBeenCalled();
  });

  it("skips a turn with no user text without calling the model", async () => {
    const { store, provider, run } = setup({
      provider: answering([]),
      store: {
        listTurnMessages: vi
          .fn()
          .mockResolvedValue(
            rows("", []).map((r) => (r.role === "user" ? { ...r, content: [IMAGE] } : r)),
          ),
      },
    });

    expect(await run()).toEqual({ kind: "skipped", reason: "empty" });
    expect(provider.chat).not.toHaveBeenCalled();
    expect(store.transitionPendingTurn).toHaveBeenCalledWith(FAKE_TX, {
      id: "obs-1",
      to: { status: "skipped", reason: "empty" },
    });
  });

  it("drops an item whose evidence the user didn't say", async () => {
    const { store, run } = setup({
      provider: answering([{ ...CONTRADICTION, evidence: "use long replies" }]),
    });

    expect(await run()).toMatchObject({ kind: "applied", droppedNoEvidence: 1 });
    expect(store.contradictLearningRule).not.toHaveBeenCalled();
  });

  it("gives the model the turn answered before this one as context", async () => {
    const earlier: TurnMessage[] = [
      { id: "msg-a", role: "user", content: "Tell me about trams.", cursor: "cursor-0" },
      { id: "msg-b", role: "assistant", content: "Trams are long ...", cursor: "cursor-0" },
    ];
    const { store, provider, run } = setup({
      provider: answering([]),
      store: {
        findAnsweredCursorBefore: vi.fn().mockResolvedValue("cursor-0"),
        listTurnMessages: vi.fn().mockResolvedValue(rows(SAID, earlier)),
      },
    });

    await run();

    expect(store.findAnsweredCursorBefore).toHaveBeenCalledWith(FAKE_TX, "conv-1", "msg-1");
    expect(store.listTurnMessages).toHaveBeenCalledWith(FAKE_TX, "conv-1", [
      "cursor-1",
      "cursor-0",
    ]);
    const call = expectDefined(vi.mocked(provider.chat).mock.calls[0], "chat call");
    expect(call[0].messages[0]?.content).toBe(
      `<earlier_conversation>\nUser: Tell me about trams.\n\nAssistant: Trams are long ...\n</earlier_conversation>\n\n<turn>\nUser: ${SAID}\n\nAssistant: Fine.\n</turn>`,
    );
  });

  describe("a failure", () => {
    const UNPARSEABLE = answering([{ action: "reinforce", rule: "x", category: "style" }]);

    it("counts one the turn caused, for a later fire to retry", async () => {
      const { store, run } = setup({ provider: UNPARSEABLE });

      expect(await run()).toEqual({ kind: "retryLater", attempts: 1, failure: "parse" });
      expect(store.recordTurnAttempt).toHaveBeenCalledWith(FAKE_TX, {
        id: "obs-1",
        seen: 0,
        failure: { kind: "parse", message: expect.any(String) },
        to: "pending",
      });
      expect(store.transitionPendingTurn).not.toHaveBeenCalled();
    });

    it("fails the turn on its third", async () => {
      const { store, run } = setup({ provider: UNPARSEABLE, attempts: 2 });

      expect(await run()).toEqual({ kind: "failed", attempts: 3, failure: "parse" });
      expect(store.recordTurnAttempt).toHaveBeenCalledWith(
        FAKE_TX,
        expect.objectContaining({ seen: 2, to: "failed" }),
      );
    });

    it("fails the turn at once on one every attempt repeats", async () => {
      const { run } = setup({ provider: throwing(new RefusalError("refused")) });

      expect(await run()).toEqual({ kind: "failed", attempts: 1, failure: "refusal" });
    });

    it("rethrows one the turn didn't cause, and records nothing", async () => {
      const outage = Object.assign(new Error("overloaded"), { status: 529 });
      const { store, run } = setup({ provider: throwing(outage) });

      await expect(run()).rejects.toBe(outage);
      expect(store.recordTurnAttempt).not.toHaveBeenCalled();
    });

    it("records nothing over another run's move", async () => {
      const { run } = setup({
        provider: UNPARSEABLE,
        store: {
          recordTurnAttempt: vi.fn().mockResolvedValue({ kind: "stale", status: "applied" }),
        },
      });

      expect(await run()).toEqual({ kind: "taken", status: "applied" });
    });
  });
});
