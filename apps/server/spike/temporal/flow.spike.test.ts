/**
 * The spike's contract: the declarative layer reproduces cogmo's flow
 * control on a real Temporal server (the CLI's dev server, downloaded by
 * `@temporalio/testing`), and `scheduled-task-fire` runs its real use case
 * as an activity.
 */

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchScheduledFireDeps } from "../../src/agent/scheduling/dispatch-fire.js";
import { mockAgentStore, mockTransportStore } from "../../src/test/factories.js";
import { createFlowActivities, type FunctionFailure } from "./flow/activities.js";
import { createDispatcher, type Dispatcher } from "./flow/dispatcher.js";
import type { AnyFlowEvent, FlowEvent } from "./flow/types.js";
import {
  createSchedulingActivities,
  createTurnActivities,
  type JournalEntry,
} from "./functions/activities.js";
import { createFunctions, type SpikeConfig } from "./functions/definitions.js";

const TASK_QUEUE = "spike";
const config: SpikeConfig = {
  debounce: { periodMs: 300, timeoutMs: 1_200 },
  idleTimeoutMs: 800,
  turn: { iterations: 2, iterationMs: 100 },
};

const journal: JournalEntry[] = [];
const emitted: FlowEvent[] = [];
const failures: FunctionFailure[] = [];

/** Inbound rows the fake transport store has committed, by idempotency key. */
const inbounds = new Map<string, Array<{ id: string; conversationId: string }>>();
/** Attempts of `persistInbound` that commit and then lose the activity's ack. */
let crashesAfterCommit = 0;

const schedulingDeps: DispatchScheduledFireDeps = {
  runInTx: (cb) => cb({ __mockTx: true } as never),
  agentStore: mockAgentStore({
    findMostRecentConversationForUserProfile: vi.fn().mockResolvedValue(null),
    createConversation: vi.fn().mockImplementation(async () => ({ id: `conv-${randomUUID()}` })),
  }),
  transportStore: mockTransportStore({
    findReachableChannelsForUserProfile: vi
      .fn()
      .mockResolvedValue([{ channelId: "ch-1", platformAddress: "chat-1", receive: "all" }]),
    findInboundByIdempotencyKey: vi
      .fn()
      .mockImplementation(async (_tx, key: string) => inbounds.get(key)?.[0] ?? null),
    swapSession: vi.fn().mockResolvedValue({ session: { id: "session-1" }, closedIds: [] }),
    persistInbound: vi
      .fn()
      .mockImplementation(
        async (_tx, input: { idempotencyKey: string; conversationId: string }) => {
          const row = { id: `inbound-${randomUUID()}`, conversationId: input.conversationId };
          inbounds.set(input.idempotencyKey, [...(inbounds.get(input.idempotencyKey) ?? []), row]);
          if (crashesAfterCommit > 0) {
            crashesAfterCommit -= 1;
            throw new Error("worker lost the ack after commit");
          }
          return row;
        },
      ),
  }),
  idleTimeoutMs: 5 * 60_000,
};

let env: TestWorkflowEnvironment;
let worker: Worker;
let workerRun: Promise<void>;
let dispatcher: Dispatcher;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
  const inner = createDispatcher({
    client: env.client,
    taskQueue: TASK_QUEUE,
    functions: createFunctions(config),
  });
  dispatcher = {
    emit: async (events) => {
      emitted.push(...events);
      await inner.emit(events);
    },
    startRun: inner.startRun,
  };
  worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities: {
      ...createFlowActivities(dispatcher, (failure) => failures.push(failure)),
      ...createSchedulingActivities(schedulingDeps),
      ...createTurnActivities(journal),
    },
  });
  workerRun = worker.run();
});

afterAll(async () => {
  worker?.shutdown();
  await workerRun;
  await env?.teardown();
});

beforeEach(() => {
  journal.length = 0;
  emitted.length = 0;
  failures.length = 0;
});

async function until(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function arrived(conversationId: string, inboundMessageId: string): AnyFlowEvent {
  return {
    name: "inbound/arrived",
    id: `arrived:${inboundMessageId}`,
    data: { conversationId, inboundMessageId },
  };
}

function ready(conversationId: string, triggerInboundId: string): AnyFlowEvent {
  return {
    name: "inbound/ready",
    id: `ready:${triggerInboundId}`,
    data: { conversationId, triggerInboundId },
  };
}

function marks(conversationId: string): string[] {
  return journal
    .filter((entry) => entry.conversationId === conversationId)
    .map((entry) => entry.mark);
}

function at(conversationId: string, mark: string): number {
  const entry = journal.find((e) => e.conversationId === conversationId && e.mark === mark);
  if (entry === undefined) throw new Error(`no ${mark} for ${conversationId}`);
  return entry.at;
}

describe("debounce", () => {
  it("collapses a burst into one turn, triggered by the burst's last inbound", async () => {
    const conv = `conv-${randomUUID()}`;
    for (const n of [1, 2, 3, 4, 5]) {
      await dispatcher.emit([arrived(conv, `${conv}-m${n}`)]);
      await wait(50);
    }
    const lastAt = Date.now();
    await until(() => marks(conv).includes(`turn-end:${conv}-m5`), 10_000);
    await wait(500);

    expect(marks(conv).filter((m) => m.startsWith("turn-start"))).toEqual([
      `turn-start:${conv}-m5`,
    ]);
    const held = at(conv, `turn-start:${conv}-m5`) - lastAt;
    console.log(`debounce: period ${config.debounce.periodMs}ms, held the turn ${held}ms`);
    expect(held).toBeGreaterThanOrEqual(config.debounce.periodMs - 60);
  });

  it("fires at the ceiling during a steady stream, and loses no arrival", async () => {
    const conv = `conv-${randomUUID()}`;
    const startedAt = Date.now();
    let n = 0;
    while (Date.now() - startedAt < 3_000) {
      n += 1;
      await dispatcher.emit([arrived(conv, `${conv}-m${n}`)]);
      await wait(150);
    }
    await until(() => marks(conv).includes(`turn-end:${conv}-m${n}`), 10_000);

    const turns = marks(conv).filter((m) => m.startsWith("turn-start"));
    // A 3s stream with a 1.2s ceiling fires at least twice mid-stream, and the
    // stream's final inbound always gets a turn of its own.
    expect(turns.length).toBeGreaterThanOrEqual(3);
    expect(turns.at(-1)).toBe(`turn-start:${conv}-m${n}`);
  });
});

describe("conversation lane", () => {
  it("serializes a turn and a pipeline stage on one conversation, in arrival order", async () => {
    const conv = `conv-${randomUUID()}`;
    await dispatcher.emit([ready(conv, `${conv}-t1`)]);
    await dispatcher.emit([
      {
        name: "pipeline/stage.due",
        id: `stage:${conv}`,
        data: { runId: "run-1", stageId: "s1", iteration: 0, conversationId: conv },
      },
    ]);
    await dispatcher.emit([ready(conv, `${conv}-t2`)]);
    await until(() => marks(conv).includes(`turn-end:${conv}-t2`), 10_000);

    expect(marks(conv)).toEqual([
      `turn-start:${conv}-t1`,
      "iter-0",
      "iter-1",
      `turn-end:${conv}-t1`,
      "stage-start:s1",
      "iter-0",
      "stage-end:s1",
      `turn-start:${conv}-t2`,
      "iter-0",
      "iter-1",
      `turn-end:${conv}-t2`,
    ]);
  });

  it("runs turns of different conversations in parallel", async () => {
    const a = `conv-${randomUUID()}`;
    const b = `conv-${randomUUID()}`;
    await dispatcher.emit([ready(a, `${a}-t1`), ready(b, `${b}-t1`)]);
    await until(
      () => marks(a).includes(`turn-end:${a}-t1`) && marks(b).includes(`turn-end:${b}-t1`),
      10_000,
    );
    expect(at(b, `turn-start:${b}-t1`)).toBeLessThan(at(a, `turn-end:${a}-t1`));
  });

  it("runs a redelivered event once", async () => {
    const conv = `conv-${randomUUID()}`;
    await dispatcher.emit([ready(conv, `${conv}-t1`)]);
    await dispatcher.emit([ready(conv, `${conv}-t1`)]);
    await until(() => marks(conv).includes(`turn-end:${conv}-t1`), 10_000);
    await dispatcher.emit([ready(conv, `${conv}-t1`)]);
    await wait(800);
    expect(marks(conv).filter((m) => m.startsWith("turn-start"))).toHaveLength(1);
  });

  it("drops no job that lands while the lane is finishing", async () => {
    const conv = `conv-${randomUUID()}`;
    const rounds = 18;
    for (let round = 0; round < rounds; round++) {
      await dispatcher.emit([ready(conv, `${conv}-r${round}`)]);
      await until(() => marks(conv).includes(`turn-end:${conv}-r${round}`), 10_000);
      // The lane finishes shortly after a turn ends; land the next job before,
      // around and after that moment.
      await wait((round % 6) * 40);
    }
    await wait(500);
    expect(marks(conv).filter((m) => m.startsWith("turn-end"))).toHaveLength(rounds);
    let laneRuns = 0;
    for await (const _ of env.client.workflow.list({
      query: `WorkflowId = "lane:conversation-turn:${conv}"`,
    })) {
      laneRuns += 1;
    }
    // Some jobs landed on a running lane and some restarted a finished one.
    expect(laneRuns).toBeGreaterThan(1);
    expect(laneRuns).toBeLessThan(rounds);
  });

  it("reports a failed job and moves on to the next", async () => {
    const conv = `conv-${randomUUID()}`;
    await dispatcher.emit([ready(conv, "fail"), ready(conv, `${conv}-t2`)]);
    await until(() => marks(conv).includes(`turn-end:${conv}-t2`), 10_000);
    expect(failures.map((f) => f.functionId)).toEqual(["handle-message"]);
  });
});

describe("cancelOn", () => {
  it("emits conversation/idle once the idle window passes", async () => {
    const conv = `conv-${randomUUID()}`;
    await dispatcher.emit([
      {
        name: "response/ready",
        id: `resp:${conv}`,
        data: { conversationId: conv, messageId: "m" },
      },
    ]);
    await until(() => emitted.some((e) => e.name === "conversation/idle"), 10_000);
  });

  it("cancels the idle timer when the user writes again", async () => {
    const conv = `conv-${randomUUID()}`;
    await dispatcher.emit([
      {
        name: "response/ready",
        id: `resp:${conv}`,
        data: { conversationId: conv, messageId: "m" },
      },
    ]);
    await wait(200);
    await dispatcher.emit([arrived(conv, `${conv}-m1`)]);
    await until(() => marks(conv).includes(`turn-end:${conv}-m1`), 10_000);
    await wait(config.idleTimeoutMs);
    // The turn's own response/ready restarts the timer, which would also end the
    // first run, so the first run's status tells the two apart.
    const runs: Array<{ startedAt: number; status: string }> = [];
    for await (const run of env.client.workflow.list({
      query: `WorkflowId = "idle-timer:${conv}"`,
    })) {
      runs.push({ startedAt: run.startTime.getTime(), status: run.status.name });
    }
    const statuses = runs.sort((x, y) => x.startedAt - y.startedAt).map((run) => run.status);
    expect(statuses[0]).toBe("CANCELLED");
    const idles = emitted.filter((e) => e.name === "conversation/idle");
    expect(idles.map((e) => e.id)).not.toContain(`idle:resp:${conv}`);
  });
});

describe("scheduled-task-fire, ported", () => {
  it("runs the real use case as an activity and feeds the turn through debounce", async () => {
    const taskId = `task-${randomUUID()}`;
    const scheduledFor = "2026-11-22T09:00:00.000Z";
    crashesAfterCommit = 1;
    const fire: AnyFlowEvent = {
      name: "agent/scheduled-task.fire",
      id: `${taskId}:${scheduledFor}`,
      data: { taskId, userId: "user-1", profileId: "profile-1", scheduledFor, prompt: "briefing" },
    };
    await dispatcher.emit([fire]);
    await dispatcher.emit([fire]);

    const row = () => inbounds.get(`${taskId}:${scheduledFor}`)?.[0];
    await until(() => {
      const committed = row();
      return (
        committed !== undefined &&
        marks(committed.conversationId).some((m) => m.startsWith("turn-end"))
      );
    }, 15_000);
    const committed = row();
    if (committed === undefined) throw new Error("no inbound committed");

    expect(inbounds.get(`${taskId}:${scheduledFor}`)).toHaveLength(1);
    // The retry after the lost ack reused the committed row: one inbound, one
    // inbound/arrived (its id `fire:<inboundId>`), one turn.
    const arrivals = emitted.filter((e) => e.name === "inbound/arrived");
    expect(arrivals.map((e) => e.id)).toEqual([`fire:${committed.id}`]);
    expect(marks(committed.conversationId).filter((m) => m.startsWith("turn-start"))).toEqual([
      `turn-start:${committed.id}`,
    ]);
  });
});
