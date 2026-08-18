import { describe, expect, it, vi } from "vitest";
import type { AgentStore } from "../store/index.js";
import { addModelRouting } from "./add-model-routing.js";

const FAKE_TX = { __mockTx: true } as never;

function makeStore(opts: { nextPosition?: number; insertedId?: string } = {}) {
  return {
    getNextModelProviderPosition: vi.fn().mockResolvedValue(opts.nextPosition ?? 0),
    addModelProvider: vi.fn().mockResolvedValue({ id: opts.insertedId ?? "row-1" }),
  } as unknown as AgentStore;
}

describe("addModelRouting", () => {
  it("auto-picks the next position when none is supplied", async () => {
    const store = makeStore({ nextPosition: 3 });
    const result = await addModelRouting(
      { runInTx: (cb) => cb(FAKE_TX), agentStore: store },
      { model: "x-ai/grok-4.3", providerId: "p-1" },
    );
    expect(result.position).toBe(3);
    expect(store.getNextModelProviderPosition).toHaveBeenCalledWith(FAKE_TX, "x-ai/grok-4.3");
    expect(store.addModelProvider).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        model: "x-ai/grok-4.3",
        providerId: "p-1",
        position: 3,
        userSelectable: true,
        contextWindow: null,
        maxOutputTokens: null,
      }),
    );
  });

  it("honors an explicit position and skips the next-position lookup", async () => {
    const store = makeStore();
    await addModelRouting(
      { runInTx: (cb) => cb(FAKE_TX), agentStore: store },
      { model: "m", providerId: "p", position: 5 },
    );
    expect(store.getNextModelProviderPosition).not.toHaveBeenCalled();
    expect(store.addModelProvider).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ position: 5 }),
    );
  });

  it("propagates explicit context_window / max_output_tokens overrides", async () => {
    const store = makeStore();
    await addModelRouting(
      { runInTx: (cb) => cb(FAKE_TX), agentStore: store },
      {
        model: "m",
        providerId: "p",
        contextWindow: 200_000,
        maxOutputTokens: 8_000,
      },
    );
    expect(store.addModelProvider).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        contextWindow: 200_000,
        maxOutputTokens: 8_000,
      }),
    );
  });

  // A zero cannot describe a real model — stored, it would make every
  // request built from the row invalid — and it reaches here because the
  // CLI's flag parser accepts any non-negative integer (`--position 0` is
  // meaningful, so the check belongs at this boundary, not that one).
  it.each([
    ["contextWindow", { contextWindow: 0 }],
    ["maxOutputTokens", { maxOutputTokens: 0 }],
    ["a negative contextWindow", { contextWindow: -1 }],
    ["a negative maxOutputTokens", { maxOutputTokens: -1 }],
  ])("refuses %s and writes nothing", async (_label, override) => {
    const store = makeStore();
    await expect(
      addModelRouting(
        { runInTx: (cb) => cb(FAKE_TX), agentStore: store },
        { model: "m", providerId: "p-1", ...override },
      ),
    ).rejects.toThrow(/must be a positive number of tokens/);
    expect(store.addModelProvider).not.toHaveBeenCalled();
  });

  it("defaults userSelectable to true when omitted", async () => {
    const store = makeStore();
    await addModelRouting(
      { runInTx: (cb) => cb(FAKE_TX), agentStore: store },
      { model: "m", providerId: "p" },
    );
    expect(store.addModelProvider).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ userSelectable: true }),
    );
  });
});
