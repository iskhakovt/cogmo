import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import { mockTransportStore } from "../../test/factories.js";
import type { ChannelIdentityMode } from "../store/schema.js";
import { createSenders } from "./senders.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

/** The namespace on channel `ch-1`, whose mode is `mode` and whose identity rows are `known`. */
function sendersOn(mode: ChannelIdentityMode | undefined, known: ReadonlyArray<string>) {
  const transportStore = mockTransportStore({
    getChannelIdentityMode: vi.fn().mockResolvedValue(mode),
    resolveUser: vi.fn(async (_tx, _channelId, handle: string) =>
      known.includes(handle) ? { userId: `user-${handle}` } : undefined,
    ),
  });
  const senders = createSenders({ channelId: "ch-1", runInTx: fakeRunInTx, transportStore });
  return { senders, transportStore };
}

describe("senders.admits", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("admits anyone on a fixed channel without resolving the handle", async () => {
    const { senders, transportStore } = sendersOn("fixed", []);

    expect(await senders.admits("999")).toBe(true);
    expect(transportStore.resolveUser).not.toHaveBeenCalled();
  });

  it.each(["mapped", "create"] as const)(
    "admits a handle with an identity row on a %s channel, and no other",
    async (mode) => {
      const { senders, transportStore } = sendersOn(mode, ["111"]);

      expect(await senders.admits("111")).toBe(true);
      expect(await senders.admits("999")).toBe(false);
      expect(transportStore.getChannelIdentityMode).toHaveBeenCalledWith(FAKE_TX, "ch-1");
      expect(transportStore.resolveUser).toHaveBeenCalledWith(FAKE_TX, "ch-1", "999");
    },
  );

  it("admits no one for a channel with no row, and warns", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { senders } = sendersOn(undefined, ["111"]);

    expect(await senders.admits("111")).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith({ channelId: "ch-1" }, expect.any(String));
  });
});
