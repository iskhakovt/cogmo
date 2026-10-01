import { describe, expect, it, vi } from "vitest";
import { mockAgentStore } from "../../test/factories.js";
import { findUnknownCompartment } from "./find-unknown-compartment.js";

const FAKE_TX = { __mockTx: true } as never;

function store(customNames: ReadonlyArray<string>) {
  return mockAgentStore({
    listCustomCompartments: vi
      .fn()
      .mockResolvedValue(customNames.map((name) => ({ name, description: "" }))),
  });
}

describe("findUnknownCompartment", () => {
  it("accepts core and the user's custom compartments", async () => {
    const agentStore = store(["gaming"]);
    expect(
      await findUnknownCompartment(FAKE_TX, agentStore, "user-1", ["work", "gaming"]),
    ).toBeNull();
    expect(agentStore.listCustomCompartments).toHaveBeenCalledWith(FAKE_TX, "user-1");
  });

  it("returns the first value that is neither", async () => {
    expect(
      await findUnknownCompartment(FAKE_TX, store([]), "user-1", ["work", "ghost", "other"]),
    ).toBe("ghost");
  });
});
