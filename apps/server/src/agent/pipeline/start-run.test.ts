import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import type { TransportStore } from "../../transport/store/index.js";
import type { AgentStore } from "../store/index.js";
import { type StartPipelineRunDeps, startPipelineRun } from "./start-run.js";
import type {
  PipelineDefinitionRow,
  PipelineRunRow,
  PipelineRunStore,
  PipelineStore,
} from "./store/index.js";
import { validPipelineDefinition } from "./test-fixtures.js";
import type { PipelineDefinition } from "./types.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const ARGS = {
  userId: "user-1",
  profileId: "profile-1",
  name: "issue-to-pr",
  idempotencyKey: "k1",
};

/** The fixture minus its loop — a definition slice 2 can run. */
function linearDefinition(): PipelineDefinition {
  const def = validPipelineDefinition();
  return { ...def, stages: def.stages.map(({ loop: _loop, ...stage }) => stage) };
}

function definitionRow(compiled: PipelineDefinition = linearDefinition()): PipelineDefinitionRow {
  return {
    id: "def-1",
    userId: "user-1",
    name: "issue-to-pr",
    version: 2,
    sourceText: "source",
    compiled,
    active: true,
    createdAt: new Date("2026-09-12T00:00:00Z"),
  };
}

function runRow(overrides: Partial<PipelineRunRow> = {}): PipelineRunRow {
  return {
    id: "run-1",
    definitionId: "def-1",
    conversationId: "conv-new",
    status: "running",
    currentStage: "gather-context",
    iteration: 0,
    stageOutputs: {},
    failureReason: null,
    idempotencyKey: "k1",
    createdAt: new Date("2026-09-12T00:00:00Z"),
    ...overrides,
  };
}

function makeDeps() {
  const pipelineStore = mock<PipelineStore>();
  const runStore = mock<PipelineRunStore>();
  const agentStore = mock<AgentStore>();
  const transportStore = mock<TransportStore>();
  const send = vi.fn().mockResolvedValue({ ids: ["evt"] });

  pipelineStore.getActiveDefinition.mockResolvedValue(definitionRow());
  runStore.getRunByIdempotencyKey.mockResolvedValue(undefined);
  runStore.insertOrRecoverRun.mockResolvedValue({ kind: "new", row: runRow() });
  agentStore.createConversation.mockResolvedValue({ id: "conv-new" });
  transportStore.findReachableChannelsForUserProfile.mockResolvedValue([
    { channelId: "tg", platformAddress: "42", receive: "routed" },
  ]);

  const deps: StartPipelineRunDeps = {
    runInTx: fakeRunInTx,
    pipelineStore,
    runStore,
    agentStore,
    transportStore,
    inngest: { send },
  };
  return { deps, pipelineStore, runStore, agentStore, transportStore, send };
}

describe("startPipelineRun", () => {
  it("opens the run on a fresh conversation, routes sessions to it, and schedules stage one", async () => {
    const { deps, runStore, agentStore, transportStore, send } = makeDeps();

    const result = await startPipelineRun(deps, ARGS);

    expect(result._unsafeUnwrap()).toEqual({
      runId: "run-1",
      conversationId: "conv-new",
      name: "issue-to-pr",
      version: 2,
      firstStage: "gather-context",
      recovered: false,
    });
    expect(agentStore.createConversation).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      profileId: "profile-1",
      isPrivate: true,
    });
    expect(transportStore.swapSession).toHaveBeenCalledWith(expect.anything(), "tg", "42", {
      conversationId: "conv-new",
      status: "active",
      receive: "routed",
    });
    expect(runStore.insertOrRecoverRun).toHaveBeenCalledWith(expect.anything(), {
      definitionId: "def-1",
      conversationId: "conv-new",
      currentStage: "gather-context",
      idempotencyKey: "k1",
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "pipeline/stage.due",
        data: { runId: "run-1", stageId: "gather-context", iteration: 0 },
        id: "pipeline-stage-due-run-1-gather-context-0",
      }),
    );
  });

  it("recovers a retried call without creating a second conversation, and re-sends the stage", async () => {
    const { deps, runStore, agentStore, transportStore, send } = makeDeps();
    runStore.getRunByIdempotencyKey.mockResolvedValue(
      runRow({ conversationId: "conv-original", currentStage: "plan-gate" }),
    );

    const result = await startPipelineRun(deps, ARGS);

    expect(result._unsafeUnwrap()).toMatchObject({
      runId: "run-1",
      conversationId: "conv-original",
      firstStage: "gather-context",
      recovered: true,
    });
    expect(agentStore.createConversation).not.toHaveBeenCalled();
    expect(transportStore.swapSession).not.toHaveBeenCalled();
    expect(runStore.insertOrRecoverRun).not.toHaveBeenCalled();
    // Same dedup id as the first attempt's send — a no-op at the bus if it
    // already landed, and the stage runner skips it if the run moved on.
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pipeline-stage-due-run-1-gather-context-0" }),
    );
  });

  it("refuses a pipeline with no active version", async () => {
    const { deps, pipelineStore, send } = makeDeps();
    pipelineStore.getActiveDefinition.mockResolvedValue(undefined);

    const result = await startPipelineRun(deps, ARGS);

    expect(result._unsafeUnwrapErr()).toEqual({ kind: "not_active", name: "issue-to-pr" });
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a definition using features the engine can't run yet, before touching sessions", async () => {
    const { deps, pipelineStore, agentStore, send } = makeDeps();
    pipelineStore.getActiveDefinition.mockResolvedValue(definitionRow(validPipelineDefinition()));

    const result = await startPipelineRun(deps, ARGS);

    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "unsupported_features",
      name: "issue-to-pr",
      features: ['loop on stage "implement"'],
    });
    expect(agentStore.createConversation).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses when the user has no channel the run could reach them on", async () => {
    const { deps, transportStore, agentStore, send } = makeDeps();
    transportStore.findReachableChannelsForUserProfile.mockResolvedValue([]);

    const result = await startPipelineRun(deps, ARGS);

    expect(result._unsafeUnwrapErr()).toEqual({ kind: "no_reachable_channel" });
    expect(agentStore.createConversation).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("propagates a failed send so the durable tool step retries into recovery", async () => {
    const { deps, send } = makeDeps();
    send.mockRejectedValue(new Error("bus down"));

    await expect(startPipelineRun(deps, ARGS)).rejects.toThrow("bus down");
  });
});
