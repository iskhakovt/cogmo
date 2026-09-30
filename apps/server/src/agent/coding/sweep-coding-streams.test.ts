import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { codingTaskRow } from "../../test/coding-fixtures.js";
import { fakeRunInTx } from "../../test/factories.js";
import type { CodingStore } from "./store/index.js";
import type { CodingStreamingRegistry } from "./streaming-registry.js";
import { sweepCodingStreams } from "./sweep-coding-streams.js";

function deps(held: ReadonlyArray<string>) {
  const store = mock<CodingStore>();
  const registry = mock<Pick<CodingStreamingRegistry, "taskIds" | "sweep">>();
  registry.taskIds.mockReturnValue(held);
  registry.sweep.mockReturnValue(0);
  return { store, registry, runInTx: fakeRunInTx };
}

describe("sweepCodingStreams", () => {
  it("reports the held tasks that are terminal or gone as ended", async () => {
    const d = deps(["queued", "awaiting", "verifying", "pr-open", "failed", "cancelled", "gone"]);
    d.store.getTasksByIds.mockResolvedValue([
      codingTaskRow({ id: "queued", status: "queued" }),
      codingTaskRow({ id: "awaiting", status: "awaiting_approval" }),
      codingTaskRow({ id: "verifying", status: "verifying" }),
      codingTaskRow({ id: "pr-open", status: "pr_open" }),
      codingTaskRow({ id: "failed", status: "failed" }),
      codingTaskRow({ id: "cancelled", status: "cancelled" }),
    ]);
    d.registry.sweep.mockReturnValue(2);

    const result = await sweepCodingStreams(d);

    expect(d.store.getTasksByIds).toHaveBeenCalledWith(expect.anything(), [
      "queued",
      "awaiting",
      "verifying",
      "pr-open",
      "failed",
      "cancelled",
      "gone",
    ]);
    expect(d.registry.sweep).toHaveBeenCalledWith(
      new Set(["pr-open", "failed", "cancelled", "gone"]),
    );
    expect(result).toEqual({ held: 7, ended: 4, released: 2 });
  });

  it("skips the database when the registry holds nothing", async () => {
    const d = deps([]);

    expect(await sweepCodingStreams(d)).toEqual({ held: 0, ended: 0, released: 0 });
    expect(d.store.getTasksByIds).not.toHaveBeenCalled();
    expect(d.registry.sweep).not.toHaveBeenCalled();
  });

  it("leaves the registry untouched when the lookup fails", async () => {
    const d = deps(["t1"]);
    d.store.getTasksByIds.mockRejectedValue(new Error("connection reset"));

    await expect(sweepCodingStreams(d)).rejects.toThrow("connection reset");
    expect(d.registry.sweep).not.toHaveBeenCalled();
  });
});
