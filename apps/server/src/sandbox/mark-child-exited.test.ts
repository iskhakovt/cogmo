import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../db/index.js";
import { markChildExited } from "./mark-child-exited.js";
import type { TaskContainerRow } from "./proxy/index.js";
import type { SandboxStore } from "./store/index.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);
const AT = new Date("2026-11-26T12:00:00Z");

function childIn(status: TaskContainerRow["status"]): TaskContainerRow {
  return { id: "row-1", dockerId: "c1", parentId: "parent-row", status };
}

describe("markChildExited", () => {
  it("moves a child from the status it was read in", async () => {
    const store = mock<SandboxStore>();
    store.transitionContainerStatus.mockResolvedValue({ kind: "transitioned" });

    const exited = await markChildExited(
      { store, runInTx: fakeRunInTx },
      { child: childIn("running"), cause: "removed_by_task", at: AT },
    );

    expect(exited.isOk()).toBe(true);
    expect(store.transitionContainerStatus).toHaveBeenCalledWith(expect.anything(), {
      id: "row-1",
      from: "running",
      to: "exited",
      at: AT,
    });
  });

  it("runs once more from running when a start moved the row after it was read", async () => {
    const store = mock<SandboxStore>();
    store.transitionContainerStatus
      .mockResolvedValueOnce({ kind: "stale", status: "running" })
      .mockResolvedValueOnce({ kind: "transitioned" });

    const exited = await markChildExited(
      { store, runInTx: fakeRunInTx },
      { child: childIn("starting"), cause: "removed_by_task", at: AT },
    );

    expect(exited.isOk()).toBe(true);
    expect(store.transitionContainerStatus).toHaveBeenCalledTimes(2);
    expect(store.transitionContainerStatus).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ from: "running", to: "exited" }),
    );
  });

  it.each(["exited", "reaped"] as const)(
    "writes nothing more for a row another path moved to %s",
    async (status) => {
      const store = mock<SandboxStore>();
      store.transitionContainerStatus.mockResolvedValue({ kind: "stale", status });

      const exited = await markChildExited(
        { store, runInTx: fakeRunInTx },
        { child: childIn("starting"), cause: "missing_from_daemon", at: AT },
      );

      expect(exited.isOk()).toBe(true);
      expect(store.transitionContainerStatus).toHaveBeenCalledTimes(1);
    },
  );

  it("writes nothing for a child read as exited", async () => {
    const store = mock<SandboxStore>();

    const exited = await markChildExited(
      { store, runInTx: fakeRunInTx },
      { child: childIn("exited"), cause: "removed_by_task", at: AT },
    );

    expect(exited.isOk()).toBe(true);
    expect(store.transitionContainerStatus).not.toHaveBeenCalled();
  });

  it("is store_failed, with the cause, when the write throws", async () => {
    const store = mock<SandboxStore>();
    const cause = new Error("connection reset");
    store.transitionContainerStatus.mockRejectedValue(cause);

    const exited = await markChildExited(
      { store, runInTx: fakeRunInTx },
      { child: childIn("running"), cause: "removed_by_task", at: AT },
    );

    expect(exited._unsafeUnwrapErr()).toEqual({ kind: "store_failed", cause });
  });
});
