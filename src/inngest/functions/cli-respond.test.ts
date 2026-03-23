import { describe, expect, it, vi } from "vitest";
import type { CliChannel } from "../../channels/cli.js";
import { createCliRespond } from "./cli-respond.js";

function mockCliChannel(): CliChannel {
  return {
    name: "cli",
    write: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as any;
}

describe("createCliRespond", () => {
  it("calls cliChannel.write with event text", async () => {
    const channel = mockCliChannel();
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
