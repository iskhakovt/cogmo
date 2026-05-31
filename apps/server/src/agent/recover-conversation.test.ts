import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { conversationErrored } from "../inngest/events.js";
import { logger } from "../logger.js";
import {
  fakeRunInTx,
  invokeInngestFn,
  type MockStep,
  mockAgentStore,
  mockStep,
} from "../test/factories.js";
import { createRecoverConversation } from "./recover-conversation.js";
import type { CooldownState } from "./store/schema.js";

type ConversationErroredData = z.infer<typeof conversationErrored.schema>;

interface RecoverConversationCtx {
  event: { data: ConversationErroredData };
  step: MockStep;
}

const baseEvent = {
  data: {
    conversationId: "conv-1",
    runId: "run-failed-1",
    triggerInboundId: "inbound-1",
    errorClass: "NonRetriableError",
    causeClass: "BadRequestError",
    errorMessage: "tool_use ids were found without tool_result blocks",
  },
};

// Filter step.sendEvent mock calls down to the entries whose payload
// matches `eventName`, returning ALL matches (not just the first).
// Tighter than `.find(...)` — a future regression that double-fires
// the event surfaces as `toHaveLength(2)` instead of silently passing
// the same `.find` assertion. Negative tests assert `toHaveLength(0)`.
function callsForEvent(calls: unknown[][], eventName: string): unknown[][] {
  return calls.filter((c) => {
    const payload = c[1];
    return (
      typeof payload === "object" &&
      payload !== null &&
      "name" in payload &&
      payload.name === eventName
    );
  });
}

const baseConv = {
  id: "conv-1",
  userId: "user-1",
  profileId: "profile-1",
  isPrivate: true,
  cooldownState: null as CooldownState | null,
  voiceMode: null,
};

describe("createRecoverConversation", () => {
  it("skips when conversation does not exist", async () => {
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue(undefined),
    });
    const fn = createRecoverConversation({ runInTx: fakeRunInTx, agentStore });
    const result = await invokeInngestFn<RecoverConversationCtx>(fn, {
      event: baseEvent,
      step: mockStep(),
    });
    expect(result).toEqual({ status: "skipped", reason: "conversation_not_found" });
    expect(agentStore.writeCooldownState).not.toHaveBeenCalled();
  });

  it("arms a fresh cooldown at 60s on first failure", async () => {
    const agentStore = mockAgentStore();
    const fn = createRecoverConversation({ runInTx: fakeRunInTx, agentStore });
    const result = await invokeInngestFn<RecoverConversationCtx>(fn, {
      event: baseEvent,
      step: mockStep(),
    });
    expect(result).toMatchObject({
      status: "cooldown_armed",
      cooldownSeconds: 60,
      consecutiveFailures: 1,
    });
    expect(agentStore.writeCooldownState).toHaveBeenCalledWith(
      expect.anything(),
      "conv-1",
      expect.objectContaining({ cooldownSeconds: 60, consecutiveFailures: 1 }),
    );
  });

  it("doubles cooldown on a follow-up failure with prior state", async () => {
    const prior: CooldownState = {
      lastErroredAt: "2026-05-19T11:00:00.000Z",
      cooldownSeconds: 60,
      consecutiveFailures: 1,
    };
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue({ ...baseConv, cooldownState: prior }),
    });
    const fn = createRecoverConversation({ runInTx: fakeRunInTx, agentStore });
    const result = await invokeInngestFn<RecoverConversationCtx>(fn, {
      event: baseEvent,
      step: mockStep(),
    });
    expect(result).toMatchObject({
      status: "cooldown_armed",
      cooldownSeconds: 120,
      consecutiveFailures: 2,
    });
  });

  it("caps cooldown at 3600s past the curve", async () => {
    const prior: CooldownState = {
      lastErroredAt: "2026-05-19T11:00:00.000Z",
      cooldownSeconds: 1920,
      consecutiveFailures: 6,
    };
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue({ ...baseConv, cooldownState: prior }),
    });
    const fn = createRecoverConversation({ runInTx: fakeRunInTx, agentStore });
    const result = await invokeInngestFn<RecoverConversationCtx>(fn, {
      event: baseEvent,
      step: mockStep(),
    });
    expect(result).toMatchObject({
      status: "cooldown_armed",
      cooldownSeconds: 3600,
      consecutiveFailures: 7,
    });
  });

  // Pin the log-payload contract that the future evolution
  // failure-reflector buckets on. errorClass and causeClass come straight
  // off the `conversation/errored` event; dropping either would break
  // the reflector's class taxonomy.
  it("logs errorClass, causeClass, errorMessage, and cooldown fields", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    const agentStore = mockAgentStore();
    const fn = createRecoverConversation({ runInTx: fakeRunInTx, agentStore });
    await invokeInngestFn<RecoverConversationCtx>(fn, { event: baseEvent, step: mockStep() });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-1",
        errorClass: "NonRetriableError",
        causeClass: "BadRequestError",
        errorMessage: "tool_use ids were found without tool_result blocks",
        cooldownSeconds: 60,
        consecutiveFailures: 1,
      }),
      "recover-conversation: cooldown armed",
    );
    warnSpy.mockRestore();
  });

  // Telemetry — `conversation/cooldown/entered` fires after the
  // durable cooldown write. Payload carries the derived `causeClass`
  // (NonRetriableError → "B" here), the full curve state, and a
  // bus-dedup `id: cooldown-entered-${runId}` so an Inngest retry of
  // this function (or a future second emitter for the same failed
  // run) doesn't double-fire downstream consumers. See
  // design/agent-resilience.md → Telemetry.
  it("emits conversation/cooldown/entered after the cooldown write", async () => {
    const agentStore = mockAgentStore();
    const fn = createRecoverConversation({ runInTx: fakeRunInTx, agentStore });
    const step = mockStep();
    await invokeInngestFn<RecoverConversationCtx>(fn, { event: baseEvent, step });
    const enteredCalls = callsForEvent(step.sendEvent.mock.calls, "conversation/cooldown/entered");
    expect(enteredCalls).toHaveLength(1);
    expect(enteredCalls[0]?.[0]).toBe("emit-cooldown-entered");
    expect(enteredCalls[0]?.[1]).toMatchObject({
      name: "conversation/cooldown/entered",
      id: "cooldown-entered-run-failed-1",
      data: {
        conversationId: "conv-1",
        runId: "run-failed-1",
        cooldownSeconds: 60,
        consecutiveFailures: 1,
        causeClass: "B",
      },
    });
  });

  it("maps WorkerDeath errorClass to causeClass A in the emitted event", async () => {
    const agentStore = mockAgentStore();
    const fn = createRecoverConversation({ runInTx: fakeRunInTx, agentStore });
    const step = mockStep();
    await invokeInngestFn<RecoverConversationCtx>(fn, {
      event: { data: { ...baseEvent.data, errorClass: "WorkerDeath", causeClass: null } },
      step,
    });
    const enteredCalls = callsForEvent(step.sendEvent.mock.calls, "conversation/cooldown/entered");
    expect(enteredCalls).toHaveLength(1);
    expect(enteredCalls[0]?.[1]).toMatchObject({ data: { causeClass: "A" } });
  });

  it("falls back to causeClass 'bug' for unrecognised errorClass values", async () => {
    const agentStore = mockAgentStore();
    const fn = createRecoverConversation({ runInTx: fakeRunInTx, agentStore });
    const step = mockStep();
    await invokeInngestFn<RecoverConversationCtx>(fn, {
      event: { data: { ...baseEvent.data, errorClass: "RandomError" } },
      step,
    });
    const enteredCalls = callsForEvent(step.sendEvent.mock.calls, "conversation/cooldown/entered");
    expect(enteredCalls).toHaveLength(1);
    expect(enteredCalls[0]?.[1]).toMatchObject({ data: { causeClass: "bug" } });
  });

  it("does NOT emit cooldown/entered when conversation_not_found short-circuits", async () => {
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue(undefined),
    });
    const fn = createRecoverConversation({ runInTx: fakeRunInTx, agentStore });
    const step = mockStep();
    await invokeInngestFn<RecoverConversationCtx>(fn, { event: baseEvent, step });
    expect(callsForEvent(step.sendEvent.mock.calls, "conversation/cooldown/entered")).toHaveLength(
      0,
    );
  });

  // Idempotency-under-duplicate-events documentation.
  //
  // The bus-level dedup guard (`buildConversationErroredEvent` bakes in
  // `id: errored-${runId}` so Inngest's event-id dedup window drops
  // duplicates) is what prevents recover-conversation from running
  // twice for one failed run. This test pins what *would* happen if
  // that guard ever broke — invoking the function twice with the same
  // event bumps `consecutiveFailures` to 2 and doubles `cooldownSeconds`
  // from 60s to 120s.
  //
  // The point is NOT to assert correct behaviour for the duplicate case
  // — it's a failure mode, not a contract. The point is to load-bearing
  // the bus-level guard: anyone weakening
  // `buildConversationErroredEvent` (or bypassing it on either emitter)
  // breaks the dedup that this test documents the cost of losing. If
  // this test ever lights up on a *single* event-bus arrival, dedup
  // has regressed — the cooldown-curve change is the visible symptom.
  it("two events with the same runId would double-bump cooldown if bus dedup ever failed", async () => {
    // Track state in a local var so the second call reads what the
    // first wrote — mirrors what a misconfigured bus would deliver.
    let stored: CooldownState | null = null;
    const agentStore = mockAgentStore({
      getConversation: vi.fn(async () => ({ ...baseConv, cooldownState: stored })),
      writeCooldownState: vi.fn(async (_tx, _id, state) => {
        stored = state;
      }),
    });
    const fn = createRecoverConversation({ runInTx: fakeRunInTx, agentStore });

    const first = await invokeInngestFn<RecoverConversationCtx>(fn, {
      event: baseEvent,
      step: mockStep(),
    });
    const second = await invokeInngestFn<RecoverConversationCtx>(fn, {
      event: baseEvent,
      step: mockStep(),
    });

    expect(first).toMatchObject({ cooldownSeconds: 60, consecutiveFailures: 1 });
    expect(second).toMatchObject({ cooldownSeconds: 120, consecutiveFailures: 2 });
    // ↑ This is the bug bus-level dedup prevents. If you ever see
    //   this assertion fail because the second call ALSO got
    //   `{ 60, 1 }`, recover-conversation grew its own idempotency
    //   layer — fine, but the bus-level guard then becomes redundant
    //   and the dedup test in reconcile-on-failure.test.ts can relax.
  });
});
