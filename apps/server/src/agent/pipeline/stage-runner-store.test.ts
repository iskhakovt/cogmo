/**
 * The stage runner's `onFailure` wired to the real PGlite run store. The
 * mock-based tests in `stage-runner.test.ts` pin how the runner branches on
 * each `failRunAt` outcome; these pin what the run ends up as, through the
 * interface `main` had before `failRunAt` (the runner's `onFailure` over the
 * store), which is what lets them run red against `main`'s `failRun`: a run
 * that moved past the failed stage stays healthy, and a re-run after the
 * failure committed still tells the conversation.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { expectOk } from "../../test/assertions.js";
import { invokeInngestOnFailure } from "../../test/factories.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleAgentStore } from "../store/index.js";
import { createPipelineStageRunner } from "./stage-runner.js";
import { DrizzlePipelineRunStore, DrizzlePipelineStore } from "./store/index.js";
import { validPipelineDefinition } from "./test-fixtures.js";

type FailureCtx = {
  event: { data: { event: { data: { runId: string; stageId: string; iteration: number } } } };
  error: Error;
  step: { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> };
};

describe("createPipelineStageRunner onFailure against the run store", () => {
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

  /** A run sitting on `gather-context`, with the runner wired to the real store. */
  async function seeded() {
    const userId = (await tx((trx) => agentStore.createUser(trx))).id;
    const profile = await tx((trx) =>
      agentStore
        .createProfile(trx, { userId, name: "default", basePrompt: "p", model: "m", toolSet: [] })
        .then(expectOk),
    );
    const conversation = await tx((trx) =>
      agentStore.createConversation(trx, { userId, profileId: profile.id, isPrivate: true }),
    );
    const def = await tx((trx) =>
      defStore.insertDefinition(trx, {
        userId,
        name: "issue-to-pr",
        sourceText: "s",
        compiled: validPipelineDefinition(),
      }),
    );
    const run = await tx((trx) =>
      runStore.createRun(trx, {
        definitionId: def.id,
        conversationId: conversation.id,
        currentStage: "gather-context",
      }),
    );
    const notifyConversation = vi.fn().mockResolvedValue(undefined);
    const fn = createPipelineStageRunner({
      runInTx: tx,
      runStore,
      deliveryRouter: { notifyConversation },
      executeAgenticStage: vi.fn(),
    });
    const failFirstStage = () =>
      invokeInngestOnFailure<FailureCtx>(fn, {
        event: {
          data: { event: { data: { runId: run.id, stageId: "gather-context", iteration: 0 } } },
        },
        error: new TypeError("boom"),
        step: { run: (_id, body) => body() },
      });
    return { run, notifyConversation, failFirstStage };
  }

  it("onFailure leaves a run that has already advanced past the failed stage running", async () => {
    const { run, notifyConversation, failFirstStage } = await seeded();
    await tx((trx) =>
      runStore.advanceStage(trx, {
        runId: run.id,
        fromStage: "gather-context",
        output: null,
        toStage: "plan-gate",
      }),
    );

    await failFirstStage();

    expect(await tx((trx) => runStore.getRun(trx, run.id))).toMatchObject({
      status: "running",
      currentStage: "plan-gate",
      failureReason: null,
    });
    expect(notifyConversation).not.toHaveBeenCalled();
  });

  it("onFailure re-run after its own failure committed still tells the conversation", async () => {
    const { run, notifyConversation, failFirstStage } = await seeded();

    await failFirstStage();
    await failFirstStage();

    expect(notifyConversation).toHaveBeenCalledTimes(2);
    expect(await tx((trx) => runStore.getRun(trx, run.id))).toMatchObject({
      status: "failed",
      failureReason: "stage_error",
      failureDetail: "TypeError",
    });
  });
});
