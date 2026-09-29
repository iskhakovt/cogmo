import { logger } from "./logger.js";
import { finishesWithin } from "./util/finishes-within.js";

const log = logger.child({ component: "shutdown" });

/** What `cogmo serve` tears down on exit. */
export interface ServeResources {
  /** Ends open chat streams, then drains requests for up to `drainMs`. */
  web: { close(drainMs: number): Promise<void> };
  adapters: ReadonlyArray<{ stop(): Promise<void> }>;
  mcpRegistry: { stop(): Promise<void> };
  sandbox: { shutdown(): Promise<void> } | null;
  /** Marks this process's `cogmo_instances` row stopped; `null` without one. */
  closeInstance: (() => Promise<void>) | null;
}

export interface ShutdownBounds {
  /** How long in-flight web requests get before their connections are closed. */
  webDrainMs: number;
  /** Cap on every other step. */
  stepMs: number;
}

export const SERVE_SHUTDOWN_BOUNDS: ShutdownBounds = { webDrainMs: 3_000, stepMs: 5_000 };

/**
 * Tear down `cogmo serve`: the web server first, so no request reaches a
 * stopped dependency, then the channel adapters, MCP, the sandbox, and the
 * instance row. Each step is bounded; one that overruns or throws is logged
 * and the next still runs. Never rejects.
 */
export async function shutdownServe(
  resources: ServeResources,
  bounds: ShutdownBounds,
): Promise<void> {
  const { web, adapters, mcpRegistry, sandbox, closeInstance } = resources;
  await bounded("web server", bounds.webDrainMs + bounds.stepMs, () =>
    web.close(bounds.webDrainMs),
  );
  await Promise.all(
    adapters.map((adapter, index) =>
      bounded(`channel adapter ${index}`, bounds.stepMs, () => adapter.stop()),
    ),
  );
  await bounded("mcp", bounds.stepMs, () => mcpRegistry.stop());
  if (sandbox) await bounded("sandbox", bounds.stepMs, () => sandbox.shutdown());
  if (closeInstance) await bounded("sandbox instance", bounds.stepMs, closeInstance);
}

async function bounded(step: string, ms: number, run: () => Promise<void>): Promise<void> {
  try {
    if (!(await finishesWithin(Promise.try(run), ms))) {
      log.warn({ step, ms }, "shutdown step timed out; continuing");
    }
  } catch (err) {
    log.error({ err, step }, "shutdown step failed; continuing");
  }
}
