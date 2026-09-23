import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import { expectDefined } from "../../test/assertions.js";
import type { TransportStore } from "../../transport/store/index.js";
import { dispatchStageInbound, stageInboundKey } from "./dispatch-stage-inbound.js";
import type { PipelineStageContext } from "./load-stage-context.js";
import { linearPipelineDefinition } from "./test-fixtures.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const definition = linearPipelineDefinition();
const stage = expectDefined(definition.stages[0], "first stage");

function context(overrides: Partial<PipelineStageContext> = {}): PipelineStageContext {
  return {
    runId: "run-1",
    conversationId: "conv-1",
    status: "running",
    userId: "user-1",
    pipelineName: "issue-to-pr",
    definitionVersion: 1,
    stage,
    stageId: stage.id,
    iteration: 0,
    stageIndex: 0,
    stageCount: 3,
    priorStageIds: [],
    nextStageId: "plan-gate",
    stageOutputs: {},
    ...overrides,
  };
}

function makeDeps() {
  const transportStore = mock<TransportStore>();
  transportStore.findInboundByPipelineStageKey.mockResolvedValue(undefined);
  transportStore.persistInbound.mockResolvedValue({ id: "inbound-1" });
  return { deps: { runInTx: fakeRunInTx, transportStore }, transportStore };
}

describe("dispatchStageInbound", () => {
  it("persists the stage's instructions as a pipeline-source inbound", async () => {
    const { deps, transportStore } = makeDeps();

    const result = await dispatchStageInbound(deps, { context: context() });

    expect(result).toEqual({ inboundId: "inbound-1" });
    const [, params] = expectDefined(
      transportStore.persistInbound.mock.calls[0],
      "persistInbound call",
    );
    expect(params).toMatchObject({
      source: "pipeline",
      pipelineStageKey: "run-1:gather-context:0",
      conversationId: "conv-1",
    });
    expect(String(params.content)).toContain("Chat with the user until you understand");
  });

  it("reuses the existing row on a replay instead of posting the stage twice", async () => {
    const { deps, transportStore } = makeDeps();
    transportStore.findInboundByPipelineStageKey.mockResolvedValue({
      id: "inbound-existing",
      conversationId: "conv-1",
    });

    const result = await dispatchStageInbound(deps, { context: context() });

    expect(result).toEqual({ inboundId: "inbound-existing" });
    expect(transportStore.persistInbound).not.toHaveBeenCalled();
  });

  it("keys a re-entry at a later iteration distinctly, so a revise re-posts", async () => {
    const { deps, transportStore } = makeDeps();

    await dispatchStageInbound(deps, {
      context: context({ iteration: 1 }),
      note: "use staging",
    });

    const [, params] = expectDefined(
      transportStore.persistInbound.mock.calls[0],
      "persistInbound call",
    );
    expect(params).toMatchObject({ pipelineStageKey: "run-1:gather-context:1" });
    expect(String(params.content)).toContain("use staging");
  });

  it("derives the key the same way callers do", () => {
    expect(stageInboundKey("run-1", "gather-context", 2)).toBe("run-1:gather-context:2");
  });
});
