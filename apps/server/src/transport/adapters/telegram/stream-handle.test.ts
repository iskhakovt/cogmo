import type { Bot } from "grammy";
import { err } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockAttachmentStore } from "../../../test/factories.js";
import { TelegramStreamHandle } from "./stream-handle.js";
import { type StreamInput, transition } from "./stream-state.js";

vi.mock("./stream-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stream-state.js")>();
  return { ...actual, transition: vi.fn(actual.transition) };
});

const actual = await vi.importActual<typeof import("./stream-state.js")>("./stream-state.js");

function fakeBot() {
  const api = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 100 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    sendChatAction: vi.fn().mockResolvedValue(true),
    sendPhoto: vi.fn().mockResolvedValue({ message_id: 101 }),
    sendDocument: vi.fn().mockResolvedValue({ message_id: 102 }),
  };
  // The handle reads `bot.api` alone; the rest of grammY's Bot is not exercised.
  return { bot: { api } as unknown as Bot, api };
}

function openHandle(bot: Bot): TelegramStreamHandle {
  return new TelegramStreamHandle(
    bot,
    mockAttachmentStore(),
    42,
    "run-1",
    { chunkChars: 4000, allowEdits: true },
    new Set(),
  );
}

/** Make the machine throw on the first input of `type`. */
function throwOn(type: StreamInput["type"]): void {
  let thrown = false;
  vi.mocked(transition).mockImplementation((state, input, opts) => {
    if (input.type === type && !thrown) {
      thrown = true;
      throw new Error("machine bug");
    }
    return actual.transition(state, input, opts);
  });
}

/** Resolves with "hung" if `promise` hasn't settled within a few event-loop turns. */
async function orHung<T>(promise: Promise<T>): Promise<T | "hung"> {
  return Promise.race([
    promise,
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 50)),
  ]);
}

describe("TelegramStreamHandle", () => {
  afterEach(() => {
    vi.mocked(transition).mockImplementation(actual.transition);
  });

  describe("a throw inside the machine", () => {
    it("fails the handle when it throws on a write's result, rather than wedge it", async () => {
      const { bot, api } = fakeBot();
      const handle = openHandle(bot);
      throwOn("api_ok");

      const failed = err(expect.stringContaining("machine bug"));
      expect(await orHung(handle.push({ type: "text_delta", text: "Hello" }))).toEqual(failed);
      expect(await orHung(handle.finish())).toEqual(failed);
      expect(await orHung(handle.done)).toEqual(failed);
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("fails the handle when it throws on a call", async () => {
      const { bot } = fakeBot();
      const handle = openHandle(bot);
      throwOn("finish");

      expect(await orHung(handle.finish())).toEqual(err(expect.stringContaining("machine bug")));
    });
  });
});
