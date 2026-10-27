import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../db/index.js";
import { markContainerExited } from "./mark-container-exited.js";
import type { SandboxStore } from "./store/index.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);
const AT = new Date("2026-04-27T12:00:00Z");

describe("markContainerExited", () => {
  it("moves the row from its read status to exited", async () => {
    const store = mock<SandboxStore>();
    store.transitionContainerStatus.mockResolvedValue({ kind: "transitioned" });
    const result = await markContainerExited(
      { store, runInTx: fakeRunInTx },
      { id: "row-1", dockerId: "c1", from: "running", at: AT },
    );
    expect(result).toEqual({ kind: "transitioned" });
    expect(store.transitionContainerStatus).toHaveBeenCalledWith(expect.anything(), {
      id: "row-1",
      from: "running",
      to: "exited",
      at: AT,
    });
  });

  it("returns stale when another path finished the row", async () => {
    const store = mock<SandboxStore>();
    store.transitionContainerStatus.mockResolvedValue({ kind: "stale", status: "reaped" });
    const result = await markContainerExited(
      { store, runInTx: fakeRunInTx },
      { id: "row-1", dockerId: "c1", from: "starting", at: AT },
    );
    expect(result).toEqual({ kind: "stale", status: "reaped" });
  });
});
