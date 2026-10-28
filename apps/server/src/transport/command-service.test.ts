import { describe, expect, it } from "vitest";
import type { Transactor } from "../db/index.js";
import { mockTransportStore } from "../test/factories.js";
import { createCommandService } from "./command-service.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

describe("createCommandService", () => {
  it("closes the address's active session in one statement on resetConversation", async () => {
    const store = mockTransportStore();
    const service = createCommandService(fakeRunInTx, store);

    await service.resetConversation("ch-1", "12345");

    expect(store.closeActiveSession).toHaveBeenCalledWith(expect.anything(), "ch-1", "12345");
    expect(store.resolveSession).not.toHaveBeenCalled();
    expect(store.closeSession).not.toHaveBeenCalled();
  });
});
