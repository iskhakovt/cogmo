import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ServeResources, type ShutdownBounds, shutdownServe } from "./shutdown.js";
import { expectDefined, resolvesWithin } from "./test/assertions.js";

const FAST: ShutdownBounds = { webDrainMs: 100, stepMs: 300 };

let webServer: Server | undefined;

afterEach(async () => {
  const server = webServer;
  webServer = undefined;
  if (!server?.listening) return;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
});

type Steps = Omit<ServeResources, "webShutdown" | "webServer">;

/**
 * Start a web server that holds every response open: `/stream` ends on the
 * shutdown signal, as the chat SSE route does; `/hang` never ends. The other
 * steps default to healthy stubs.
 */
async function serve(steps: Partial<Steps> = {}): Promise<{
  base: string;
  resources: ServeResources;
}> {
  const webShutdown = new AbortController();
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    if (req.url === "/stream") {
      webShutdown.signal.addEventListener("abort", () => res.end(), { once: true });
    }
  });
  webServer = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    resources: {
      webShutdown,
      webServer: server,
      adapters: [stoppable()],
      mcpRegistry: stoppable(),
      sandbox: { shutdown: vi.fn(async () => {}) },
      closeInstance: vi.fn(async () => {}),
      ...steps,
    },
  };
}

function stoppable() {
  return { stop: vi.fn(async () => {}) };
}

function never(): Promise<void> {
  return new Promise(() => {});
}

/** Read a response body to its end: `true` for a clean end, `false` for a reset. */
async function endsCleanly(res: Response): Promise<boolean> {
  const reader = expectDefined(res.body, "response body").getReader();
  try {
    while (!(await reader.read()).done);
    return true;
  } catch {
    return false;
  }
}

describe("shutdownServe", () => {
  it("ends open streams through the shutdown signal instead of waiting out the drain", async () => {
    const { base, resources } = await serve();
    const stream = await fetch(`${base}/stream`);

    await resolvesWithin(
      shutdownServe(resources, { webDrainMs: 10_000, stepMs: 20_000 }),
      2_000,
      "shutdown",
    );

    expect(await endsCleanly(stream)).toBe(true);
  });

  it("closes the connection of a request that outlives the drain", async () => {
    const closeInstance = vi.fn(async () => {});
    const { base, resources } = await serve({ closeInstance });
    const hung = await fetch(`${base}/hang`);

    await resolvesWithin(shutdownServe(resources, FAST), 2_000, "shutdown");

    expect(await endsCleanly(hung)).toBe(false);
    expect(closeInstance).toHaveBeenCalledTimes(1);
  });

  it("moves past a step that never settles", async () => {
    const healthy = stoppable();
    const sandbox = { shutdown: vi.fn(async () => {}) };
    const closeInstance = vi.fn(async () => {});
    const { resources } = await serve({
      adapters: [{ stop: never }, healthy],
      mcpRegistry: { stop: never },
      sandbox,
      closeInstance,
    });

    await resolvesWithin(shutdownServe(resources, FAST), 2_000, "shutdown");

    expect(healthy.stop).toHaveBeenCalledTimes(1);
    expect(sandbox.shutdown).toHaveBeenCalledTimes(1);
    expect(closeInstance).toHaveBeenCalledTimes(1);
  });

  it("moves past a step that throws", async () => {
    const closeInstance = vi.fn(async () => {});
    const { resources } = await serve({
      sandbox: { shutdown: vi.fn().mockRejectedValue(new Error("daemon gone")) },
      closeInstance,
    });

    await expect(shutdownServe(resources, FAST)).resolves.toBeUndefined();
    expect(closeInstance).toHaveBeenCalledTimes(1);
  });

  it("closes the web server before stopping what its requests use", async () => {
    const order: string[] = [];
    const record = (step: string) =>
      vi.fn(async () => {
        order.push(webServer?.listening ? `${step} (web listening)` : step);
      });
    const { resources } = await serve({
      adapters: [{ stop: record("adapter") }],
      mcpRegistry: { stop: record("mcp") },
      sandbox: { shutdown: record("sandbox") },
      closeInstance: record("instance"),
    });

    await shutdownServe(resources, FAST);

    expect(order).toEqual(["adapter", "mcp", "sandbox", "instance"]);
  });

  it("skips the sandbox steps when there is no sandbox", async () => {
    const adapter = stoppable();
    const { resources } = await serve({ adapters: [adapter], sandbox: null, closeInstance: null });

    await expect(shutdownServe(resources, FAST)).resolves.toBeUndefined();
    expect(adapter.stop).toHaveBeenCalledTimes(1);
  });
});
