import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../db/index.js";
import { markContainerRunning } from "./mark-container-running.js";
import type { SandboxStore } from "./store/index.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);
const AT = new Date("2026-04-27T12:00:00Z");

describe("markContainerRunning", () => {
  it("moves the row from starting to running", async () => {
    const store = mock<SandboxStore>();
    store.transitionContainerStatus.mockResolvedValue({ kind: "transitioned" });
    const result = await markContainerRunning(
      { store, runInTx: fakeRunInTx },
      { id: "row-1", dockerId: "c1", at: AT },
    );
    expect(result).toEqual({ kind: "transitioned" });
    expect(store.transitionContainerStatus).toHaveBeenCalledWith(expect.anything(), {
      id: "row-1",
      from: "starting",
      to: "running",
      at: AT,
    });
  });

  it("returns stale when another path finished the row first", async () => {
    const store = mock<SandboxStore>();
    store.transitionContainerStatus.mockResolvedValue({ kind: "stale", status: "reaped" });
    const result = await markContainerRunning(
      { store, runInTx: fakeRunInTx },
      { id: "row-1", dockerId: "c1", at: AT },
    );
    expect(result).toEqual({ kind: "stale", status: "reaped" });
  });
});
