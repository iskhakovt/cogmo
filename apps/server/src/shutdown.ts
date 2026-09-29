import type { Server } from "node:http";
import { logger } from "./logger.js";

const log = logger.child({ component: "shutdown" });

/** What `cogmo serve` tears down on exit. */
export interface ServeResources {
  /** The web server's `shutdownSignal` controller; aborting it ends open chat streams. */
  webShutdown: AbortController;
  webServer: Server;
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
  const { webShutdown, webServer, adapters, mcpRegistry, sandbox, closeInstance } = resources;
  await bounded("web server", bounds.webDrainMs + bounds.stepMs, () =>
    closeWebServer(webShutdown, webServer, bounds.webDrainMs),
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

/**
 * `close()` stops accepting and reaps idle keep-alive connections, but waits
 * on any with a response in flight. The abort ends the chat streams, which
 * never finish on their own; a request still open after `drainMs` has its
 * connection closed, calling `closeAllConnections()` after `close()` as
 * Node's docs recommend.
 */
async function closeWebServer(
  webShutdown: AbortController,
  server: Server,
  drainMs: number,
): Promise<void> {
  webShutdown.abort();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  if (await within(closed, drainMs)) return;
  log.warn({ drainMs }, "web requests outlived the drain; closing their connections");
  server.closeAllConnections();
  await closed;
}

async function bounded(step: string, ms: number, run: () => Promise<void>): Promise<void> {
  try {
    if (!(await within(Promise.try(run), ms))) {
      log.warn({ step, ms }, "shutdown step timed out; continuing");
    }
  } catch (err) {
    log.error({ err, step }, "shutdown step failed; continuing");
  }
}

/** `true` if `work` resolves within `ms`, `false` if not; a rejection propagates. */
async function within(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}
