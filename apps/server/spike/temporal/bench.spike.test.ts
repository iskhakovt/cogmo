/**
 * Latency of the flow layer's plumbing: `BENCH=1 pnpm exec vitest run
 * --config spike/temporal/vitest.config.ts bench`. Points the worker at
 * `TEMPORAL_ADDRESS` when set, else at a local dev server, and writes its
 * numbers to `BENCH_OUT` (default /tmp/temporal-bench.json).
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { NativeConnection, Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFlowActivities } from "./flow/activities.js";
import { createDispatcher, type Dispatcher } from "./flow/dispatcher.js";
import type { AnyFlowEvent } from "./flow/types.js";
import {
  createSchedulingActivities,
  createTurnActivities,
  type JournalEntry,
} from "./functions/activities.js";
import { createFunctions } from "./functions/definitions.js";

const TASK_QUEUE = `bench-${randomUUID()}`;
const PERIOD_MS = 300;
const journal: JournalEntry[] = [];

let env: TestWorkflowEnvironment | null = null;
let client: Client;
let worker: Worker;
let workerRun: Promise<void>;
let dispatcher: Dispatcher;

beforeAll(async () => {
  if (!process.env.BENCH) return;
  const address = process.env.TEMPORAL_ADDRESS;
  let native: NativeConnection;
  if (address) {
    client = new Client({ connection: await Connection.connect({ address }) });
    native = await NativeConnection.connect({ address });
  } else {
    env = await TestWorkflowEnvironment.createLocal();
    client = env.client;
    native = env.nativeConnection;
  }
  dispatcher = createDispatcher({
    client,
    taskQueue: TASK_QUEUE,
    functions: createFunctions({
      debounce: { periodMs: PERIOD_MS, timeoutMs: null },
      idleTimeoutMs: 60_000,
      // Zero-length iterations: what remains is plumbing.
      turn: { iterations: 1, iterationMs: 0 },
    }),
  });
  // BENCH_WORKER_OPTS: JSON worker options to try, e.g. poller settings.
  const tried: unknown = JSON.parse(process.env.BENCH_WORKER_OPTS ?? "{}");
  worker = await Worker.create({
    ...(typeof tried === "object" && tried !== null ? tried : {}),
    connection: native,
    taskQueue: TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities: {
      ...createFlowActivities(dispatcher, () => {}),
      ...createSchedulingActivities({
        runInTx: () => Promise.reject(new Error("unused")),
        agentStore: {
          findMostRecentConversationForUserProfile: () => Promise.reject(new Error("unused")),
          createConversation: () => Promise.reject(new Error("unused")),
        },
        transportStore: {
          findReachableChannelsForUserProfile: () => Promise.reject(new Error("unused")),
          findInboundByIdempotencyKey: () => Promise.reject(new Error("unused")),
          swapSession: () => Promise.reject(new Error("unused")),
          persistInbound: () => Promise.reject(new Error("unused")),
        },
        idleTimeoutMs: 0,
      }),
      ...createTurnActivities(journal),
    },
  });
  workerRun = worker.run();
});

afterAll(async () => {
  if (!process.env.BENCH) return;
  worker.shutdown();
  await workerRun;
  await env?.teardown();
});

async function until(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function markAt(conversationId: string, mark: string): number | undefined {
  return journal.find((e) => e.conversationId === conversationId && e.mark === mark)?.at;
}

function stats(samples: number[]): { p50: number; p95: number; max: number; n: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { p50: pick(0.5), p95: pick(0.95), max: sorted.at(-1) ?? 0, n: sorted.length };
}

describe.skipIf(!process.env.BENCH)("bench", () => {
  it("measures emit→turn start, lane hand-off and debounce overhead", async () => {
    const results: Record<string, unknown> = {};

    // inbound/ready on an idle lane → the turn's first activity.
    const cold: number[] = [];
    for (let i = 0; i < 25; i++) {
      const conv = `conv-${randomUUID()}`;
      const event: AnyFlowEvent = {
        name: "inbound/ready",
        id: `ready:${conv}`,
        data: { conversationId: conv, triggerInboundId: conv },
      };
      const sent = Date.now();
      await dispatcher.emit([event]);
      await until(() => markAt(conv, `turn-start:${conv}`) !== undefined, 10_000);
      cold.push((markAt(conv, `turn-start:${conv}`) ?? 0) - sent);
    }
    results.emitToTurnStartMs = stats(cold);

    // Queued turns on one lane: previous turn's last activity → next turn's first.
    const conv = `conv-${randomUUID()}`;
    const ids = Array.from({ length: 25 }, (_, i) => `${conv}-q${i}`);
    await dispatcher.emit(
      ids.map((id) => ({
        name: "inbound/ready",
        id: `ready:${id}`,
        data: { conversationId: conv, triggerInboundId: id },
      })),
    );
    await until(() => markAt(conv, `turn-end:${ids.at(-1)}`) !== undefined, 60_000);
    const handoff = ids.slice(1).map((id, i) => {
      const prevEnd = markAt(conv, `turn-end:${ids[i]}`) ?? 0;
      return (markAt(conv, `turn-start:${id}`) ?? 0) - prevEnd;
    });
    results.laneHandoffMs = stats(handoff);

    // One hand-off, from the lane's and the child's histories: where the time goes.
    const lane = client.workflow.getHandle(`lane:conversation-turn:${conv}`);
    const laneHistory = await lane.fetchHistory();
    const childId = `handle-message:ready:${ids[1]}`;
    const childHistory = await client.workflow.getHandle(childId).fetchHistory();
    const toMs = (t: { seconds?: unknown; nanos?: number | null } | null | undefined) =>
      Number(t?.seconds ?? 0) * 1000 + Math.floor((t?.nanos ?? 0) / 1e6);
    const timeline = [
      ...(laneHistory.events ?? []).map((e) => ({
        at: toMs(e.eventTime),
        who: "lane",
        type: e.eventType,
      })),
      ...(childHistory.events ?? []).map((e) => ({
        at: toMs(e.eventTime),
        who: "child",
        type: e.eventType,
      })),
    ].sort((a, b) => a.at - b.at);
    const childStart = timeline.find((e) => e.who === "child")?.at ?? 0;
    const childEnd = timeline.filter((e) => e.who === "child").at(-1)?.at ?? 0;
    results.handoffTimeline = timeline
      .filter((e) => e.at >= childStart - 400 && e.at <= childEnd + 400)
      .map((e) => `${e.at - childStart}ms ${e.who} ${e.type}`);

    // A single arrival through debounce: arrival → turn start, less the period.
    const debounced: number[] = [];
    for (let i = 0; i < 15; i++) {
      const c = `conv-${randomUUID()}`;
      const sent = Date.now();
      await dispatcher.emit([
        {
          name: "inbound/arrived",
          id: `arrived:${c}`,
          data: { conversationId: c, inboundMessageId: c },
        },
      ]);
      await until(() => markAt(c, `turn-start:${c}`) !== undefined, 10_000);
      debounced.push((markAt(c, `turn-start:${c}`) ?? 0) - sent - PERIOD_MS);
    }
    results.debounceOverheadMs = stats(debounced);

    // Sequential zero-length steps inside one run: first step → last step.
    for (const local of [false, true]) {
      const perStep: number[] = [];
      for (let i = 0; i < 10; i++) {
        const id = `steps-${randomUUID()}`;
        await client.workflow.execute("stepsWorkflow", {
          workflowId: id,
          taskQueue: TASK_QUEUE,
          args: [{ id, steps: 11, local }],
        });
        perStep.push(((markAt(id, "step-10") ?? 0) - (markAt(id, "step-0") ?? 0)) / 10);
      }
      results[local ? "perLocalActivityMs" : "perActivityMs"] = stats(perStep);
    }

    writeFileSync(
      process.env.BENCH_OUT ?? "/tmp/temporal-bench.json",
      JSON.stringify(results, null, 2),
    );
    expect(cold.length).toBe(25);
  });
});
