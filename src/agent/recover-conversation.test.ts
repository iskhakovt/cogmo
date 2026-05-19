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
});
