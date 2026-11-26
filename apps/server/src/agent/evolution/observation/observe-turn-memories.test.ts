import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../../db/index.js";
import { ProviderProtocolError } from "../../../llm/errors.js";
import { RefusalError } from "../../../llm/fallback.js";
import type { LlmProvider } from "../../../llm/provider.js";
import type { MemoryProvider } from "../../../memory/provider.js";
import { assertStatus, expectDefined } from "../../../test/assertions.js";
import { mockAgentStore, mockProvider } from "../../../test/factories.js";
import type {
  AgentStore,
  MemoryRule,
  OpenTurn,
  TurnMessage,
  TurnObservation,
} from "../../store/index.js";
import type { ObserverFire } from "../drain-pending-memories.js";
import { ExtractionUnavailableError } from "./failure.js";
import { observeTurnMemories } from "./observe-turn-memories.js";
import type { TurnExtraction } from "./turn-extraction.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const CURSOR = "cursor-1";

const TURN: OpenTurn = {
  observationId: "obs-1",
  cursor: CURSOR,
  status: "pending",
  firstMessageId: "msg-1",
  attempts: 0,
};

/** A first-party fire. */
const FIRE: ObserverFire = {
  conversationId: "conv-1",
  userId: "user-1",
  profileId: "profile-1",
  seesUserRules: true,
};

const USER_RULE: MemoryRule = {
  rule: "Don't save anything about my health.",
  profileId: null,
  fromUser: true,
};

/** An operator's rule: it binds no profile. */
const OPERATOR_RULE: MemoryRule = { rule: "Keep facts short.", profileId: null, fromUser: false };

const SAID = "My homelab IP is 10.0.10.10, and where is the NAS?";

/** The turn: the user's question, a tool round, and the reply. */
function turnRows(earlier: ReadonlyArray<TurnMessage>): TurnMessage[] {
  return [
    ...earlier,
    { id: "msg-1", role: "user", content: SAID, cursor: CURSOR },
    {
      id: "msg-2",
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "dns_lookup", input: { q: "nas" } }],
      cursor: CURSOR,
    },
    {
      id: "msg-3",
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t1", content: "nas.lan is 10.0.10.20" }],
      cursor: CURSOR,
    },
    { id: "msg-4", role: "assistant", content: "The NAS is at 10.0.10.20.", cursor: CURSOR },
  ];
}

const EARLIER: TurnMessage[] = [
  { id: "msg-a", role: "user", content: "I'm off to Lisbon next week.", cursor: "cursor-0" },
  { id: "msg-b", role: "assistant", content: "Enjoy the trip.", cursor: "cursor-0" },
];

const HOMELAB = {
  fact: "homelab IP is 10.0.10.10",
  network: "world",
  compartment: "technical",
  trust: "first-party",
  context: "while setting up DNS",
  evidence: "My homelab IP is 10.0.10.10",
};

/** Quotes the turn's tool result, not the user. */
const NAS = {
  fact: "the NAS is nas.lan at 10.0.10.20",
  network: "world",
  compartment: "technical",
  trust: "first-party",
  evidence: "nas.lan is 10.0.10.20",
};

/** Quotes the turn before, which the step reads as context only. */
const TRIP = {
  fact: "travels to Lisbon next week",
  network: "bank",
  compartment: "personal",
  trust: "first-party",
  evidence: "off to Lisbon next week",
};

function answering(memories: ReadonlyArray<Record<string, unknown>>): LlmProvider {
  return mockProvider({
    chat: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ memories }) }],
      stopReason: "end_turn",
      model: "mock",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  });
}

function throwing(err: unknown): LlmProvider {
  return mockProvider({ chat: vi.fn().mockRejectedValue(err) });
}

/** One row, moved as the store's guarded transitions move it. */
function rowStore(initial: TurnObservation) {
  let row = initial;
  return {
    getTurnObservation: vi.fn<AgentStore["getTurnObservation"]>(async () => row),
    transitionPendingTurn: vi.fn<AgentStore["transitionPendingTurn"]>(async (_tx, { to }) => {
      const current = row;
      if (current.status !== "pending") return { kind: "stale", status: current.status };
      row =
        to.status === "extracted"
          ? { status: "extracted", attempts: current.attempts, extraction: to.extraction }
          : { status: to.status, attempts: current.attempts };
      return { kind: "transitioned" };
    }),
    transitionExtractedTurn: vi.fn<AgentStore["transitionExtractedTurn"]>(async (_tx, { to }) => {
      const current = row;
      if (current.status !== "extracted") return { kind: "stale", status: current.status };
      row =
        to === "held_extracted"
          ? { ...current, status: "held_extracted" }
          : { status: "applied", attempts: current.attempts };
      return { kind: "transitioned" };
    }),
  };
}

function setup(opts: {
  provider: LlmProvider;
  row?: TurnObservation;
  fire?: ObserverFire;
  rules?: ReadonlyArray<MemoryRule>;
  store?: Partial<AgentStore>;
}) {
  const store = mockAgentStore({
    ...rowStore(opts.row ?? { status: "pending", attempts: 0 }),
    getMemoryRules: vi.fn().mockResolvedValue(opts.rules ?? []),
    listTurnMessages: vi.fn().mockResolvedValue(turnRows([])),
    ...opts.store,
  });
  const memory = mock<Pick<MemoryProvider, "retainBatch">>();
  const deps = {
    provider: opts.provider,
    model: "m",
    customCompartments: [],
    runInTx: fakeRunInTx,
    store,
    memory,
  };
  const run = () =>
    observeTurnMemories(deps, {
      turn: TURN,
      fire: opts.fire ?? FIRE,
      runId: "run-1",
      profileClass: "assistant",
    });
  return { store, memory, provider: opts.provider, run };
}

/** What the model was sent as the user message. */
function sentTurn(provider: LlmProvider): unknown {
  const [params] = expectDefined(vi.mocked(provider.chat).mock.calls[0], "the extraction call");
  return params.messages[0]?.content;
}

/** The extraction the step stored with `pending → extracted`. */
function storedExtraction(store: AgentStore): TurnExtraction {
  const [, { to }] = expectDefined(
    vi.mocked(store.transitionPendingTurn).mock.calls[0],
    "the stored extraction",
  );
  assertStatus(to, "extracted");
  return to.extraction;
}

describe("observeTurnMemories", () => {
  const EXTRACTION: TurnExtraction = {
    phase: "memories",
    runId: "run-0",
    profileId: "profile-earlier",
    profileClass: "researcher",
    seesUserRules: true,
    items: [{ ...NAS, network: "world", compartment: "technical", trust: "first-party" }],
    dropped: { noEvidence: 0 },
  };

  it.each<TurnObservation>([
    { status: "held", attempts: 0 },
    { status: "held_extracted", attempts: 0, extraction: EXTRACTION },
    { status: "applied", attempts: 0 },
    { status: "failed", attempts: 3 },
    { status: "skipped", attempts: 0 },
  ])("calls no model and retains nothing for a row that is $status", async (row) => {
    const { store, memory, provider, run } = setup({ provider: answering([HOMELAB]), row });

    expect(await run()).toEqual({ kind: "done", status: row.status });
    expect(provider.chat).not.toHaveBeenCalled();
    expect(store.getMemoryRules).not.toHaveBeenCalled();
    expect(memory.retainBatch).not.toHaveBeenCalled();
    expect(store.transitionPendingTurn).not.toHaveBeenCalled();
    expect(store.transitionExtractedTurn).not.toHaveBeenCalled();
  });

  it("holds a pending turn before any model call when a user's rule binds the fire's profile", async () => {
    const { store, memory, provider, run } = setup({
      provider: answering([HOMELAB]),
      fire: { ...FIRE, seesUserRules: false },
      rules: [USER_RULE],
    });

    expect(await run()).toEqual({ kind: "held" });
    expect(store.getMemoryRules).toHaveBeenCalledWith(FAKE_TX, {
      profileIds: ["profile-1"],
      userId: "user-1",
    });
    expect(store.transitionPendingTurn).toHaveBeenCalledWith(FAKE_TX, {
      id: "obs-1",
      to: { status: "held" },
    });
    expect(provider.chat).not.toHaveBeenCalled();
    expect(memory.retainBatch).not.toHaveBeenCalled();
  });

  it("extracts under the user's rules when the fire's profile sees them", async () => {
    const { provider, run } = setup({ provider: answering([HOMELAB]), rules: [USER_RULE] });

    expect(await run()).toMatchObject({ kind: "applied" });
    const [params] = expectDefined(vi.mocked(provider.chat).mock.calls[0], "the extraction call");
    expect(params.system).toContain(USER_RULE.rule);
  });

  it("skips a turn that renders no text, without a model call", async () => {
    const { store, provider, run } = setup({
      provider: answering([HOMELAB]),
      store: {
        listTurnMessages: vi.fn().mockResolvedValue([
          {
            id: "msg-1",
            role: "user",
            content: [{ type: "text", text: "Image 1:", harness: "image_label" }],
            cursor: CURSOR,
          },
          { id: "msg-2", role: "assistant", content: [], cursor: CURSOR },
        ]),
      },
    });

    expect(await run()).toEqual({ kind: "skipped", reason: "empty" });
    expect(store.transitionPendingTurn).toHaveBeenCalledWith(FAKE_TX, {
      id: "obs-1",
      to: { status: "skipped", reason: "empty" },
    });
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("stores the evidenced facts with the run and the profile they were extracted under, then retains them", async () => {
    const { store, memory, run } = setup({
      provider: answering([
        HOMELAB,
        { ...HOMELAB, fact: "lives in Lisbon", evidence: "I live in Lisbon" },
      ]),
      fire: { ...FIRE, seesUserRules: false },
      rules: [OPERATOR_RULE],
    });

    const outcome = await run();

    expect(storedExtraction(store)).toStrictEqual({
      phase: "memories",
      runId: "run-1",
      profileId: "profile-1",
      profileClass: "assistant",
      seesUserRules: false,
      items: [HOMELAB],
      dropped: { noEvidence: 1 },
    });
    expect(outcome).toEqual({ kind: "applied", byNetwork: { world: 1 }, droppedNoEvidence: 1 });
    const [userId, items] = expectDefined(memory.retainBatch.mock.calls[0], "the retain");
    expect(userId).toBe("user-1");
    expect(items.map((i) => [i.documentId, i.content])).toEqual([
      ["observer:turn:cursor-1:0", HOMELAB.fact],
    ]);
    expect(items[0]?.tags).toContain("profile_class:assistant");
    const stored = vi.mocked(store.transitionPendingTurn).mock.invocationCallOrder[0];
    const retained = memory.retainBatch.mock.invocationCallOrder[0];
    expect(expectDefined(stored, "store")).toBeLessThan(expectDefined(retained, "retain"));
  });

  it("keeps a fact whose evidence quotes the turn's tool result", async () => {
    const { store, run } = setup({ provider: answering([NAS]) });

    expect(await run()).toMatchObject({ kind: "applied", droppedNoEvidence: 0 });
    expect(storedExtraction(store).items).toEqual([NAS]);
  });

  it("sends the turn alone when no turn was answered before it", async () => {
    const { store, provider, run } = setup({ provider: answering([]) });

    await run();

    expect(store.findAnsweredCursorBefore).toHaveBeenCalledWith(FAKE_TX, "conv-1", "msg-1");
    expect(store.listTurnMessages).toHaveBeenCalledWith(FAKE_TX, "conv-1", [CURSOR]);
    expect(sentTurn(provider)).toBe(
      `<turn>\nUser: ${SAID}\n\nAssistant: [Tool: dns_lookup({"q":"nas"})]\n\nUser: → nas.lan is 10.0.10.20\n\nAssistant: The NAS is at 10.0.10.20.\n</turn>`,
    );
  });

  it("gives the model the turn answered before as context, and keeps no fact only it holds", async () => {
    const { store, provider, run } = setup({
      provider: answering([HOMELAB, TRIP]),
      store: {
        findAnsweredCursorBefore: vi.fn().mockResolvedValue("cursor-0"),
        listTurnMessages: vi.fn().mockResolvedValue(turnRows(EARLIER)),
      },
    });

    expect(await run()).toMatchObject({ kind: "applied", droppedNoEvidence: 1 });
    expect(store.listTurnMessages).toHaveBeenCalledWith(FAKE_TX, "conv-1", [CURSOR, "cursor-0"]);
    expect(sentTurn(provider)).toEqual(
      expect.stringMatching(
        /^<earlier_conversation>\nUser: I'm off to Lisbon next week\.\n\nAssistant: Enjoy the trip\.\n<\/earlier_conversation>\n\n<turn>\nUser: My homelab/,
      ),
    );
    expect(storedExtraction(store).items).toEqual([HOMELAB]);
  });

  it.each([
    {
      err: new RefusalError("refused"),
      outcome: { kind: "failed", attempts: 2, failure: "refusal" },
      giveUp: true,
    },
    {
      err: new ProviderProtocolError("no structured output", undefined),
      outcome: { kind: "retryLater", attempts: 2, failure: "parse" },
      giveUp: false,
    },
  ])(
    "counts a $err.name the turn caused from `pending`, on the count it read",
    async ({ err, outcome, giveUp }) => {
      const { store, memory, run } = setup({
        provider: throwing(err),
        row: { status: "pending", attempts: 1 },
      });

      expect(await run()).toEqual(outcome);
      expect(store.recordTurnAttempt).toHaveBeenCalledWith(FAKE_TX, {
        id: "obs-1",
        from: "pending",
        seen: 1,
        failure: { kind: outcome.failure, message: err.message },
        giveUp,
      });
      expect(store.transitionPendingTurn).not.toHaveBeenCalled();
      expect(memory.retainBatch).not.toHaveBeenCalled();
    },
  );

  it("rethrows a failure the turn didn't cause as unavailable, and records nothing", async () => {
    const outage = Object.assign(new Error("overloaded"), { status: 529 });
    const { store, run } = setup({ provider: throwing(outage) });

    const thrown = await run().catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(ExtractionUnavailableError);
    expect(thrown).toMatchObject({ cause: outage });
    expect(store.recordTurnAttempt).not.toHaveBeenCalled();
    expect(store.transitionPendingTurn).not.toHaveBeenCalled();
  });

  it("retains nothing when another run stored the turn's extraction first", async () => {
    const { store, memory, run } = setup({
      provider: answering([HOMELAB]),
      store: {
        transitionPendingTurn: vi.fn().mockResolvedValue({ kind: "stale", status: "extracted" }),
      },
    });

    expect(await run()).toEqual({ kind: "taken", status: "extracted" });
    expect(memory.retainBatch).not.toHaveBeenCalled();
    expect(store.transitionExtractedTurn).not.toHaveBeenCalled();
  });

  it("retains an `extracted` row's stored facts without reading the turn or calling the model", async () => {
    const { store, memory, provider, run } = setup({
      provider: answering([HOMELAB]),
      row: { status: "extracted", attempts: 1, extraction: EXTRACTION },
    });

    expect(await run()).toEqual({ kind: "applied", byNetwork: { world: 1 }, droppedNoEvidence: 0 });
    expect(provider.chat).not.toHaveBeenCalled();
    expect(store.listTurnMessages).not.toHaveBeenCalled();
    expect(store.transitionPendingTurn).not.toHaveBeenCalled();
    const [, items] = expectDefined(memory.retainBatch.mock.calls[0], "the retain");
    expect(items.map((i) => i.content)).toEqual([NAS.fact]);
    expect(items[0]?.tags).toContain("profile_class:researcher");
    expect(store.transitionExtractedTurn).toHaveBeenCalledWith(FAKE_TX, {
      id: "obs-1",
      to: "applied",
    });
  });
});
