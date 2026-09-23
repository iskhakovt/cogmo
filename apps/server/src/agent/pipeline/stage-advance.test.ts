import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import { expectDefined } from "../../test/assertions.js";
import { makeStepRun, recordingStepSendEvent } from "../../test/factories.js";
import type { DeliveryRouter } from "../../transport/delivery-router.js";
import type { StageArtifact } from "./run-types.js";
import { advancePipelineStage } from "./stage-advance.js";
import type { PipelineRunRow, PipelineRunStore, PipelineStore } from "./store/index.js";
import { pipelineDefinitionRow, pipelineRunRow } from "./test-fixtures.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);
const stepRun = makeStepRun();

const artifact: StageArtifact = { kind: "text", text: "the gathered context" };

function makeDeps(run: PipelineRunRow = pipelineRunRow()) {
  const store = mock<PipelineStore>();
  store.getDefinition.mockResolvedValue(pipelineDefinitionRow());
  const runStore = mock<PipelineRunStore>();
  runStore.getRun.mockResolvedValue(run);
  runStore.advanceStage.mockResolvedValue({ kind: "advanced" });
  runStore.completeRun.mockResolvedValue({ kind: "advanced" });
  const deliveryRouter = mock<DeliveryRouter>();
  deliveryRouter.notifyConversation.mockResolvedValue(undefined);
  return {
    deps: { runInTx: fakeRunInTx, store, runStore, deliveryRouter },
    runStore,
    deliveryRouter,
  };
}

const COMPLETED_FIRST = {
  runId: "run-1",
  stageId: "gather-context",
  iteration: 0,
  artifact,
};

describe("advancePipelineStage", () => {
  it("records the artifact and asks the runner for the next stage", async () => {
    const { deps, runStore } = makeDeps();
    const { sent, stepSendEvent } = recordingStepSendEvent();

    const result = await advancePipelineStage(deps, COMPLETED_FIRST, stepRun, stepSendEvent);

    expect(result).toEqual({ status: "advanced", toStage: "plan-gate" });
    expect(runStore.advanceStage).toHaveBeenCalledWith(expect.anything(), {
      runId: "run-1",
      fromStage: "gather-context",
      fromIteration: 0,
      output: artifact,
      toStage: "plan-gate",
      toIteration: 0,
    });
    const emitted = expectDefined(sent[0], "stage.due emission");
    expect(emitted.name).toBe("pipeline/stage.due");
    expect(emitted.id).toBe("pipeline-stage-due-run-1:plan-gate:0");
  });

  it("carries the run's pass number forward, so a revised run keys distinctly", async () => {
    const { deps, runStore } = makeDeps(pipelineRunRow({ iteration: 1 }));
    const { sent, stepSendEvent } = recordingStepSendEvent();

    await advancePipelineStage(deps, { ...COMPLETED_FIRST, iteration: 1 }, stepRun, stepSendEvent);

    expect(runStore.advanceStage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fromIteration: 1, toIteration: 1 }),
    );
    expect(expectDefined(sent[0], "stage.due emission").id).toBe(
      "pipeline-stage-due-run-1:plan-gate:1",
    );
  });

  it("completes the run on the last stage and tells the user", async () => {
    const { deps, runStore, deliveryRouter } = makeDeps(
      pipelineRunRow({ currentStage: "implement" }),
    );
    const { sent, stepSendEvent } = recordingStepSendEvent();

    const result = await advancePipelineStage(
      deps,
      { runId: "run-1", stageId: "implement", iteration: 0, artifact },
      stepRun,
      stepSendEvent,
    );

    expect(result).toEqual({ status: "completed" });
    expect(runStore.completeRun).toHaveBeenCalledWith(expect.anything(), {
      runId: "run-1",
      fromStage: "implement",
      fromIteration: 0,
      output: artifact,
    });
    expect(runStore.advanceStage).not.toHaveBeenCalled();
    const [, text] = expectDefined(
      deliveryRouter.notifyConversation.mock.calls[0],
      "completion notice",
    );
    expect(text).toContain("issue-to-pr");
    const emitted = expectDefined(sent[0], "run.finished emission");
    expect(emitted.name).toBe("pipeline/run.finished");
    expect(emitted.data).toMatchObject({ status: "completed" });
  });

  it("ignores a completion for a stage the run already left", async () => {
    const { deps, runStore } = makeDeps(pipelineRunRow({ currentStage: "plan-gate" }));
    const { sent, stepSendEvent } = recordingStepSendEvent();

    const result = await advancePipelineStage(deps, COMPLETED_FIRST, stepRun, stepSendEvent);

    expect(result).toEqual({ status: "skipped", reason: "stale_cursor" });
    expect(runStore.advanceStage).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("ignores a completion that lands after the run was cancelled", async () => {
    const { deps, runStore } = makeDeps(pipelineRunRow({ status: "cancelled" }));
    const { stepSendEvent } = recordingStepSendEvent();

    const result = await advancePipelineStage(deps, COMPLETED_FIRST, stepRun, stepSendEvent);

    expect(result).toEqual({ status: "skipped", reason: "stale_cursor" });
    expect(runStore.advanceStage).not.toHaveBeenCalled();
  });

  it("emits nothing when the store itself reports the move as stale", async () => {
    const { deps, runStore } = makeDeps();
    runStore.advanceStage.mockResolvedValue({
      kind: "stale",
      currentStage: "plan-gate",
      iteration: 0,
    });
    const { sent, stepSendEvent } = recordingStepSendEvent();

    const result = await advancePipelineStage(deps, COMPLETED_FIRST, stepRun, stepSendEvent);

    expect(result).toEqual({ status: "skipped", reason: "stale" });
    expect(sent).toHaveLength(0);
  });

  it("keeps the persist and the emit in separate steps", async () => {
    const { deps } = makeDeps();
    const ids: string[] = [];
    const trackingStepRun = ((id: string, fn: () => Promise<unknown>) => {
      ids.push(id);
      return fn();
    }) as unknown as typeof stepRun;
    const { stepSendEvent } = recordingStepSendEvent();

    await advancePipelineStage(deps, COMPLETED_FIRST, trackingStepRun, stepSendEvent);

    expect(ids).toEqual(["load-pipeline-stage", "persist-advance"]);
  });

  it("records a stage with no declared output as a null artifact", async () => {
    const { deps, runStore } = makeDeps();
    const { stepSendEvent } = recordingStepSendEvent();

    await advancePipelineStage(
      deps,
      { ...COMPLETED_FIRST, artifact: null },
      stepRun,
      stepSendEvent,
    );

    expect(runStore.advanceStage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ output: null }),
    );
  });
});
