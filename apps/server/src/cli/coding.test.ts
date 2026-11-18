import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { CodingStore } from "../agent/coding/store/index.js";
import { captureIo, fakeRunInTx } from "../test/factories.js";
import { type CodingCliDeps, codingCli } from "./coding.js";
import { type CliIo, type LoadDeps, runCli } from "./run.js";

const TASK_ID = "019d0000-0000-7000-8000-000000000001";

function deps() {
  const codingStore = mock<CodingStore>();
  codingStore.cancelTaskIfActive.mockResolvedValue({ kind: "cancelled", conversationId: null });
  return { runInTx: fakeRunInTx, codingStore };
}

function run(argv: readonly string[], d: CodingCliDeps, io: CliIo): Promise<number> {
  return runCli(
    codingCli(io, async () => d),
    argv,
    io,
  );
}

describe("codingCli", () => {
  it.each([[[]], [["--help"]], [["cancel", "--help"]]])(
    "prints help for %j on stdout, exits 0, and loads nothing",
    async (argv) => {
      const loadDeps = vi.fn<LoadDeps<CodingCliDeps>>(async () => deps());
      const { io, out, err } = captureIo();

      expect(await runCli(codingCli(io, loadDeps), argv, io)).toBe(0);
      expect(out.join("\n")).toMatch(/^coding/);
      expect(err).toEqual([]);
      expect(loadDeps).not.toHaveBeenCalled();
    },
  );

  describe("cancel", () => {
    it("cancels the task as user_cancelled (exit 0)", async () => {
      const { io, out, err } = captureIo();
      const d = deps();

      expect(await run(["cancel", TASK_ID], d, io)).toBe(0);
      expect(out).toEqual([`Cancelled coding task ${TASK_ID}.`]);
      expect(err).toEqual([]);
      expect(d.codingStore.cancelTaskIfActive).toHaveBeenCalledWith(
        expect.anything(),
        TASK_ID,
        "user_cancelled",
      );
    });

    it.each([
      [{ kind: "already_terminal", status: "pr_open" } as const, "has already ended: pr_open."],
      [{ kind: "already_terminal", status: "cancelled" } as const, "has already ended: cancelled."],
      [{ kind: "not_found" } as const, `No coding task ${TASK_ID}.`],
    ])("reports %j on stderr (exit 1)", async (outcome, message) => {
      const { io, out, err } = captureIo();
      const d = deps();
      d.codingStore.cancelTaskIfActive.mockResolvedValue(outcome);

      expect(await run(["cancel", TASK_ID], d, io)).toBe(1);
      expect(err.join("\n")).toContain(message);
      expect(out).toEqual([]);
    });

    it.each([
      [["not-a-uuid"], /expected a lowercase UUID, got "not-a-uuid"/],
      [[TASK_ID.toUpperCase()], /expected a lowercase UUID/],
      [[`${TASK_ID}x`], /expected a lowercase UUID/],
      [[""], /argument 2 is empty/],
      [[], /No value provided for task-id/],
      [[TASK_ID, "extra"], /Unknown arguments/],
    ])("rejects cancel %j with exit 2 before loading anything", async (args, message) => {
      const loadDeps = vi.fn<LoadDeps<CodingCliDeps>>(async () => deps());
      const { io, out, err } = captureIo();

      expect(await runCli(codingCli(io, loadDeps), ["cancel", ...args], io)).toBe(2);
      expect(err.join("\n")).toMatch(message);
      expect(out).toEqual([]);
      expect(loadDeps).not.toHaveBeenCalled();
    });

    it("propagates a store failure instead of reporting an outcome", async () => {
      const { io, out } = captureIo();
      const d = deps();
      d.codingStore.cancelTaskIfActive.mockRejectedValue(new Error("connection reset"));

      await expect(run(["cancel", TASK_ID], d, io)).rejects.toThrow("connection reset");
      expect(out).toEqual([]);
    });
  });
});
