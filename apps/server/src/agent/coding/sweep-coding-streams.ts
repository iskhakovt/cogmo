import type { Inngest } from "inngest";
import type { Transactor } from "../../db/index.js";
import { logger } from "../../logger.js";
import { type CodingStore, isTerminalCodingTaskStatus } from "./store/index.js";
import type { CodingStreamingRegistry } from "./streaming-registry.js";

const log = logger.child({ component: "coding.sweep-coding-streams" });

export interface SweepCodingStreamsDeps {
  runInTx: Transactor;
  store: CodingStore;
  registry: Pick<CodingStreamingRegistry, "taskIds" | "sweep">;
}

export interface SweepCodingStreamsResult {
  held: number;
  ended: number;
  released: number;
}

/**
 * Report to the registry which of the tasks it holds have ended — a
 * terminal status, or no row — for the tasks whose stream no event ended.
 * See `CodingStreamingRegistry` for when a report releases one.
 */
export async function sweepCodingStreams(
  deps: SweepCodingStreamsDeps,
): Promise<SweepCodingStreamsResult> {
  const held = deps.registry.taskIds();
  if (held.length === 0) return { held: 0, ended: 0, released: 0 };
  const rows = await deps.runInTx((tx) => deps.store.getTasksByIds(tx, held));
  const live = new Set(
    rows.filter((row) => !isTerminalCodingTaskStatus(row.status)).map((row) => row.id),
  );
  const ended = new Set(held.filter((taskId) => !live.has(taskId)));
  const released = deps.registry.sweep(ended);
  if (released > 0) log.info({ released }, "released the streams of ended coding tasks");
  return { held: held.length, ended: ended.size, released };
}

/**
 * Every ten minutes, so a task that ended without its stream ending is
 * released within twenty. Runs in the process holding the registry, which
 * the single-node deployment guarantees.
 */
export function createCodingStreamSweep(deps: SweepCodingStreamsDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "coding-stream-sweep",
      // The next tick retries whatever a failed one missed.
      retries: 0,
      triggers: [{ cron: "*/10 * * * *" }],
    },
    async () => sweepCodingStreams(deps),
  );
}
