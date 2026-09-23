import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import { type StartPipelineRunDeps, startPipelineRun } from "./start-run.js";
import type { PipelineRunStore, PipelineStore } from "./store/index.js";
import {
  linearPipelineDefinition,
  pipelineDefinitionRow,
  pipelineRunRow,
  validPipelineDefinition,
} from "./test-fixtures.js";
import type { PipelineDefinition } from "./types.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const ARGS = { userId: "user-1", conversationId: "conv-1", name: "issue-to-pr" };

/** `null` models "no active version" — distinct from "not supplied". */
function makeDeps(compiled: PipelineDefinition | null = linearPipelineDefinition()) {
  const store = mock<PipelineStore>();
  store.getActiveDefinitionByName.mockResolvedValue(
    compiled === null ? undefined : pipelineDefinitionRow({ compiled }),
  );
  const runStore = mock<PipelineRunStore>();
  runStore.findActiveRunByConversation.mockResolvedValue(undefined);
  runStore.createRun.mockResolvedValue(pipelineRunRow());
  const deps: StartPipelineRunDeps = { runInTx: fakeRunInTx, store, runStore };
  return { deps, store, runStore };
}

describe("startPipelineRun", () => {
  it("pins the active version and opens the run on the first stage", async () => {
    const { deps, runStore } = makeDeps();

    const result = await startPipelineRun(deps, ARGS);

    expect(result).toEqual({
      kind: "started",
      runId: "run-1",
      pipelineName: "issue-to-pr",
      version: 2,
      firstStageId: "gather-context",
      stageCount: 3,
    });
    expect(runStore.createRun).toHaveBeenCalledWith(expect.anything(), {
      definitionId: "def-1",
      conversationId: "conv-1",
      currentStage: "gather-context",
    });
  });

  it("refuses a pipeline that was defined but never activated", async () => {
    const { deps, runStore } = makeDeps(null);

    const result = await startPipelineRun(deps, ARGS);

    expect(result).toEqual({ kind: "no_active_version", name: "issue-to-pr" });
    expect(runStore.createRun).not.toHaveBeenCalled();
  });

  it("refuses a second run while one is live in the conversation", async () => {
    const { deps, store, runStore } = makeDeps();
    runStore.findActiveRunByConversation.mockResolvedValue(
      pipelineRunRow({ currentStage: "plan-gate" }),
    );

    const result = await startPipelineRun(deps, ARGS);

    expect(result).toEqual({
      kind: "run_already_active",
      runId: "run-1",
      currentStage: "plan-gate",
    });
    expect(runStore.createRun).not.toHaveBeenCalled();
    expect(store.getActiveDefinitionByName).toHaveBeenCalled();
  });

  it("refuses a definition with a loop rather than running it as a straight line", async () => {
    const { deps, runStore } = makeDeps(validPipelineDefinition());

    const result = await startPipelineRun(deps, ARGS);

    expect(result).toMatchObject({ kind: "unsupported_feature" });
    expect(result).toHaveProperty("detail", expect.stringContaining("loop"));
    expect(runStore.createRun).not.toHaveBeenCalled();
  });

  it("refuses a definition with a wait stage", async () => {
    const compiled = linearPipelineDefinition();
    compiled.stages[2] = {
      id: "await-review",
      kind: "wait",
      wait: {
        event: "github/pr.review_submitted",
        timeout: "14d",
        onTimeout: { kind: "abort" },
      },
    };
    const { deps, runStore } = makeDeps(compiled);

    const result = await startPipelineRun(deps, ARGS);

    expect(result).toMatchObject({ kind: "unsupported_feature" });
    expect(result).toHaveProperty("detail", expect.stringContaining("external event"));
    expect(runStore.createRun).not.toHaveBeenCalled();
  });

  it("refuses an artifact kind only a coding-delegation stage can produce", async () => {
    const compiled = linearPipelineDefinition();
    const first = compiled.stages[0];
    if (first) first.output = { kind: "plan" };
    const { deps, runStore } = makeDeps(compiled);

    const result = await startPipelineRun(deps, ARGS);

    expect(result).toMatchObject({ kind: "unsupported_feature" });
    expect(runStore.createRun).not.toHaveBeenCalled();
  });

  it("checks the definition before the conversation, so an unknown name says so", async () => {
    const { deps, runStore } = makeDeps(null);
    runStore.findActiveRunByConversation.mockResolvedValue(pipelineRunRow());

    const result = await startPipelineRun(deps, ARGS);

    expect(result).toEqual({ kind: "no_active_version", name: "issue-to-pr" });
  });
});
