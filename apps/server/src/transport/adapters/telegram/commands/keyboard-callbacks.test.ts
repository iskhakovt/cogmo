import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { mockTransportDeep } from "../../../../test/factories.js";
import { transportWith } from "../../../../test/telegram/command-fixtures.js";
import {
  handlePipelineGateCallback,
  handlePlanCallback,
  handleSkillsApprovalCallback,
} from "./keyboard-callbacks.js";

describe("handlePlanCallback", () => {
  const taskId = "019d0000-0000-7000-8000-000000000001";

  it("Approve dispatches to coding.approvePlan and returns approval text + toast", async () => {
    const approve = vi.fn().mockResolvedValue(ok({ taskId }));
    const transport = transportWith({
      coding: {
        approvePlan: approve,
        cancelTask: vi.fn(),
      },
    });

    const outcome = await handlePlanCallback(transport, { taskId, action: "approve" }, "user-tg-1");

    expect(approve).toHaveBeenCalledWith(taskId, "user-tg-1");
    expect(outcome.editText).toMatch(/Plan approved/);
    expect(outcome.toast).toBe("Approved");
    expect(outcome.followUp).toBeUndefined();
  });

  it("Cancel dispatches to coding.cancelTask with a reason and clears the keyboard", async () => {
    const cancel = vi.fn().mockResolvedValue(ok({ taskId }));
    const transport = transportWith({
      coding: {
        approvePlan: vi.fn(),
        cancelTask: cancel,
      },
    });

    const outcome = await handlePlanCallback(transport, { taskId, action: "cancel" }, "user-tg-1");

    expect(cancel).toHaveBeenCalledWith(taskId, "user-tg-1", "user cancelled the plan");
    expect(outcome.editText).toMatch(/Plan cancelled/);
    expect(outcome.toast).toBe("Cancelled");
  });

  it("Revise cancels the task AND posts a follow-up prompt for the user's revisions", async () => {
    const cancel = vi.fn().mockResolvedValue(ok({ taskId }));
    const transport = transportWith({
      coding: {
        approvePlan: vi.fn(),
        cancelTask: cancel,
      },
    });

    const outcome = await handlePlanCallback(transport, { taskId, action: "revise" }, "user-tg-1");

    expect(cancel).toHaveBeenCalledWith(taskId, "user-tg-1", "user requested revisions");
    expect(outcome.editText).toMatch(/Plan revised/);
    expect(outcome.followUp).toMatch(/what you'd like changed/);
    expect(outcome.toast).toBe("Revising");
  });

  it("identity_rejected from Transport surfaces an unauthorized message — no state change attempted twice", async () => {
    const approve = vi.fn().mockResolvedValue(err({ code: "identity_rejected" as const }));
    const transport = transportWith({
      coding: {
        approvePlan: approve,
        cancelTask: vi.fn(),
      },
    });

    const outcome = await handlePlanCallback(
      transport,
      { taskId, action: "approve" },
      "wrong-user",
    );

    expect(approve).toHaveBeenCalledTimes(1);
    expect(outcome.editText).toMatch(/not authorized/);
    expect(outcome.toast).toMatch(/not authorized/);
  });

  it("double-tap Approve gets task_already_approved (idempotent at the Transport boundary)", async () => {
    const approve = vi
      .fn()
      .mockResolvedValue(err({ code: "task_already_approved" as const, taskId }));
    const transport = transportWith({
      coding: {
        approvePlan: approve,
        cancelTask: vi.fn(),
      },
    });

    const outcome = await handlePlanCallback(transport, { taskId, action: "approve" }, "user-tg-1");

    expect(outcome.editText).toMatch(/already approved/);
    // Toast and editText match — both come from errorMessage(error.code).
    expect(outcome.toast).toBe(outcome.editText);
  });

  it("Cancel after task is already terminal surfaces task_already_terminal", async () => {
    const cancel = vi
      .fn()
      .mockResolvedValue(err({ code: "task_already_terminal" as const, taskId, status: "failed" }));
    const transport = transportWith({
      coding: {
        approvePlan: vi.fn(),
        cancelTask: cancel,
      },
    });

    const outcome = await handlePlanCallback(transport, { taskId, action: "cancel" }, "user-tg-1");

    expect(outcome.editText).toMatch(/already finished/);
    expect(outcome.editText).toMatch(/failed/);
  });
});

describe("handleSkillsApprovalCallback", () => {
  const pendingId = "019d0000-0000-7000-8000-000000000099";

  it("Approve dispatches to skills.approveDeploy and reports the live skill name + sha", async () => {
    const approve = vi
      .fn()
      .mockResolvedValue(ok({ pendingId, skillName: "echo", gitSha: "abcdef0123" }));
    const transport = transportWith({
      skills: {
        approveDeploy: approve,
        denyDeploy: vi.fn(),
      },
    });

    const outcome = await handleSkillsApprovalCallback(
      transport,
      { pendingId, action: "approve" },
      "user-tg-1",
      "chat-1",
    );

    expect(approve).toHaveBeenCalledWith(pendingId, "user-tg-1", "chat-1");
    expect(outcome.editText).toMatch(/Approved/);
    expect(outcome.editText).toMatch(/echo/);
    expect(outcome.editText).toMatch(/abcdef0/);
    expect(outcome.toast).toBe("Approved");
  });

  it("Deny dispatches to skills.denyDeploy without a reason and clears the keyboard", async () => {
    const deny = vi.fn().mockResolvedValue(ok({ pendingId }));
    const transport = transportWith({
      skills: {
        approveDeploy: vi.fn(),
        denyDeploy: deny,
      },
    });

    const outcome = await handleSkillsApprovalCallback(
      transport,
      { pendingId, action: "deny" },
      "user-tg-1",
      "chat-1",
    );

    expect(deny).toHaveBeenCalledWith(pendingId, "user-tg-1");
    expect(outcome.editText).toMatch(/denied/);
    expect(outcome.editText).toMatch(/no main advance/);
    expect(outcome.toast).toBe("Denied");
  });

  it("identity_rejected from Transport surfaces an unauthorized message", async () => {
    const approve = vi.fn().mockResolvedValue(err({ code: "identity_rejected" as const }));
    const transport = transportWith({
      skills: {
        approveDeploy: approve,
        denyDeploy: vi.fn(),
      },
    });

    const outcome = await handleSkillsApprovalCallback(
      transport,
      { pendingId, action: "approve" },
      "wrong-user",
      "chat-1",
    );

    expect(outcome.editText).toMatch(/not authorized/);
    expect(outcome.toast).toMatch(/not authorized/);
  });

  it("double-tap on already-resolved deploy gets skill_deploy_not_pending", async () => {
    const approve = vi.fn().mockResolvedValue(
      err({
        code: "skill_deploy_not_pending" as const,
        pendingId,
        status: "denied",
      }),
    );
    const transport = transportWith({
      skills: {
        approveDeploy: approve,
        denyDeploy: vi.fn(),
      },
    });

    const outcome = await handleSkillsApprovalCallback(
      transport,
      { pendingId, action: "approve" },
      "user-tg-1",
      "chat-1",
    );

    expect(outcome.editText).toMatch(/can't be acted on/);
    expect(outcome.editText).toMatch(/denied/);
  });

  it("approve runner failure (skill_deploy_register_failed) surfaces the runner reason", async () => {
    const approve = vi.fn().mockResolvedValue(
      err({
        code: "skill_deploy_register_failed" as const,
        pendingId,
        reason: "non_fast_forward_at_approve_time",
      }),
    );
    const transport = transportWith({
      skills: {
        approveDeploy: approve,
        denyDeploy: vi.fn(),
      },
    });

    const outcome = await handleSkillsApprovalCallback(
      transport,
      { pendingId, action: "approve" },
      "user-tg-1",
      "chat-1",
    );

    expect(outcome.editText).toMatch(/non_fast_forward_at_approve_time/);
  });
});

describe("handlePipelineGateCallback", () => {
  const runId = "019d0000-0000-7000-8000-0000000000aa";
  const token = "0a1b2c3d";

  it("Approve resolves the gate with its token and says the approval was sent", async () => {
    const resolveGate = vi
      .fn()
      .mockResolvedValue(ok({ runId, pipelineName: "issue-to-pr", stageId: "approve" }));
    const transport = mockTransportDeep({ pipelines: { resolveGate } });

    const outcome = await handlePipelineGateCallback(
      transport,
      { runId, action: "approve", token },
      "tg-1",
    );

    expect(resolveGate).toHaveBeenCalledWith(runId, token, "approve", "tg-1");
    expect(outcome).toEqual({
      editText: '✅ Approval sent for checkpoint "approve" of pipeline "issue-to-pr".',
      toast: "Approved",
      clearKeyboard: true,
    });
  });

  it("Cancel resolves the gate as cancelled and says the cancellation was sent", async () => {
    const resolveGate = vi
      .fn()
      .mockResolvedValue(ok({ runId, pipelineName: "issue-to-pr", stageId: "approve" }));
    const transport = mockTransportDeep({ pipelines: { resolveGate } });

    const outcome = await handlePipelineGateCallback(
      transport,
      { runId, action: "cancel", token },
      "tg-1",
    );

    expect(resolveGate).toHaveBeenCalledWith(runId, token, "cancel", "tg-1");
    expect(outcome).toEqual({
      editText: '❌ Cancellation sent for checkpoint "approve" of pipeline "issue-to-pr".',
      toast: "Cancelling",
      clearKeyboard: true,
    });
  });

  it.each([
    [
      "waiting_gate",
      "This button is from an earlier checkpoint. Use the buttons on the latest one.",
    ],
    ["running", "This checkpoint was already decided, and the pipeline has moved on."],
    ["queued", "This checkpoint was already decided, and the pipeline has moved on."],
    ["waiting_event", "This checkpoint was already decided, and the pipeline has moved on."],
    ["completed", "This pipeline run has already finished."],
    ["cancelled", "This pipeline run was cancelled."],
    ["failed", "This pipeline run stopped after a failure."],
  ] as const)(
    "a tap on a checkpoint that isn't open, with the run %s, says why",
    async (status, text) => {
      const transport = mockTransportDeep({
        pipelines: {
          resolveGate: vi
            .fn()
            .mockResolvedValue(err({ code: "pipeline_gate_not_pending", runId, status })),
        },
      });

      const outcome = await handlePipelineGateCallback(
        transport,
        { runId, action: "approve", token },
        "tg-1",
      );

      expect(outcome.editText).toBe(text);
      expect(outcome.toast).toBe(text);
      // A checkpoint that isn't open can't be resolved from these buttons.
      expect(outcome.clearKeyboard).toBe(true);
    },
  );

  it.each([
    [{ code: "pipeline_run_not_found", runId: "019d0000-0000-7000-8000-0000000000aa" } as const],
    [{ code: "pipelines_disabled" } as const],
  ])("clears buttons that can never work (%o)", async (error) => {
    const transport = mockTransportDeep({
      pipelines: { resolveGate: vi.fn().mockResolvedValue(err(error)) },
    });

    const outcome = await handlePipelineGateCallback(
      transport,
      { runId: "019d0000-0000-7000-8000-0000000000aa", action: "approve", token: "0a1b2c3d" },
      "tg-1",
    );

    expect(outcome.clearKeyboard).toBe(true);
  });

  it("an unauthorized tapper gets the identity rejection", async () => {
    const transport = mockTransportDeep({
      pipelines: { resolveGate: vi.fn().mockResolvedValue(err({ code: "identity_rejected" })) },
    });

    const outcome = await handlePipelineGateCallback(
      transport,
      { runId, action: "cancel", token },
      "tg-9",
    );

    expect(outcome.editText).toBe("You're not authorized on this bot.");
    // A rejected tap must not take the buttons away from whoever can use them.
    expect(outcome.clearKeyboard).toBe(false);
  });
});
