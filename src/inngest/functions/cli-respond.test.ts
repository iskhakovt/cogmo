import { describe, expect, it, vi } from "vitest";
import type { Channel } from "../../channels/types.js";
import { createCliRespond } from "./cli-respond.js";

function mockChannel(): Channel {
  return {
    name: "cli",
    write: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

describe("createCliRespond", () => {
  it("calls cliChannel.write with event text", async () => {
    const channel = mockChannel();
    const fn = createCliRespond(channel);
    const handler = (fn as any).fn;

    await handler({
      event: {
        data: {
          conversationId: "conv-1",
          channel: "cli",
          chatId: "chat-1",
          text: "hello from assistant",
        },
      },
    });

    expect(channel.write).toHaveBeenCalledWith("hello from assistant");
  });
});
