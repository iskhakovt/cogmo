/**
 * The Inngest baseline for `bench.spike.test.ts`: the same three paths on a
 * keyed `inngest start` (Postgres + Redis), over connect.
 * `INNGEST_BENCH=1 INNGEST_URL=… INNGEST_GATEWAY_URL=… INNGEST_EVENT_KEY=…
 * INNGEST_SIGNING_KEY=… pnpm exec vitest run --config
 * spike/temporal/vitest.config.ts inngest-bench`.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Inngest } from "inngest";
import { connect, type WorkerConnection } from "inngest/connect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.INNGEST_BENCH === "1";
const journal: Array<{ key: string; at: number }> = [];

let client: Inngest;
let connection: WorkerConnection | undefined;

function mark(key: string): number | undefined {
  return journal.find((e) => e.key === key)?.at;
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function stats(samples: number[]): { p50: number; p95: number; max: number; n: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { p50: pick(0.5), p95: pick(0.95), max: sorted.at(-1) ?? 0, n: sorted.length };
}

beforeAll(async () => {
  if (!enabled) return;
  client = new Inngest({
    id: `bench-${randomUUID()}`,
    isDev: false,
    baseUrl: process.env.INNGEST_URL ?? "",
    eventKey: process.env.INNGEST_EVENT_KEY ?? "",
    signingKey: process.env.INNGEST_SIGNING_KEY ?? "",
  });
  // The same shape as the Temporal turn: record, one zero-length iteration, record, emit.
  const turn = client.createFunction(
    {
      id: "bench-turn",
      triggers: [{ event: "bench/ready" }],
      concurrency: { limit: 1, key: "event.data.conversationId" },
    },
    async ({ event, step }) => {
      const id = String(event.data.triggerInboundId);
      await step.run("start", async () => {
        journal.push({ key: `turn-start:${id}`, at: Date.now() });
      });
      await step.run("iter-0", async () => {});
      await step.run("end", async () => {
        journal.push({ key: `turn-end:${id}`, at: Date.now() });
      });
      await step.sendEvent("response", {
        name: "bench/response",
        data: { conversationId: event.data.conversationId },
      });
    },
  );
  const router = client.createFunction(
    {
      id: "bench-router",
      triggers: [{ event: "bench/arrived" }],
      debounce: { period: "1s", key: "event.data.conversationId" },
    },
    async ({ event, step }) => {
      await step.sendEvent("ready", {
        name: "bench/ready",
        data: {
          conversationId: event.data.conversationId,
          triggerInboundId: event.data.inboundMessageId,
        },
      });
    },
  );
  connection = await connect({
    apps: [{ client, functions: [turn, router] }],
    ...(process.env.INNGEST_GATEWAY_URL !== undefined && {
      gatewayUrl: process.env.INNGEST_GATEWAY_URL,
    }),
  });
});

afterAll(async () => {
  await connection?.close();
});

describe.skipIf(!enabled)("inngest bench", () => {
  it("measures emit→turn start, concurrency-key hand-off and debounce overhead", async () => {
    const results: Record<string, unknown> = {};
    // Let the app sync before timing anything.
    const warm = randomUUID();
    await client.send({
      name: "bench/ready",
      data: { conversationId: warm, triggerInboundId: warm },
    });
    await until(() => mark(`turn-end:${warm}`) !== undefined, 30_000);

    const cold: number[] = [];
    for (let i = 0; i < 25; i++) {
      const conv = randomUUID();
      const sent = Date.now();
      await client.send({
        name: "bench/ready",
        data: { conversationId: conv, triggerInboundId: conv },
      });
      await until(() => mark(`turn-start:${conv}`) !== undefined, 10_000);
      cold.push((mark(`turn-start:${conv}`) ?? 0) - sent);
    }
    results.emitToTurnStartMs = stats(cold);

    const conv = randomUUID();
    const ids = Array.from({ length: 25 }, (_, i) => `${conv}-q${i}`);
    await client.send(
      ids.map((id) => ({
        name: "bench/ready",
        data: { conversationId: conv, triggerInboundId: id },
      })),
    );
    await until(() => ids.every((id) => mark(`turn-end:${id}`) !== undefined), 60_000);
    // Inngest does not promise FIFO within a key, so pair each start with the
    // latest end before it.
    const starts = ids.map((id) => mark(`turn-start:${id}`) ?? 0).sort((a, b) => a - b);
    const ends = ids.map((id) => mark(`turn-end:${id}`) ?? 0).sort((a, b) => a - b);
    results.laneHandoffMs = stats(starts.slice(1).map((start, i) => start - (ends[i] ?? 0)));

    const debounced: number[] = [];
    for (let i = 0; i < 15; i++) {
      const c = randomUUID();
      const sent = Date.now();
      await client.send({
        name: "bench/arrived",
        data: { conversationId: c, inboundMessageId: c },
      });
      await until(() => mark(`turn-start:${c}`) !== undefined, 15_000);
      debounced.push((mark(`turn-start:${c}`) ?? 0) - sent - 1_000);
    }
    results.debounceOverheadMs = stats(debounced);

    writeFileSync(
      process.env.BENCH_OUT ?? "/tmp/inngest-bench.json",
      JSON.stringify(results, null, 2),
    );
    expect(cold.length).toBe(25);
  });
});
