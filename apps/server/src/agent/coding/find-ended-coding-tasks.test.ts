import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { fakeRunInTx } from "../../test/factories.js";
import { findEndedCodingTasks } from "./find-ended-coding-tasks.js";
import type { CodingStore } from "./store/index.js";

describe("findEndedCodingTasks", () => {
  it("reports the tasks that are terminal or gone, from their statuses alone", async () => {
    const store = mock<CodingStore>();
    store.getTaskStatuses.mockResolvedValue([
      { id: "queued", status: "queued" },
      { id: "awaiting", status: "awaiting_approval" },
      { id: "verifying", status: "verifying" },
      { id: "pr-open", status: "pr_open" },
      { id: "failed", status: "failed" },
      { id: "cancelled", status: "cancelled" },
    ]);
    const taskIds = ["queued", "awaiting", "verifying", "pr-open", "failed", "cancelled", "gone"];

    const ended = await findEndedCodingTasks({ runInTx: fakeRunInTx, store }, taskIds);

    expect(store.getTaskStatuses).toHaveBeenCalledWith(expect.anything(), taskIds);
    expect(store.getTasksByIds).not.toHaveBeenCalled();
    expect(ended).toEqual(new Set(["pr-open", "failed", "cancelled", "gone"]));
  });

  it("rejects when the lookup fails", async () => {
    const store = mock<CodingStore>();
    store.getTaskStatuses.mockRejectedValue(new Error("connection reset"));

    await expect(findEndedCodingTasks({ runInTx: fakeRunInTx, store }, ["t1"])).rejects.toThrow(
      "connection reset",
    );
  });
});
