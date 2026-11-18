import { InngestTestEngine } from "@inngest/test";
import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { inngest } from "../../inngest/client.js";
import type { EventPublisher } from "../../inngest/durable.js";
import { codingTaskFailed } from "../../inngest/events.js";
import { codingRepoRow, codingTaskRow, FIXTURE_TASK_ID } from "../../test/coding-fixtures.js";
import { fakeRunInTx } from "../../test/factories.js";
import {
  type AnnounceTaskFailureDeps,
  announceTaskFailure,
  createTaskFailureAnnouncer,
} from "./announce-task-failure.js";
import type { CodingStore, CodingTaskRow } from "./store/index.js";
import type { CodingTaskFailureReason } from "./types.js";

const CONV_ID = "019d0000-0000-7000-8000-000000000777";
const ASSIGNMENT = {
  type: "host-path",
  branch: "cogmo/abc12345",
  worktreePath: "/tmp/worktrees/abc12345",
} as const;

function harness(opts: { repoName?: string; task?: Partial<CodingTaskRow> | null } = {}) {
  const store = mock<CodingStore>();
  store.getTask.mockResolvedValue(
    opts.task === null
      ? undefined
      : codingTaskRow({
          conversationId: CONV_ID,
          worktreeAssignment: ASSIGNMENT,
          status: "failed",
          ...opts.task,
        }),
  );
  store.getRepoById.mockResolvedValue(codingRepoRow({ name: opts.repoName ?? "skills" }));
  const publisher = mock<EventPublisher>();
  const deps: AnnounceTaskFailureDeps = { runInTx: fakeRunInTx, store, publisher };
  return { deps, publisher, store };
}

const failed = (reason: CodingTaskFailureReason, detail: string) => ({
  taskId: FIXTURE_TASK_ID,
  reason,
  detail,
});

describe("announceTaskFailure", () => {
  it.each(["presubmit_refused", "presubmit_stale_base"] as const)(
    "emits a skills-repo task's %s as a failure notice under its task's id",
    async (reason) => {
      const h = harness();

      const outcome = await announceTaskFailure(h.deps, failed(reason, "the detail"));

      expect(outcome).toEqual({ kind: "announced" });
      expect(h.publisher.send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "coding/task/failure-notice",
          data: {
            conversationId: CONV_ID,
            taskId: FIXTURE_TASK_ID,
            reason,
            detail: "the detail",
            branch: "cogmo/abc12345",
          },
          id: `failure-notice-${FIXTURE_TASK_ID}`,
        }),
      );
    },
  );

  it.each(["verify_failed", "pr_open_failed", "run_terminated", "unexpected_error"] as const)(
    "announces no %s, which a run renders or no notice covers",
    async (reason) => {
      const h = harness();

      expect(await announceTaskFailure(h.deps, failed(reason, "ruff: E501"))).toEqual({
        kind: "skipped",
        reason: "reason_not_announced",
      });
      expect(h.publisher.send).not.toHaveBeenCalled();
    },
  );

  it.each(["cli_exit_error", "verify_failed", "unexpected_error"] as const)(
    "announces a %s after a fix pass, which no run renders either",
    async (reason) => {
      const h = harness({ task: { presubmitFixPasses: 1 } });

      expect(await announceTaskFailure(h.deps, failed(reason, "the detail"))).toEqual({
        kind: "announced",
      });
      expect(h.publisher.send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "coding/task/failure-notice",
          data: expect.objectContaining({ reason, detail: "the detail" }),
        }),
      );
    },
  );

  it("announces nothing after a fix pass on another repo", async () => {
    const h = harness({ repoName: "cogmo", task: { presubmitFixPasses: 1 } });

    expect(await announceTaskFailure(h.deps, failed("verify_failed", "x"))).toEqual({
      kind: "skipped",
      reason: "not_skills_repo",
    });
  });

  it("announces nothing on another repo", async () => {
    const h = harness({ repoName: "cogmo" });

    expect(await announceTaskFailure(h.deps, failed("presubmit_refused", "ruff: E501"))).toEqual({
      kind: "skipped",
      reason: "not_skills_repo",
    });
    expect(h.publisher.send).not.toHaveBeenCalled();
  });

  it("announces nothing for a task with no conversation", async () => {
    const h = harness({ task: { conversationId: null, triggerSource: "evolution" } });

    expect(await announceTaskFailure(h.deps, failed("presubmit_stale_base", "main moved"))).toEqual(
      {
        kind: "skipped",
        reason: "no_conversation",
      },
    );
    expect(h.publisher.send).not.toHaveBeenCalled();
  });

  it("announces nothing for a task row that is gone", async () => {
    const h = harness({ task: null });

    expect(await announceTaskFailure(h.deps, failed("presubmit_refused", "ruff: E501"))).toEqual({
      kind: "skipped",
      reason: "task_not_found",
    });
    expect(h.publisher.send).not.toHaveBeenCalled();
  });

  it("throws on a pre-submit failure with no branch, which the verify run guarantees", async () => {
    const h = harness({ task: { worktreeAssignment: null } });

    await expect(
      announceTaskFailure(h.deps, failed("presubmit_refused", "ruff: E501")),
    ).rejects.toThrow(/no worktree_assignment/);
    expect(h.publisher.send).not.toHaveBeenCalled();
  });
});

describe("createTaskFailureAnnouncer", () => {
  const failedEvent = {
    name: "coding/task/failed",
    data: failed("presubmit_refused", "ruff: E501"),
  } as const;

  it("runs once per task on coding/task/failed", () => {
    const fn = createTaskFailureAnnouncer(harness().deps, inngest);

    expect(fn.opts.id).toBe("coding-announce-task-failure");
    expect(fn.opts.triggers).toEqual([codingTaskFailed]);
    expect(fn.opts.idempotency).toBe("event.data.taskId");
  });

  it("emits from its step `emit-failure-notice`, which a replay serves from its memo", async () => {
    const fresh = harness();
    const ran = await new InngestTestEngine({
      function: createTaskFailureAnnouncer(fresh.deps, inngest),
      events: [failedEvent],
    }).execute();
    expect(ran.error).toBeUndefined();
    expect(ran.result).toEqual({ kind: "announced" });
    expect(fresh.publisher.send).toHaveBeenCalledTimes(1);

    const replayed = harness();
    const memoized = await new InngestTestEngine({
      function: createTaskFailureAnnouncer(replayed.deps, inngest),
      events: [failedEvent],
      steps: [{ id: "emit-failure-notice", handler: () => ({ kind: "announced" }) }],
    }).execute();
    expect(memoized.result).toEqual({ kind: "announced" });
    expect(replayed.publisher.send).not.toHaveBeenCalled();
  });
});
