import { StepError, serializeError } from "inngest";
import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../../db/index.js";
import { mockAgentStore } from "../../../test/factories.js";
import type { OpenTurn } from "../../store/index.js";
import type { ObservationPhaseValue } from "../../store/schema.js";
import { ExtractionUnavailableError, RetainUnavailableError } from "./failure.js";
import type { MemoryTurnOutcome } from "./turn-outcome.js";
import { type ObserverStepHarness, type WalkablePlan, walkTurns } from "./walk-turns.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

function turn(id: string, fields: Partial<OpenTurn> = {}): OpenTurn {
  return {
    observationId: id,
    cursor: `cursor-${id}`,
    status: "pending",
    firstMessageId: `msg-${id}`,
    attempts: 0,
    ...fields,
  };
}

const APPLIED: MemoryTurnOutcome = {
  kind: "applied",
  byNetwork: { world: 1 },
  droppedNoEvidence: 0,
};

/**
 * Inngest's step tools after a step's retries are spent: the listed steps
 * fail with their error, serialized and rebuilt as a `StepError` as the SDK
 * hands it back, and every other step runs its body. Records the step ids.
 */
function harness(failing: ReadonlyMap<string, Error>) {
  const ids: string[] = [];
  const step: ObserverStepHarness = {
    async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
      ids.push(id);
      const err = failing.get(id);
      if (err !== undefined) throw new StepError(id, serializeError(err));
      return fn();
    },
  };
  return { step, ids };
}

function setup(opts: {
  plan: WalkablePlan;
  outcomes?: ReadonlyArray<MemoryTurnOutcome>;
  phase?: ObservationPhaseValue;
  step?: ObserverStepHarness;
  discover?: () => Promise<WalkablePlan>;
}) {
  const store = mockAgentStore();
  const queued = [...(opts.outcomes ?? [])];
  const observe = vi.fn(async (_turn: OpenTurn) => queued.shift() ?? APPLIED);
  const discover = vi.fn(opts.discover ?? (async () => opts.plan));
  const walk = () =>
    walkTurns(opts.step ?? harness(new Map()).step, {
      conversationId: "conv-1",
      phase: opts.phase ?? "memories",
      discoverStepId: "discover-memory-turns",
      discover,
      observe,
      deps: { runInTx: fakeRunInTx, store },
    });
  return { store, observe, discover, walk };
}

describe("walkTurns", () => {
  it.each<ObservationPhaseValue>(["corrections", "memories"])(
    "plans discovery, then one %s step per planned turn, oldest first",
    async (phase) => {
      const { step, ids } = harness(new Map());
      const plan = { turns: [turn("obs-1"), turn("obs-2")], remaining: 0 };
      const { observe, walk } = setup({ plan, phase, step });

      const walked = await walk();

      expect(ids).toEqual([
        "discover-memory-turns",
        `observe-v1-${phase}-obs-1`,
        `observe-v1-${phase}-obs-2`,
      ]);
      expect(observe.mock.calls.map(([t]) => t.observationId)).toEqual(["obs-1", "obs-2"]);
      expect(walked).toEqual({ plan, outcomes: [APPLIED, APPLIED], failed: false, remaining: 0 });
    },
  );

  it.each<MemoryTurnOutcome>([
    { kind: "held" },
    APPLIED,
    { kind: "skipped", reason: "empty" },
    { kind: "done", status: "applied" },
  ])("goes on to the next turn after $kind", async (first) => {
    const { observe, walk } = setup({
      plan: { turns: [turn("obs-1"), turn("obs-2")], remaining: 0 },
      outcomes: [first, APPLIED],
    });

    const walked = await walk();

    expect(observe).toHaveBeenCalledTimes(2);
    expect(walked.outcomes).toEqual([first, APPLIED]);
    expect(walked.failed).toBe(false);
  });

  it.each<MemoryTurnOutcome>([
    { kind: "taken", status: "extracted" },
    { kind: "retryLater", attempts: 1, failure: "parse" },
    { kind: "failed", attempts: 1, failure: "refusal" },
  ])("stops the phase at $kind", async (first) => {
    const { observe, walk } = setup({
      plan: { turns: [turn("obs-1"), turn("obs-2")], remaining: 0 },
      outcomes: [first],
    });

    const walked = await walk();

    expect(observe).toHaveBeenCalledOnce();
    expect(walked.outcomes).toEqual([first]);
    expect(walked.failed).toBe(false);
  });

  it.each([
    new ExtractionUnavailableError(new Error("overloaded")),
    new RetainUnavailableError(new Error("hindsight unreachable")),
  ])("counts nothing against a turn whose step failed for good with $name", async (err) => {
    const { step, ids } = harness(new Map([["observe-v1-memories-obs-1", err]]));
    const { store, observe, walk } = setup({
      plan: { turns: [turn("obs-1"), turn("obs-2")], remaining: 0 },
      step,
    });

    const walked = await walk();

    expect(ids).toEqual(["discover-memory-turns", "observe-v1-memories-obs-1"]);
    expect(store.recordTurnAttempt).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(walked).toMatchObject({ outcomes: [], failed: true, remaining: 2 });
  });

  it("counts any other failure against the turn, on the status and count the plan read", async () => {
    const { step, ids } = harness(
      new Map([["observe-v1-memories-obs-1", new Error("connection reset")]]),
    );
    const { store, walk } = setup({
      plan: {
        turns: [turn("obs-1", { status: "extracted", attempts: 2 }), turn("obs-2")],
        remaining: 0,
      },
      step,
    });

    const walked = await walk();

    expect(ids).toEqual([
      "discover-memory-turns",
      "observe-v1-memories-obs-1",
      "observe-v1-memories-exhausted-obs-1",
    ]);
    expect(store.recordTurnAttempt).toHaveBeenCalledWith(FAKE_TX, {
      id: "obs-1",
      from: "extracted",
      seen: 2,
      failure: { kind: "exhausted", message: "connection reset" },
      giveUp: true,
    });
    expect(walked).toMatchObject({
      outcomes: [{ kind: "failed", attempts: 3, failure: "exhausted" }],
      failed: true,
    });
  });

  it("counts a failure from `pending` for a plan turn memoized without a status", async () => {
    const { step } = harness(
      new Map([["observe-v1-corrections-obs-1", new Error("connection reset")]]),
    );
    // A plan memoized by a build whose plans carry no status.
    const legacy = turn("obs-1", { status: "extracted" });
    Reflect.deleteProperty(legacy, "status");
    const { store, walk } = setup({
      plan: { turns: [legacy], remaining: 0 },
      phase: "corrections",
      step,
    });

    const walked = await walk();

    expect(store.recordTurnAttempt).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ id: "obs-1", from: "pending", seen: 0 }),
    );
    expect(walked.outcomes).toEqual([{ kind: "retryLater", attempts: 1, failure: "exhausted" }]);
  });

  it("stops the phase as failed when recording the attempt fails for good too", async () => {
    const { step, ids } = harness(
      new Map([
        ["observe-v1-memories-obs-1", new Error("connection reset")],
        ["observe-v1-memories-exhausted-obs-1", new Error("connection reset")],
      ]),
    );
    const { observe, walk } = setup({
      plan: { turns: [turn("obs-1"), turn("obs-2")], remaining: 0 },
      step,
    });

    const walked = await walk();

    expect(ids).toHaveLength(3);
    expect(observe).not.toHaveBeenCalled();
    expect(walked).toMatchObject({ outcomes: [], failed: true, remaining: 2 });
  });

  it("observes nothing when discovery fails for good", async () => {
    const { step } = harness(new Map([["discover-memory-turns", new Error("connection reset")]]));
    const { observe, walk } = setup({ plan: { turns: [turn("obs-1")], remaining: 0 }, step });

    expect(await walk()).toEqual({ plan: null, outcomes: [], failed: true, remaining: 0 });
    expect(observe).not.toHaveBeenCalled();
  });

  it("propagates a throw that isn't a step's failure, from discovery or a turn", async () => {
    const bug = new Error("not a step failure");
    const plan = { turns: [turn("obs-1")], remaining: 0 };

    await expect(
      setup({
        plan,
        discover: async () => {
          throw bug;
        },
      }).walk(),
    ).rejects.toBe(bug);

    const { store, observe, walk } = setup({ plan });
    observe.mockRejectedValueOnce(bug);
    await expect(walk()).rejects.toBe(bug);
    expect(store.recordTurnAttempt).not.toHaveBeenCalled();
  });

  it("propagates a throw from the attempt step that isn't a step's failure", async () => {
    const bug = new Error("not a step failure");
    const step: ObserverStepHarness = {
      async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
        if (id === "observe-v1-memories-obs-1") {
          throw new StepError(id, serializeError(new Error("connection reset")));
        }
        if (id === "observe-v1-memories-exhausted-obs-1") throw bug;
        return fn();
      },
    };

    await expect(
      setup({ plan: { turns: [turn("obs-1")], remaining: 0 }, step }).walk(),
    ).rejects.toBe(bug);
  });

  describe("remaining", () => {
    it.each<{ name: string; outcomes: ReadonlyArray<MemoryTurnOutcome>; remaining: number }>([
      {
        name: "subtracts every turn that left the plan",
        outcomes: [APPLIED, { kind: "held" }, { kind: "skipped", reason: "empty" }],
        remaining: 5,
      },
      {
        name: "subtracts a done and a failed turn",
        outcomes: [
          { kind: "done", status: "applied" },
          { kind: "failed", attempts: 3, failure: "parse" },
        ],
        remaining: 6,
      },
      {
        name: "keeps a turn to retry and the turns after it",
        outcomes: [APPLIED, { kind: "retryLater", attempts: 1, failure: "parse" }],
        remaining: 7,
      },
      {
        name: "keeps a turn another run took and the turns after it",
        outcomes: [{ kind: "taken", status: "extracted" }],
        remaining: 8,
      },
    ])("$name", async ({ outcomes, remaining }) => {
      const { walk } = setup({
        plan: { turns: [turn("obs-1"), turn("obs-2"), turn("obs-3")], remaining: 5 },
        outcomes,
      });

      expect((await walk()).remaining).toBe(remaining);
    });

    it("subtracts a turn the exhausted step failed, and keeps one it counted to retry", async () => {
      const failing = new Map([["observe-v1-memories-obs-1", new Error("connection reset")]]);
      const plan = (attempts: number) => ({
        turns: [turn("obs-1", { attempts }), turn("obs-2")],
        remaining: 1,
      });

      const failed = await setup({ plan: plan(2), step: harness(failing).step }).walk();
      const retried = await setup({ plan: plan(0), step: harness(failing).step }).walk();

      expect(failed.remaining).toBe(2);
      expect(retried.remaining).toBe(3);
    });
  });
});
