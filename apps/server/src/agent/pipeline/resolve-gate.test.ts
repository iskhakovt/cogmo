import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { pipelineGateKey } from "../../inngest/events.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleAgentStore } from "../store/index.js";
import { resolveGate } from "./resolve-gate.js";
import { DrizzlePipelineRunStore, DrizzlePipelineStore } from "./store/index.js";
import type { PipelineDefinition } from "./types.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const runStore = new DrizzlePipelineRunStore();
const defStore = new DrizzlePipelineStore();
const agentStore = new DrizzleAgentStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});
afterEach(async () => {
  await truncateAll(db);
});
afterAll(async () => {
  await close();
});

const DEFINITION: PipelineDefinition = {
  name: "plan-then-build",
  trigger: { kind: "command", phrase: "plan then build" },
  stages: [
    { id: "draft", kind: "agentic", instructions: "Draft a plan.", output: { kind: "text" } },
    {
      id: "approve",
      kind: "gate",
      instructions: "Approve the plan?",
      gate: { timeout: "1d", onTimeout: { kind: "abort" } },
    },
    { id: "build", kind: "agentic", instructions: "Build it." },
    {
      id: "sign-off",
      kind: "gate",
      instructions: "Happy with it?",
      gate: { timeout: "1d", onTimeout: { kind: "proceed" } },
    },
  ],
};

/** A run parked at `waiting_gate` on `stage`. */
async function parkedRun(stage: "approve" | "sign-off") {
  const userId = (await tx((trx) => agentStore.createUser(trx))).id;
  const profile = await tx((trx) =>
    agentStore.createProfile(trx, {
      userId,
      name: "default",
      basePrompt: "p",
      model: "test-model",
      toolSet: [],
    }),
  );
  const conversation = await tx((trx) =>
    agentStore.createConversation(trx, { userId, profileId: profile.id, isPrivate: true }),
  );
  const def = await tx((trx) =>
    defStore.insertDefinition(trx, {
      userId,
      name: DEFINITION.name,
      sourceText: "source",
      compiled: DEFINITION,
    }),
  );
  const run = await tx((trx) =>
    runStore.createRun(trx, {
      definitionId: def.id,
      conversationId: conversation.id,
      currentStage: stage,
    }),
  );
  await tx((trx) => runStore.transitionStatus(trx, run.id, "running", "waiting_gate"));
  return {
    runId: run.id,
    conversationId: conversation.id,
    gateKey: pipelineGateKey(run.id, stage, 0),
  };
}

const deps = () => ({ runInTx: tx, runStore });

describe("resolveGate", () => {
  it("approval advances a mid-pipeline gate to the next stage", async () => {
    const { runId, conversationId, gateKey } = await parkedRun("approve");

    const outcome = await resolveGate(deps(), { runId, gateKey, decision: "approved" });

    expect(outcome).toEqual({
      kind: "advanced",
      conversationId,
      pipelineName: "plan-then-build",
      nextStage: "build",
      iteration: 0,
    });
    expect(await tx((trx) => runStore.getRun(trx, runId))).toMatchObject({
      status: "running",
      currentStage: "build",
    });
  });

  it("a proceeding timeout on the final gate completes the run", async () => {
    const { runId, conversationId, gateKey } = await parkedRun("sign-off");

    const outcome = await resolveGate(deps(), { runId, gateKey, decision: "timeout_proceed" });

    expect(outcome).toEqual({ kind: "completed", conversationId, pipelineName: "plan-then-build" });
    expect(await tx((trx) => runStore.getRun(trx, runId))).toMatchObject({
      status: "completed",
      currentStage: "sign-off",
    });
  });

  it.each([
    ["cancelled", 'cancelled by the user at gate "approve"'],
    ["timeout_abort", 'gate "approve" timed out'],
  ] as const)("%s cancels the run with its reason", async (decision, reason) => {
    const { runId, conversationId, gateKey } = await parkedRun("approve");

    const outcome = await resolveGate(deps(), { runId, gateKey, decision });

    expect(outcome).toEqual({ kind: "cancelled", conversationId, pipelineName: "plan-then-build" });
    expect(await tx((trx) => runStore.getRun(trx, runId))).toMatchObject({
      status: "cancelled",
      failureReason: reason,
    });
  });

  it("the second of two racing resolutions is stale and changes nothing", async () => {
    const { runId, gateKey } = await parkedRun("approve");

    const first = await resolveGate(deps(), { runId, gateKey, decision: "approved" });
    const second = await resolveGate(deps(), { runId, gateKey, decision: "timeout_abort" });

    expect(first.kind).toBe("advanced");
    // The loser reports where the run actually is, so the caller can tell a
    // same-effect resolution from one that lost.
    expect(second).toEqual({
      kind: "stale",
      conversationId: expect.any(String),
      pipelineName: "plan-then-build",
      status: "running",
      currentStage: "build",
      iteration: 0,
      gateStage: "approve",
      nextStage: "build",
      pastGate: true,
    });
    // The late abort must not cancel the run the approval already advanced.
    expect(await tx((trx) => runStore.getRun(trx, runId))).toMatchObject({
      status: "running",
      currentStage: "build",
    });
  });

  it("a resolution naming a different gate than the run is parked on is stale", async () => {
    const { runId } = await parkedRun("sign-off");

    const outcome = await resolveGate(deps(), {
      runId,
      gateKey: pipelineGateKey(runId, "approve", 0),
      decision: "cancelled",
    });

    expect(outcome).toMatchObject({
      kind: "stale",
      status: "waiting_gate",
      currentStage: "sign-off",
      gateStage: "approve",
      pastGate: true,
    });
    expect((await tx((trx) => runStore.getRun(trx, runId)))?.status).toBe("waiting_gate");
  });

  it("a run that is not parked is stale", async () => {
    const { runId, gateKey } = await parkedRun("approve");
    await tx((trx) => runStore.transitionStatus(trx, runId, "waiting_gate", "running"));

    expect(await resolveGate(deps(), { runId, gateKey, decision: "approved" })).toMatchObject({
      kind: "stale",
      status: "running",
      currentStage: "approve",
      pastGate: false,
    });
  });

  it("a cancelled run reports it has not moved past the gate", async () => {
    const { runId, gateKey } = await parkedRun("approve");
    await resolveGate(deps(), { runId, gateKey, decision: "cancelled" });

    expect(await resolveGate(deps(), { runId, gateKey, decision: "approved" })).toMatchObject({
      kind: "stale",
      status: "cancelled",
      currentStage: "approve",
      pastGate: false,
    });
  });

  it("a completed run on its final gate reports it has moved past it", async () => {
    const { runId, gateKey } = await parkedRun("sign-off");
    await resolveGate(deps(), { runId, gateKey, decision: "approved" });

    expect(
      await resolveGate(deps(), { runId, gateKey, decision: "timeout_proceed" }),
    ).toMatchObject({ kind: "stale", status: "completed", nextStage: null, pastGate: true });
  });

  it("a run that failed on a later stage still counts as past the gate", async () => {
    const { runId, gateKey } = await parkedRun("approve");
    await resolveGate(deps(), { runId, gateKey, decision: "approved" });
    await tx((trx) => runStore.failRun(trx, runId, "build failed"));

    expect(await resolveGate(deps(), { runId, gateKey, decision: "approved" })).toMatchObject({
      kind: "stale",
      status: "failed",
      currentStage: "build",
      pastGate: true,
    });
  });

  it("an unknown run is not_found", async () => {
    const runId = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    expect(
      await resolveGate(deps(), {
        runId,
        gateKey: pipelineGateKey(runId, "approve", 0),
        decision: "approved",
      }),
    ).toEqual({ kind: "not_found" });
  });
});
