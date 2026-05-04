import { describe, expect, it, vi } from "vitest";
import { mockAgentStore, mockStep } from "../test/factories.js";
import { createRecoverConversation } from "./recover-conversation.js";

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

describe("createRecoverConversation", () => {
  it("skips when conversation does not exist", async () => {
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue(undefined),
    });
    const fn = createRecoverConversation({ agentStore }) as any;
    const result = await fn.fn({ event: baseEvent, step: mockStep() });
    expect(result).toEqual({ status: "skipped", reason: "conversation_not_found" });
    expect(agentStore.applyHeal).not.toHaveBeenCalled();
    expect(agentStore.setConversationStatus).not.toHaveBeenCalled();
  });

  it("skips when conversation is already errored", async () => {
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue({
        id: "conv-1",
        userId: "user-1",
        profileId: "profile-1",
        isPrivate: true,
        status: "errored",
      }),
    });
    const fn = createRecoverConversation({ agentStore }) as any;
    const result = await fn.fn({ event: baseEvent, step: mockStep() });
    expect(result).toEqual({ status: "skipped", reason: "already_errored" });
    expect(agentStore.applyHeal).not.toHaveBeenCalled();
    expect(agentStore.setConversationStatus).not.toHaveBeenCalled();
  });

  // No-repair case: validator finds nothing wrong → the original failure
  // wasn't a history-contract violation. Retrying would just hit the same
  // upstream error, so we mark the conversation errored to stop spending.
  it("marks conversation errored when validator finds no repairs", async () => {
    const agentStore = mockAgentStore({
      getHistoryWithIds: vi.fn().mockResolvedValue([
        { id: "m1", message: { role: "user", content: "hi" }, lastInboundMessageId: "inb-1" },
        {
          id: "m2",
          message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
          lastInboundMessageId: "inb-1",
        },
      ]),
    });
    const step = mockStep();
    const fn = createRecoverConversation({ agentStore }) as any;
    const result = await fn.fn({ event: baseEvent, step });
    expect(result).toEqual({ status: "marked_errored", reason: "no_repair_possible" });
    expect(agentStore.setConversationStatus).toHaveBeenCalledWith("conv-1", "errored");
    expect(agentStore.applyHeal).not.toHaveBeenCalled();
    expect(step.sendEvent).not.toHaveBeenCalled();
  });

  // Repair case: validator finds an orphan tool_use, recovery applies the
  // heal and re-emits inbound/ready so handle-message gets another shot.
  it("applies heal and re-emits inbound/ready when validator finds repairs", async () => {
    const agentStore = mockAgentStore({
      getHistoryWithIds: vi.fn().mockResolvedValue([
        { id: "m1", message: { role: "user", content: "hi" }, lastInboundMessageId: "inb-1" },
        {
          id: "m2",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "echo", input: {} }],
          },
          lastInboundMessageId: "inb-1",
        },
        {
          id: "m3",
          message: { role: "user", content: "are you there?" },
          lastInboundMessageId: "inb-2",
        },
      ]),
    });
    const step = mockStep();
    const fn = createRecoverConversation({ agentStore }) as any;
    const result = await fn.fn({ event: baseEvent, step });
    expect(result).toEqual({ status: "retried", repairCount: 1 });
    expect(agentStore.setConversationStatus).not.toHaveBeenCalled();
    expect(agentStore.applyHeal).toHaveBeenCalledTimes(1);
    const healCall = (agentStore.applyHeal as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(healCall.conversationId).toBe("conv-1");
    expect(healCall.supersededIds).toEqual(["m3"]);
    expect(healCall.insertions).toHaveLength(1);
    // Heal cursor inherits from the last existing row (m3 = inb-2),
    // NOT from triggerInboundId on the failure event. Heal rows are
    // repairs of past state and must not advance the cursor.
    expect(healCall.lastInboundMessageId).toBe("inb-2");
    // Re-emits the original inbound/ready so the failed turn retries
    expect(step.sendEvent).toHaveBeenCalledTimes(1);
    const [stepId, payload] = step.sendEvent.mock.calls[0]!;
    expect(stepId).toBe("retry-inbound-ready");
    expect(payload).toMatchObject({
      name: "inbound/ready",
      data: { conversationId: "conv-1", triggerInboundId: "inbound-1" },
    });
  });

  // Regression: flush-style failures (triggerInboundId === null) used to
  // crash here because the prior code fell back to an empty string for the
  // cursor, which Postgres rejects as an invalid UUID. Heal must inherit
  // from the existing history's cursor instead.
  it("preserves null triggerInboundId on flush-style retries and inherits cursor", async () => {
    const agentStore = mockAgentStore({
      getHistoryWithIds: vi.fn().mockResolvedValue([
        {
          id: "m1",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
          },
          lastInboundMessageId: "inb-9",
        },
      ]),
    });
    const step = mockStep();
    const flushEvent = { data: { ...baseEvent.data, triggerInboundId: null } };
    const fn = createRecoverConversation({ agentStore }) as any;
    await fn.fn({ event: flushEvent, step });
    // Re-emit preserves null
    const payload = step.sendEvent.mock.calls[0]![1];
    expect(payload.data.triggerInboundId).toBeNull();
    // applyHeal got the inherited cursor from m1, NOT empty string
    const healCall = (agentStore.applyHeal as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(healCall.lastInboundMessageId).toBe("inb-9");
    expect(healCall.lastInboundMessageId).not.toBe("");
  });

  it("throws when the conversation's profile is missing", async () => {
    const agentStore = mockAgentStore({
      getHistoryWithIds: vi.fn().mockResolvedValue([
        {
          id: "m1",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
          },
          lastInboundMessageId: "inb-1",
        },
      ]),
      getProfile: vi.fn().mockResolvedValue(undefined),
    });
    const fn = createRecoverConversation({ agentStore }) as any;
    await expect(fn.fn({ event: baseEvent, step: mockStep() })).rejects.toThrow(
      /Profile not found/,
    );
  });
});
