import * as R from "remeda";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import type { StepRun } from "../../inngest/index.js";
import { agentIterations } from "../../metrics.js";
import { FAKE_TX, nullStepSendEvent } from "../../test/factories.js";
import type { AgentLoopResult } from "../loop.js";
import type { AgentStore } from "../store/index.js";
import type { CooldownState } from "../store/schema.js";
import { type PersistTurnArgs, persistTurn } from "./persist-turn.js";

const ELAPSED_COOLDOWN: CooldownState = {
  lastErroredAt: "2026-10-01T08:00:00.000Z",
  cooldownSeconds: 60,
  consecutiveFailures: 1,
};

const RESULT: AgentLoopResult = {
  text: "reply",
  messages: [],
  newMessages: [{ role: "assistant", content: [{ type: "text", text: "reply" }] }],
  usage: { inputTokens: 10, outputTokens: 5 },
  model: "model-a",
  iterations: 2,
  streamed: { text: "reply", toolUseIds: [] },
  degraded: { reason: "model returned an empty turn", subtype: "empty_end_turn" },
};

const ARGS: PersistTurnArgs = {
  conversationId: "conv",
  runId: "run-1",
  triggerInboundId: "in-2",
  snapshot: { profileId: "profile", model: "model-a" },
  maxInboundId: "in-2",
  lastAnsweredMessageId: "asst-prev",
  // An elapsed cooldown and a degraded result, so both emits are planned
  // whenever the turn persists.
  priorCooldown: ELAPSED_COOLDOWN,
  result: RESULT,
};

interface Setup {
  /** Step results from an earlier invocation, by step id. */
  memo?: Readonly<Record<string, unknown>>;
  /** The newest assistant row already on the turn's cursor. */
  existingReply?: { id: string; sameContent: boolean };
  rebatched?: boolean;
}

function setup(opts: Setup) {
  const agentStore = mock<AgentStore>();
  agentStore.findLastAssistantMessageByInbound.mockResolvedValue(opts.existingReply);
  agentStore.isCursorRebatched.mockResolvedValue(opts.rebatched ?? false);
  agentStore.insertMessages.mockResolvedValue({ id: "asst-new" });
  const transactions: string[] = [];
  const runInTx: Transactor = (cb) => {
    transactions.push("tx");
    return cb(FAKE_TX);
  };
  const memo = opts.memo ?? {};
  const planned: string[] = [];
  // Runs a step body inline unless the memo holds its result.
  const run = (async (id: string, body: () => Promise<unknown>) => {
    planned.push(id);
    return id in memo ? memo[id] : body();
  }) as unknown as StepRun;
  const sendEvent = vi.fn(nullStepSendEvent());
  return {
    step: { run, sendEvent },
    deps: { runInTx, agentStore },
    agentStore,
    transactions,
    planned,
    emitted: () => sendEvent.mock.calls.map(([id]) => id),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const BOTH_EMITS = ["emit-cooldown-cleared", "emit-conversation-degraded"];

describe("persistTurn", () => {
  it("persists a turn no later turn re-batched, and emits what it settles", async () => {
    const record = vi.spyOn(agentIterations, "record");
    const { step, deps, agentStore, transactions, emitted } = setup({});

    const outcome = await persistTurn(step, deps, ARGS);

    expect(outcome).toEqual({ kind: "persisted", messageId: "asst-new" });
    // Both reads are bounded to rows newer than the reply admission found.
    expect(agentStore.findLastAssistantMessageByInbound).toHaveBeenCalledWith(FAKE_TX, {
      conversationId: "conv",
      inboundId: "in-2",
      afterMessageId: "asst-prev",
      content: [{ type: "text", text: "reply" }],
    });
    expect(agentStore.isCursorRebatched).toHaveBeenCalledWith(FAKE_TX, {
      conversationId: "conv",
      cursor: "in-2",
      afterMessageId: "asst-prev",
    });
    expect(agentStore.insertMessages).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ conversationId: "conv", lastInboundMessageId: "in-2" }),
    );
    expect(agentStore.clearCooldown).toHaveBeenCalledWith(FAKE_TX, "conv");
    // The checks and the write share one transaction.
    expect(transactions).toHaveLength(1);
    expect(emitted()).toEqual(BOTH_EMITS);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when a later turn re-batched the cursor, and reports only the degradation", async () => {
    const record = vi.spyOn(agentIterations, "record");
    const { step, deps, agentStore, emitted } = setup({ rebatched: true });

    const outcome = await persistTurn(step, deps, ARGS);

    expect(outcome).toEqual({ kind: "superseded" });
    expect(agentStore.insertMessages).not.toHaveBeenCalled();
    expect(agentStore.clearCooldown).not.toHaveBeenCalled();
    // The degraded apology already streamed; the cooldown was not cleared.
    expect(emitted()).toEqual(["emit-conversation-degraded"]);
    // The loop ran in this attempt.
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("emits nothing for a superseded turn that didn't degrade", async () => {
    const { step, deps, emitted } = setup({ rebatched: true });
    const undegraded = R.omit(RESULT, ["degraded"]);

    expect(await persistTurn(step, deps, { ...ARGS, result: undegraded })).toEqual({
      kind: "superseded",
    });
    expect(emitted()).toEqual([]);
  });

  it("is superseded when another run of the same batch already persisted a different reply", async () => {
    const record = vi.spyOn(agentIterations, "record");
    const { step, deps, agentStore, emitted } = setup({
      existingReply: { id: "asst-other", sameContent: false },
    });

    const outcome = await persistTurn(step, deps, ARGS);

    expect(outcome).toEqual({ kind: "superseded" });
    expect(agentStore.isCursorRebatched).not.toHaveBeenCalled();
    expect(agentStore.insertMessages).not.toHaveBeenCalled();
    expect(agentStore.clearCooldown).not.toHaveBeenCalled();
    expect(emitted()).toEqual(["emit-conversation-degraded"]);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("returns its own committed reply on a re-run after commit, even with a covering turn since", async () => {
    // The first attempt committed, then a younger turn's row landed before
    // the step's retry. The reply check runs first and finds this run's own
    // reply, so the re-run settles the turn it already persisted.
    const record = vi.spyOn(agentIterations, "record");
    const { step, deps, agentStore, emitted } = setup({
      existingReply: { id: "asst-final", sameContent: true },
      rebatched: true,
    });

    const outcome = await persistTurn(step, deps, ARGS);

    expect(outcome).toEqual({ kind: "persisted", messageId: "asst-final" });
    expect(agentStore.isCursorRebatched).not.toHaveBeenCalled();
    expect(agentStore.insertMessages).not.toHaveBeenCalled();
    expect(agentStore.clearCooldown).not.toHaveBeenCalled();
    expect(emitted()).toEqual(BOTH_EMITS);
    // The attempt that wrote the rows recorded the sample.
    expect(record).not.toHaveBeenCalled();
  });

  it("reads an { id } memo as persisted", async () => {
    const { step, deps, agentStore, emitted } = setup({
      memo: { "persist-new-messages": { id: "asst-legacy" } },
    });

    const outcome = await persistTurn(step, deps, ARGS);

    expect(outcome).toEqual({ kind: "persisted", messageId: "asst-legacy" });
    expect(agentStore.findLastAssistantMessageByInbound).not.toHaveBeenCalled();
    expect(agentStore.insertMessages).not.toHaveBeenCalled();
    expect(emitted()).toEqual(BOTH_EMITS);
  });

  it("replays a superseded memo without recording or clearing", async () => {
    const record = vi.spyOn(agentIterations, "record");
    const { step, deps, agentStore, emitted } = setup({
      memo: { "persist-new-messages": { kind: "superseded" } },
    });

    const outcome = await persistTurn(step, deps, ARGS);

    expect(outcome).toEqual({ kind: "superseded" });
    expect(agentStore.insertMessages).not.toHaveBeenCalled();
    expect(emitted()).toEqual(["emit-conversation-degraded"]);
    expect(record).not.toHaveBeenCalled();
  });

  it("rejects a memo of neither shape", async () => {
    const { step, deps } = setup({ memo: { "persist-new-messages": { kind: "lost" } } });

    await expect(persistTurn(step, deps, ARGS)).rejects.toThrow();
  });
});
