import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { expectOk } from "../../test/assertions.js";
import { fakeRunInTx } from "../../test/factories.js";
import { cancelCodingTask } from "./cancel-coding-task.js";
import type { CodingStore } from "./store/index.js";

const TASK_ID = "019d0000-0000-7000-8000-000000000001";

function deps() {
  return { runInTx: fakeRunInTx, codingStore: mock<CodingStore>() };
}

describe("cancelCodingTask", () => {
  it.each([["user_cancelled"], ["user_requested_revisions"]] as const)(
    "cancels through the store's conditional cancel, writing %s",
    async (reason) => {
      const d = deps();
      d.codingStore.cancelTaskIfActive.mockResolvedValue({
        kind: "cancelled",
        conversationId: null,
      });

      const cancelled = await cancelCodingTask(d, { taskId: TASK_ID, reason });

      expect(expectOk(cancelled)).toBeUndefined();
      expect(d.codingStore.cancelTaskIfActive).toHaveBeenCalledWith(
        expect.anything(),
        TASK_ID,
        reason,
      );
    },
  );

  it.each([
    [
      { kind: "already_terminal", status: "failed" } as const,
      { kind: "already_terminal", status: "failed" },
    ],
    [{ kind: "not_found" } as const, { kind: "not_found" }],
  ])("returns %j as an error", async (outcome, error) => {
    const d = deps();
    d.codingStore.cancelTaskIfActive.mockResolvedValue(outcome);

    const cancelled = await cancelCodingTask(d, { taskId: TASK_ID, reason: "user_cancelled" });

    expect(cancelled._unsafeUnwrapErr()).toEqual(error);
  });

  it("rejects when the store throws", async () => {
    const d = deps();
    d.codingStore.cancelTaskIfActive.mockRejectedValue(new Error("connection reset"));

    await expect(
      cancelCodingTask(d, { taskId: TASK_ID, reason: "user_cancelled" }),
    ).rejects.toThrow("connection reset");
  });
});
