import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import { expectDefined } from "../../test/assertions.js";
import { makeStepRun, recordingStepSendEvent } from "../../test/factories.js";
import type { DeliveryRouter } from "../../transport/delivery-router.js";
import { resolvePipelineGate } from "./gate-resolve.js";
import type { PipelineRunRow, PipelineRunStore, PipelineStore } from "./store/index.js";
import {
  linearPipelineDefinition,
  pipelineDefinitionRow,
  pipelineRunRow,
} from "./test-fixtures.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);
const stepRun = makeStepRun();

/** The run parked on the fixture's gate stage, which sits between two agentic stages. */
function parkedRun(overrides: Partial<PipelineRunRow> = {}): PipelineRunRow {
  return pipelineRunRow({ currentStage: "plan-gate", status: "waiting_gate", ...overrides });
}

function makeDeps(run: PipelineRunRow = parkedRun()) {
  const store = mock<PipelineStore>();
  store.getDefinition.mockResolvedValue(pipelineDefinitionRow());
  const runStore = mock<PipelineRunStore>();
  runStore.getRun.mockResolvedValue(run);
  runStore.advanceStage.mockResolvedValue({ kind: "advanced" });
  runStore.completeRun.mockResolvedValue({ kind: "advanced" });
  runStore.cancelRunIfActive.mockResolvedValue({ kind: "cancelled", conversationId: "conv-1" });
  const deliveryRouter = mock<DeliveryRouter>();
  deliveryRouter.notifyConversation.mockResolvedValue(undefined);
  return {
    deps: { runInTx: fakeRunInTx, store, runStore, deliveryRouter },
    store,
    runStore,
    deliveryRouter,
  };
}

const AT_GATE = { runId: "run-1", stageId: "plan-gate", iteration: 0 } as const;

describe("resolvePipelineGate — approve", () => {
  it("moves the run to the stage after the gate", async () => {
    const { deps, runStore } = makeDeps();
    const { sent, stepSendEvent } = recordingStepSendEvent();

    const result = await resolvePipelineGate(
      deps,
      { ...AT_GATE, decision: "approve" },
      stepRun,
      stepSendEvent,
    );

    expect(result).toEqual({ status: "approved", toStage: "implement" });
    expect(runStore.advanceStage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fromStage: "plan-gate", toStage: "implement", output: null }),
    );
    expect(expectDefined(sent[0], "stage.due emission").name).toBe("pipeline/stage.due");
  });

  it("completes the run when the gate is the last stage", async () => {
    const compiled = linearPipelineDefinition();
    compiled.stages = compiled.stages.slice(0, 2);
    const { deps, store, runStore, deliveryRouter } = makeDeps();
    store.getDefinition.mockResolvedValue(pipelineDefinitionRow({ compiled }));
    const { sent, stepSendEvent } = recordingStepSendEvent();

    const result = await resolvePipelineGate(
      deps,
      { ...AT_GATE, decision: "approve" },
      stepRun,
      stepSendEvent,
    );

    expect(result).toEqual({ status: "completed" });
    expect(runStore.completeRun).toHaveBeenCalled();
    expect(deliveryRouter.notifyConversation).toHaveBeenCalled();
    expect(expectDefined(sent[0], "run.finished emission").data).toMatchObject({
      status: "completed",
    });
  });
});

describe("resolvePipelineGate — revise", () => {
  it("sends the run back one stage at the next iteration, carrying the feedback", async () => {
    const { deps, runStore } = makeDeps();
    const { sent, stepSendEvent } = recordingStepSendEvent();

    const result = await resolvePipelineGate(
      deps,
      { ...AT_GATE, decision: "revise", feedback: "use staging, not prod" },
      stepRun,
      stepSendEvent,
    );

    expect(result).toEqual({ status: "revising", toStage: "gather-context" });
    expect(runStore.advanceStage).toHaveBeenCalledWith(expect.anything(), {
      runId: "run-1",
      fromStage: "plan-gate",
      fromIteration: 0,
      output: null,
      toStage: "gather-context",
      toIteration: 1,
    });
    const emitted = expectDefined(sent[0], "stage.due emission");
    expect(emitted.data).toMatchObject({
      stageId: "gather-context",
      iteration: 1,
      note: "use staging, not prod",
    });
    expect(emitted.id).toBe("pipeline-stage-due-run-1:gather-context:1");
  });

  it("omits the note when the user tapped the button instead of typing feedback", async () => {
    const { deps } = makeDeps();
    const { sent, stepSendEvent } = recordingStepSendEvent();

    await resolvePipelineGate(deps, { ...AT_GATE, decision: "revise" }, stepRun, stepSendEvent);

    expect(expectDefined(sent[0], "stage.due emission").data).not.toHaveProperty("note");
  });

  it("leaves a first-stage gate parked, since there is nothing to send back to", async () => {
    const compiled = linearPipelineDefinition();
    compiled.stages = compiled.stages.slice(1);
    const { deps, store, runStore, deliveryRouter } = makeDeps();
    store.getDefinition.mockResolvedValue(pipelineDefinitionRow({ compiled }));
    const { sent, stepSendEvent } = recordingStepSendEvent();

    const result = await resolvePipelineGate(
      deps,
      { ...AT_GATE, decision: "revise" },
      stepRun,
      stepSendEvent,
    );

    expect(result).toEqual({ status: "skipped", reason: "no_stage_to_revise" });
    expect(runStore.advanceStage).not.toHaveBeenCalled();
    expect(deliveryRouter.notifyConversation).toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});

describe("resolvePipelineGate — cancel", () => {
  it("terminates the run and says so", async () => {
    const { deps, runStore, deliveryRouter } = makeDeps();
    const { sent, stepSendEvent } = recordingStepSendEvent();

    const result = await resolvePipelineGate(
      deps,
      { ...AT_GATE, decision: "cancel" },
      stepRun,
      stepSendEvent,
    );

    expect(result).toEqual({ status: "cancelled" });
    expect(runStore.cancelRunIfActive).toHaveBeenCalled();
    const [, text] = expectDefined(
      deliveryRouter.notifyConversation.mock.calls[0],
      "cancellation notice",
    );
    expect(text).toContain("cancelled");
    expect(expectDefined(sent[0], "run.finished emission").data).toMatchObject({
      status: "cancelled",
    });
  });

  it("stays quiet when the run was already terminal", async () => {
    const { deps, runStore, deliveryRouter } = makeDeps();
    runStore.cancelRunIfActive.mockResolvedValue({ kind: "already_terminal", status: "failed" });
    const { sent, stepSendEvent } = recordingStepSendEvent();

    const result = await resolvePipelineGate(
      deps,
      { ...AT_GATE, decision: "cancel" },
      stepRun,
      stepSendEvent,
    );

    expect(result).toEqual({ status: "skipped", reason: "already_terminal" });
    expect(deliveryRouter.notifyConversation).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});

describe("resolvePipelineGate — cursor guard", () => {
  it("ignores a decision for a gate the run already passed", async () => {
    const { deps, runStore } = makeDeps(pipelineRunRow({ currentStage: "implement" }));
    const { stepSendEvent } = recordingStepSendEvent();

    const result = await resolvePipelineGate(
      deps,
      { ...AT_GATE, decision: "approve" },
      stepRun,
      stepSendEvent,
    );

    expect(result).toEqual({ status: "skipped", reason: "stale_cursor" });
    expect(runStore.advanceStage).not.toHaveBeenCalled();
  });

  it("ignores a decision for a run that is not parked on a gate", async () => {
    const { deps, runStore } = makeDeps(parkedRun({ status: "running" }));
    const { stepSendEvent } = recordingStepSendEvent();

    const result = await resolvePipelineGate(
      deps,
      { ...AT_GATE, decision: "approve" },
      stepRun,
      stepSendEvent,
    );

    expect(result).toEqual({ status: "skipped", reason: "stale_cursor" });
    expect(runStore.advanceStage).not.toHaveBeenCalled();
  });

  it("ignores a second decision on a gate resolved at an earlier iteration", async () => {
    const { deps, runStore } = makeDeps(parkedRun({ iteration: 1 }));
    const { stepSendEvent } = recordingStepSendEvent();

    const result = await resolvePipelineGate(
      deps,
      { ...AT_GATE, decision: "cancel" },
      stepRun,
      stepSendEvent,
    );

    expect(result).toEqual({ status: "skipped", reason: "stale_cursor" });
    expect(runStore.cancelRunIfActive).not.toHaveBeenCalled();
  });

  it("ignores a decision for a run that no longer exists", async () => {
    const { deps, runStore } = makeDeps();
    runStore.getRun.mockResolvedValue(undefined);
    const { stepSendEvent } = recordingStepSendEvent();

    const result = await resolvePipelineGate(
      deps,
      { ...AT_GATE, decision: "approve" },
      stepRun,
      stepSendEvent,
    );

    expect(result).toEqual({ status: "skipped", reason: "no_stage_context" });
  });
});
