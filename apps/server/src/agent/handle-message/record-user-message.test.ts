import { NonRetriableError } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { fakeRunInTx, makeStepRun, nullStepSendEvent } from "../../test/factories.js";
import {
  type RecordUserMessageArgs,
  type RecordUserMessageDeps,
  recordUserMessage,
} from "./record-user-message.js";

const VOICE_BATCH: RecordUserMessageArgs = {
  conversationId: "conv",
  inboundMessages: [
    {
      id: "in-1",
      content: [{ type: "voice", path: "voice/in-1.ogg", mediaType: "audio/ogg" }],
      source: "user",
    },
  ],
  voiceBundle: undefined,
  snapshot: { profileId: "profile", model: "model-a" },
  maxInboundId: "in-1",
  firstInboundId: "in-1",
};

function setup() {
  const agentStore = mock<RecordUserMessageDeps["agentStore"]>();
  const attachments = mock<RecordUserMessageDeps["attachments"]>();
  const deps: RecordUserMessageDeps = {
    runInTx: fakeRunInTx,
    transportStore: mock<RecordUserMessageDeps["transportStore"]>(),
    images: mock<RecordUserMessageDeps["images"]>(),
    resolveProvider: vi.fn(),
    agentStore,
    attachments,
  };
  return { deps, agentStore, attachments };
}

describe("recordUserMessage", () => {
  it("fails a voice batch non-retriably when no STT provider is configured, writing no user row", async () => {
    const { deps, agentStore, attachments } = setup();

    const recorded = recordUserMessage(
      { run: makeStepRun(), sendEvent: nullStepSendEvent() },
      deps,
      VOICE_BATCH,
    );

    await expect(recorded).rejects.toBeInstanceOf(NonRetriableError);
    await expect(recorded).rejects.toThrow("no STT provider configured");
    expect(attachments.download).not.toHaveBeenCalled();
    expect(agentStore.insertMessage).not.toHaveBeenCalled();
  });
});
