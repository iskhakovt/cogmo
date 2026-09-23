import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import { expectDefined } from "../../test/assertions.js";
import { makeStepRun, recordingStepSendEvent } from "../../test/factories.js";
import type { DeliveryRouter } from "../../transport/delivery-router.js";
import type { TransportStore } from "../../transport/store/index.js";
import { runPipelineStage } from "./stage-runner.js";
import type { PipelineRunRow, PipelineRunStore, PipelineStore } from "./store/index.js";
import {
  linearPipelineDefinition,
  pipelineDefinitionRow,
  pipelineRunRow,
} from "./test-fixtures.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);
const stepRun = makeStepRun();

function makeDeps(run: PipelineRunRow = pipelineRunRow()) {
  const store = mock<PipelineStore>();
  store.getDefinition.mockResolvedValue(pipelineDefinitionRow());
  const runStore = mock<PipelineRunStore>();
  runStore.getRun.mockResolvedValue(run);
  runStore.transitionStatus.mockResolvedValue({ kind: "transitioned" });
  runStore.failRun.mockResolvedValue({ kind: "failed", conversationId: "conv-1" });
  const transportStore = mock<TransportStore>();
  transportStore.findInboundByPipelineStageKey.mockResolvedValue(undefined);
  transportStore.persistInbound.mockResolvedValue({ id: "inbound-1" });
  const deliveryRouter = mock<DeliveryRouter>();
  deliveryRouter.notifyConversation.mockResolvedValue(undefined);
  return {
    deps: { runInTx: fakeRunInTx, store, runStore, transportStore, deliveryRouter },
    store,
    runStore,
    transportStore,
    deliveryRouter,
  };
}

const AT_FIRST_STAGE = { runId: "run-1", stageId: "gather-context", iteration: 0 };

describe("runPipelineStage — agentic", () => {
  it("puts the stage into the conversation and hands the turn to handle-message", async () => {
    const { deps, transportStore } = makeDeps();
    const { sent, stepSendEvent } = recordingStepSendEvent();

    const result = await runPipelineStage(deps, AT_FIRST_STAGE, stepRun, stepSendEvent);

    expect(result).toEqual({ status: "dispatched", kind: "agentic", inboundId: "inbound-1" });
    expect(transportStore.persistInbound).toHaveBeenCalled();
    const emitted = expectDefined(sent[0], "inbound/arrived emission");
    expect(emitted.name).toBe("inbound/arrived");
    expect(emitted.data).toMatchObject({
      conversationId: "conv-1",
      inboundMessageId: "inbound-1",
    });
  });

  it("carries a revise note into the stage input", async () => {
    const { deps, transportStore } = makeDeps(pipelineRunRow({ iteration: 1 }));
    const { stepSendEvent } = recordingStepSendEvent();

    await runPipelineStage(
      deps,
      { ...AT_FIRST_STAGE, iteration: 1, note: "use staging" },
      stepRun,
      stepSendEvent,
    );

    const [, params] = expectDefined(
      transportStore.persistInbound.mock.calls[0],
      "persistInbound call",
    );
    expect(String(params.content)).toContain("use staging");
  });
});

describe("runPipelineStage — gate", () => {
  const AT_GATE = { runId: "run-1", stageId: "plan-gate", iteration: 0 };

  it("parks the run, delivers the prompt, and asks channels for a keyboard", async () => {
    const { deps, runStore, deliveryRouter } = makeDeps(
      pipelineRunRow({ currentStage: "plan-gate" }),
    );
    const { sent, stepSendEvent } = recordingStepSendEvent();

    const result = await runPipelineStage(deps, AT_GATE, stepRun, stepSendEvent);

    expect(result).toEqual({ status: "parked", kind: "gate" });
    expect(runStore.transitionStatus).toHaveBeenCalledWith(
      expect.anything(),
      "run-1",
      "running",
      "waiting_gate",
    );
    const [, prompt] = expectDefined(
      deliveryRouter.notifyConversation.mock.calls[0],
      "gate prompt delivery",
    );
    expect(prompt).toContain("/gate approve");
    const emitted = expectDefined(sent[0], "gate.requested emission");
    expect(emitted.name).toBe("pipeline/gate.requested");
    expect(emitted.id).toBe("pipeline-gate-requested-run-1:plan-gate:0");
  });

  it("treats an already-parked run as this step replaying, not a conflict", async () => {
    const { deps, runStore, deliveryRouter } = makeDeps(
      pipelineRunRow({ currentStage: "plan-gate", status: "waiting_gate" }),
    );
    runStore.transitionStatus.mockResolvedValue({ kind: "stale", status: "waiting_gate" });
    const { stepSendEvent } = recordingStepSendEvent();

    const result = await runPipelineStage(deps, AT_GATE, stepRun, stepSendEvent);

    expect(result).toEqual({ status: "parked", kind: "gate" });
    expect(deliveryRouter.notifyConversation).toHaveBeenCalled();
  });

  it("does not prompt when the run moved somewhere else entirely", async () => {
    const { deps, runStore, deliveryRouter } = makeDeps(
      pipelineRunRow({ currentStage: "plan-gate" }),
    );
    runStore.transitionStatus.mockResolvedValue({ kind: "stale", status: "waiting_event" });
    const { sent, stepSendEvent } = recordingStepSendEvent();

    const result = await runPipelineStage(deps, AT_GATE, stepRun, stepSendEvent);

    expect(result).toEqual({ status: "skipped", reason: "run_moved_before_gate" });
    expect(deliveryRouter.notifyConversation).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});

describe("runPipelineStage — cursor guard", () => {
  it("skips an event naming a stage the run has already left", async () => {
    const { deps, transportStore } = makeDeps(pipelineRunRow({ currentStage: "plan-gate" }));
    const { sent, stepSendEvent } = recordingStepSendEvent();

    const result = await runPipelineStage(deps, AT_FIRST_STAGE, stepRun, stepSendEvent);

    expect(result).toEqual({ status: "skipped", reason: "stale_cursor" });
    expect(transportStore.persistInbound).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("skips an event for an earlier pass through the current stage", async () => {
    const { deps, transportStore } = makeDeps(pipelineRunRow({ iteration: 2 }));
    const { stepSendEvent } = recordingStepSendEvent();

    const result = await runPipelineStage(deps, AT_FIRST_STAGE, stepRun, stepSendEvent);

    expect(result).toEqual({ status: "skipped", reason: "stale_cursor" });
    expect(transportStore.persistInbound).not.toHaveBeenCalled();
  });

  it("skips a run that has already terminated", async () => {
    const { deps, transportStore } = makeDeps(pipelineRunRow({ status: "cancelled" }));
    const { stepSendEvent } = recordingStepSendEvent();

    const result = await runPipelineStage(deps, AT_FIRST_STAGE, stepRun, stepSendEvent);

    expect(result).toEqual({ status: "skipped", reason: "stale_cursor" });
    expect(transportStore.persistInbound).not.toHaveBeenCalled();
  });

  it("skips when the run is gone", async () => {
    const { deps, runStore } = makeDeps();
    runStore.getRun.mockResolvedValue(undefined);
    const { stepSendEvent } = recordingStepSendEvent();

    const result = await runPipelineStage(deps, AT_FIRST_STAGE, stepRun, stepSendEvent);

    expect(result).toEqual({ status: "skipped", reason: "no_stage_context" });
  });
});

describe("runPipelineStage — wait", () => {
  it("fails the run loudly rather than skipping a stage the user declared", async () => {
    const compiled = linearPipelineDefinition();
    compiled.stages[2] = {
      id: "await-review",
      kind: "wait",
      wait: { event: "github/pr.review_submitted", timeout: "14d", onTimeout: { kind: "abort" } },
    };
    const { deps, store, runStore, deliveryRouter } = makeDeps(
      pipelineRunRow({ currentStage: "await-review" }),
    );
    store.getDefinition.mockResolvedValue(pipelineDefinitionRow({ compiled }));
    const { sent, stepSendEvent } = recordingStepSendEvent();

    const result = await runPipelineStage(
      deps,
      { runId: "run-1", stageId: "await-review", iteration: 0 },
      stepRun,
      stepSendEvent,
    );

    expect(result.status).toBe("failed");
    expect(runStore.failRun).toHaveBeenCalled();
    expect(deliveryRouter.notifyConversation).toHaveBeenCalled();
    const emitted = expectDefined(sent[0], "run.finished emission");
    expect(emitted.name).toBe("pipeline/run.finished");
    expect(emitted.data).toMatchObject({ status: "failed" });
  });

  it("stays quiet when the run was already terminal by the time it failed", async () => {
    const compiled = linearPipelineDefinition();
    compiled.stages[2] = {
      id: "await-review",
      kind: "wait",
      wait: { event: "github/pr.review_submitted", timeout: "14d", onTimeout: { kind: "abort" } },
    };
    const { deps, store, runStore, deliveryRouter } = makeDeps(
      pipelineRunRow({ currentStage: "await-review" }),
    );
    store.getDefinition.mockResolvedValue(pipelineDefinitionRow({ compiled }));
    runStore.failRun.mockResolvedValue({ kind: "already_terminal", status: "cancelled" });
    const { sent, stepSendEvent } = recordingStepSendEvent();

    await runPipelineStage(
      deps,
      { runId: "run-1", stageId: "await-review", iteration: 0 },
      stepRun,
      stepSendEvent,
    );

    expect(deliveryRouter.notifyConversation).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});

describe("runPipelineStage — step usage", () => {
  it("runs every side effect inside a durable step", async () => {
    const { deps } = makeDeps();
    const ids: string[] = [];
    const trackingStepRun = ((id: string, fn: () => Promise<unknown>) => {
      ids.push(id);
      return fn();
    }) as unknown as typeof stepRun;
    const { stepSendEvent } = recordingStepSendEvent();

    await runPipelineStage(deps, AT_FIRST_STAGE, trackingStepRun, stepSendEvent);

    expect(ids).toEqual(["load-pipeline-stage", "dispatch-stage-inbound"]);
  });
});

describe("runPipelineStage — logging", () => {
  it("does not throw when a stale event arrives for an unknown definition", async () => {
    const { deps, store } = makeDeps();
    store.getDefinition.mockResolvedValue(undefined);
    const { stepSendEvent } = recordingStepSendEvent();
    await expect(runPipelineStage(deps, AT_FIRST_STAGE, stepRun, stepSendEvent)).resolves.toEqual({
      status: "skipped",
      reason: "no_stage_context",
    });
    vi.restoreAllMocks();
  });
});
