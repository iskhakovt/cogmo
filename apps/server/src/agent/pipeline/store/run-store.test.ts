import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../../db/index.js";
import { createTestDatabase, truncateAll } from "../../../test/pglite.js";
import { DrizzleAgentStore } from "../../store/index.js";
import type { StageArtifact } from "../run-types.js";
import { validPipelineDefinition } from "../test-fixtures.js";
import { DrizzlePipelineRunStore, DrizzlePipelineStore } from "./index.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let runStore: DrizzlePipelineRunStore;
let defStore: DrizzlePipelineStore;
let agentStore: DrizzleAgentStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  runStore = new DrizzlePipelineRunStore();
  defStore = new DrizzlePipelineStore();
  agentStore = new DrizzleAgentStore();
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

/** Insert a user + definition and open a run on its first stage. */
async function seedRun(currentStage = "gather-context") {
  const userId = (await tx((trx) => agentStore.createUser(trx))).id;
  const def = await tx((trx) =>
    defStore.insertDefinition(trx, {
      userId,
      name: "issue-to-pr",
      sourceText: "on command, gather context, gate, implement",
      compiled: validPipelineDefinition(),
    }),
  );
  const conversationId = randomUUID();
  const run = await tx((trx) =>
    runStore.createRun(trx, { definitionId: def.id, conversationId, currentStage }),
  );
  return { userId, definitionId: def.id, conversationId, run };
}

const textArtifact: StageArtifact = { kind: "text", text: "gathered context" };

describe("DrizzlePipelineRunStore", () => {
  it("createRun opens a running run at iteration 0 with no outputs", async () => {
    const { run, conversationId, definitionId } = await seedRun();
    expect(run.status).toBe("running");
    expect(run.iteration).toBe(0);
    expect(run.stageOutputs).toEqual({});
    expect(run.currentStage).toBe("gather-context");
    expect(run.conversationId).toBe(conversationId);
    expect(run.definitionId).toBe(definitionId);
    expect(run.failureReason).toBeNull();
  });

  it("getRun round-trips stage outputs through jsonbZod", async () => {
    const { run } = await seedRun();
    await tx((trx) =>
      runStore.advanceStage(trx, {
        runId: run.id,
        fromStage: "gather-context",
        output: textArtifact,
        toStage: "plan-gate",
      }),
    );
    const fetched = await tx((trx) => runStore.getRun(trx, run.id));
    expect(fetched?.stageOutputs).toEqual({ "gather-context": textArtifact });
    expect(fetched?.currentStage).toBe("plan-gate");
  });

  describe("transitionStatus", () => {
    it("flips running → waiting_gate when the from-status matches", async () => {
      const { run } = await seedRun();
      const result = await tx((trx) =>
        runStore.transitionStatus(trx, run.id, "running", "waiting_gate"),
      );
      expect(result).toEqual({ kind: "transitioned" });
      expect((await tx((trx) => runStore.getRun(trx, run.id)))?.status).toBe("waiting_gate");
    });

    it("reports stale with the actual status on a mismatched from", async () => {
      const { run } = await seedRun();
      const result = await tx((trx) =>
        runStore.transitionStatus(trx, run.id, "waiting_gate", "running"),
      );
      expect(result).toEqual({ kind: "stale", status: "running" });
    });

    it("reports not_found for an unknown run", async () => {
      const result = await tx((trx) =>
        runStore.transitionStatus(trx, randomUUID(), "running", "waiting_gate"),
      );
      expect(result).toEqual({ kind: "not_found" });
    });
  });

  describe("advanceStage", () => {
    it("records the output, moves the cursor, and resets status to running", async () => {
      const { run } = await seedRun();
      await tx((trx) => runStore.transitionStatus(trx, run.id, "running", "waiting_gate"));
      const result = await tx((trx) =>
        runStore.advanceStage(trx, {
          runId: run.id,
          fromStage: "gather-context",
          output: textArtifact,
          toStage: "plan-gate",
        }),
      );
      expect(result).toEqual({ kind: "advanced" });
      const after = await tx((trx) => runStore.getRun(trx, run.id));
      expect(after?.currentStage).toBe("plan-gate");
      expect(after?.status).toBe("running");
      expect(after?.stageOutputs).toEqual({ "gather-context": textArtifact });
    });

    it("merges new outputs alongside prior ones", async () => {
      const { run } = await seedRun();
      await tx((trx) =>
        runStore.advanceStage(trx, {
          runId: run.id,
          fromStage: "gather-context",
          output: textArtifact,
          toStage: "plan-gate",
        }),
      );
      const second: StageArtifact = { kind: "json", value: { approved: true } };
      await tx((trx) =>
        runStore.advanceStage(trx, {
          runId: run.id,
          fromStage: "plan-gate",
          output: second,
          toStage: "implement",
        }),
      );
      const after = await tx((trx) => runStore.getRun(trx, run.id));
      expect(after?.stageOutputs).toEqual({
        "gather-context": textArtifact,
        "plan-gate": second,
      });
    });

    it("writes no output key when the stage declares none", async () => {
      const { run } = await seedRun();
      const result = await tx((trx) =>
        runStore.advanceStage(trx, {
          runId: run.id,
          fromStage: "gather-context",
          output: null,
          toStage: "plan-gate",
        }),
      );
      expect(result).toEqual({ kind: "advanced" });
      expect((await tx((trx) => runStore.getRun(trx, run.id)))?.stageOutputs).toEqual({});
    });

    it("is idempotent — a retry from an already-advanced stage is stale", async () => {
      const { run } = await seedRun();
      await tx((trx) =>
        runStore.advanceStage(trx, {
          runId: run.id,
          fromStage: "gather-context",
          output: textArtifact,
          toStage: "plan-gate",
        }),
      );
      const replay = await tx((trx) =>
        runStore.advanceStage(trx, {
          runId: run.id,
          fromStage: "gather-context",
          output: textArtifact,
          toStage: "plan-gate",
        }),
      );
      expect(replay).toEqual({ kind: "stale", currentStage: "plan-gate" });
    });

    it("reports not_found for an unknown run", async () => {
      const result = await tx((trx) =>
        runStore.advanceStage(trx, {
          runId: randomUUID(),
          fromStage: "gather-context",
          output: null,
          toStage: "plan-gate",
        }),
      );
      expect(result).toEqual({ kind: "not_found" });
    });
  });

  describe("completeRun", () => {
    it("records the final output and marks the run completed, cursor unchanged", async () => {
      const { run } = await seedRun("implement");
      const final: StageArtifact = { kind: "text", text: "done" };
      const result = await tx((trx) =>
        runStore.completeRun(trx, { runId: run.id, fromStage: "implement", output: final }),
      );
      expect(result).toEqual({ kind: "advanced" });
      const after = await tx((trx) => runStore.getRun(trx, run.id));
      expect(after?.status).toBe("completed");
      expect(after?.currentStage).toBe("implement");
      expect(after?.stageOutputs).toEqual({ implement: final });
    });

    it("is stale when the run already moved off the stage", async () => {
      const { run } = await seedRun("implement");
      const result = await tx((trx) =>
        runStore.completeRun(trx, { runId: run.id, fromStage: "gather-context", output: null }),
      );
      expect(result).toEqual({ kind: "stale", currentStage: "implement" });
    });
  });

  describe("failRun / cancelRunIfActive", () => {
    it("failRun terminates a non-terminal run with the reason and conversation", async () => {
      const { run, conversationId } = await seedRun();
      const result = await tx((trx) => runStore.failRun(trx, run.id, "stage threw"));
      expect(result).toEqual({ kind: "failed", conversationId });
      const after = await tx((trx) => runStore.getRun(trx, run.id));
      expect(after?.status).toBe("failed");
      expect(after?.failureReason).toBe("stage threw");
    });

    it("failRun is a no-op on an already-terminal run", async () => {
      const { run } = await seedRun();
      await tx((trx) => runStore.failRun(trx, run.id, "first"));
      const second = await tx((trx) => runStore.failRun(trx, run.id, "second"));
      expect(second).toEqual({ kind: "already_terminal", status: "failed" });
      expect((await tx((trx) => runStore.getRun(trx, run.id)))?.failureReason).toBe("first");
    });

    it("cancelRunIfActive cancels an active run and reports already_terminal otherwise", async () => {
      const { run, conversationId } = await seedRun();
      const first = await tx((trx) => runStore.cancelRunIfActive(trx, run.id, "user cancelled"));
      expect(first).toEqual({ kind: "cancelled", conversationId });
      expect((await tx((trx) => runStore.getRun(trx, run.id)))?.status).toBe("cancelled");

      const again = await tx((trx) => runStore.cancelRunIfActive(trx, run.id, "again"));
      expect(again).toEqual({ kind: "already_terminal", status: "cancelled" });
    });

    it("cancelRunIfActive reports not_found for an unknown run", async () => {
      const result = await tx((trx) => runStore.cancelRunIfActive(trx, randomUUID(), "x"));
      expect(result).toEqual({ kind: "not_found" });
    });
  });
});
