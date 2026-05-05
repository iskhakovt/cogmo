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
    expect(agentStore.setConversationStatus).not.toHaveBeenCalled();
  });

  it("marks conversation errored on first failure", async () => {
    const agentStore = mockAgentStore();
    const fn = createRecoverConversation({ agentStore }) as any;
    const result = await fn.fn({ event: baseEvent, step: mockStep() });
    expect(result).toEqual({ status: "marked_errored" });
    expect(agentStore.setConversationStatus).toHaveBeenCalledWith("conv-1", "errored");
  });
});
