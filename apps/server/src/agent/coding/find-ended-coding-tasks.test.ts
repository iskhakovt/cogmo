import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { codingTaskRow } from "../../test/coding-fixtures.js";
import { fakeRunInTx } from "../../test/factories.js";
import { findEndedCodingTasks } from "./find-ended-coding-tasks.js";
import type { CodingStore } from "./store/index.js";

describe("findEndedCodingTasks", () => {
  it("reports the tasks that are terminal or gone", async () => {
    const store = mock<CodingStore>();
    store.getTasksByIds.mockResolvedValue([
      codingTaskRow({ id: "queued", status: "queued" }),
      codingTaskRow({ id: "awaiting", status: "awaiting_approval" }),
      codingTaskRow({ id: "verifying", status: "verifying" }),
      codingTaskRow({ id: "pr-open", status: "pr_open" }),
      codingTaskRow({ id: "failed", status: "failed" }),
      codingTaskRow({ id: "cancelled", status: "cancelled" }),
    ]);
    const taskIds = ["queued", "awaiting", "verifying", "pr-open", "failed", "cancelled", "gone"];

    const ended = await findEndedCodingTasks({ runInTx: fakeRunInTx, store }, taskIds);

    expect(store.getTasksByIds).toHaveBeenCalledWith(expect.anything(), taskIds);
    expect(ended).toEqual(new Set(["pr-open", "failed", "cancelled", "gone"]));
  });

  it("rejects when the lookup fails", async () => {
    const store = mock<CodingStore>();
    store.getTasksByIds.mockRejectedValue(new Error("connection reset"));

    await expect(findEndedCodingTasks({ runInTx: fakeRunInTx, store }, ["t1"])).rejects.toThrow(
      "connection reset",
    );
  });
});
