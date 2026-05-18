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
    const fn = createRecoverConversation({ runInTx: fakeRunInTx, agentStore });
    const result = await invokeInngestFn<RecoverConversationCtx>(fn, {
      event: baseEvent,
      step: mockStep(),
    });
    expect(result).toEqual({ status: "skipped", reason: "already_errored" });
    expect(agentStore.setConversationStatus).not.toHaveBeenCalled();
  });

  it("marks conversation errored on first failure", async () => {
    const agentStore = mockAgentStore();
    const fn = createRecoverConversation({ runInTx: fakeRunInTx, agentStore });
    const result = await invokeInngestFn<RecoverConversationCtx>(fn, {
      event: baseEvent,
      step: mockStep(),
    });
    expect(result).toEqual({ status: "marked_errored" });
    expect(agentStore.setConversationStatus).toHaveBeenCalledWith(
      expect.anything(),
      "conv-1",
      "errored",
    );
  });

  // Pin the log-payload contract that the future evolution
  // failure-reflector (`p2` in todo.md) buckets on. errorClass and
  // causeClass come straight off the `conversation/errored` event;
  // dropping either would break the reflector's class taxonomy.
  it("logs errorClass, causeClass, and errorMessage on the marker write", async () => {
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
      }),
      "recover-conversation: conversation marked errored",
    );
    warnSpy.mockRestore();
  });
});
