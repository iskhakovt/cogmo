import { describe, expect, it, vi } from "vitest";
import { CliChannel } from "./cli.js";

// Mock readline — we don't want real stdin/stdout
vi.mock("node:readline", () => {
  const listeners = new Map<string, (...args: any[]) => void>();
  return {
    createInterface: vi.fn(() => ({
      prompt: vi.fn(),
      on: vi.fn((event: string, cb: (...args: any[]) => void) => {
        listeners.set(event, cb);
      }),
      close: vi.fn(),
      // Expose for tests to simulate input
      _emit: (event: string, ...args: any[]) => listeners.get(event)?.(...args),
    })),
  };
});

function getReadline(cli: CliChannel): any {
  // Start the channel to create the readline interface
  const onMessage = vi.fn();
  cli.start(onMessage);
  return { rl: (cli as any).rl, onMessage };
}

describe("CliChannel", () => {
  it("dispatches messages with correct fields", () => {
    const cli = new CliChannel();
    const { rl, onMessage } = getReadline(cli);

    rl._emit("line", "hello world");

    expect(onMessage).toHaveBeenCalledOnce();
    const msg = onMessage.mock.calls[0]![0];
    expect(msg.channel).toBe("cli");
    expect(msg.userId).toBe("cli-user");
    expect(msg.text).toBe("hello world");
    expect(msg.chatId).toBeDefined();
    expect(msg.timestamp).toBeInstanceOf(Date);
  });

  it("skips empty lines", () => {
    const cli = new CliChannel();
    const { rl, onMessage } = getReadline(cli);

    rl._emit("line", "");
    rl._emit("line", "   ");

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("/new resets conversation id", () => {
    const cli = new CliChannel();
    const { rl, onMessage } = getReadline(cli);

    rl._emit("line", "first");
    const firstChatId = onMessage.mock.calls[0]![0].chatId;

    rl._emit("line", "/new");

    rl._emit("line", "second");
    const secondChatId = onMessage.mock.calls[1]![0].chatId;

    expect(firstChatId).not.toBe(secondChatId);
    // /new itself should not dispatch a message
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it("keeps same conversation id across messages", () => {
    const cli = new CliChannel();
    const { rl, onMessage } = getReadline(cli);

    rl._emit("line", "one");
    rl._emit("line", "two");

    expect(onMessage.mock.calls[0]![0].chatId).toBe(onMessage.mock.calls[1]![0].chatId);
  });

  it("write outputs text to console", () => {
    const cli = new CliChannel();
    getReadline(cli);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    cli.write("response text");

    expect(spy).toHaveBeenCalledWith("\nresponse text\n");
    spy.mockRestore();
  });
});
