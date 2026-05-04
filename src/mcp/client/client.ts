import { createInterface } from "node:readline";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../../logger.js";
import type { McpToolDescriptor } from "../config.js";

/**
 * The connection-shape the rest of the MCP module depends on. Decoupled
 * from the SDK so the pool / adapter / registry can be unit-tested with a
 * fake `McpConnection` (no subprocess required).
 */
export interface McpConnection {
  callTool(name: string, input: unknown, opts: { timeoutMs: number }): Promise<unknown>;
  listTools(): Promise<readonly McpToolDescriptor[]>;
  /** Subscribe to `tools/list_changed` notifications. Returns an unsubscribe fn. */
  onToolsChanged(cb: () => void): () => void;
  /** Subscribe to transport close. Returns an unsubscribe fn. */
  onClose(cb: () => void): () => void;
  close(): Promise<void>;
}

/**
 * SDK-backed implementation. Wraps an SDK `Client` + `Transport`, forwards
 * server stderr to the structured log, surfaces transport-close as a
 * subscribable event, and lets callers pass a per-call timeout straight
 * through to the SDK (which honours it natively via `RequestOptions.timeout`).
 */
export class SdkMcpConnection implements McpConnection {
  #client: Client;
  #transport: Transport;
  #closed = false;
  #closeListeners = new Set<() => void>();
  #toolsChangedListeners = new Set<() => void>();

  constructor(client: Client, transport: Transport) {
    this.#client = client;
    this.#transport = transport;
  }

  async connect(): Promise<void> {
    // Wire transport-close before connect — connect() can fail and close in
    // the same tick; we want the callback registered first. The handler is
    // the SINGLE place that flips `#closed` and notifies listeners — both
    // remote-initiated drops and our own `close()` flow through this path,
    // so subscribers get notified exactly once regardless of who closed.
    this.#transport.onclose = () => {
      if (this.#closed) return; // idempotency only — already fired
      this.#closed = true;
      for (const cb of this.#closeListeners) cb();
      this.#closeListeners.clear();
    };
    await this.#client.connect(this.#transport);

    this.#client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      for (const cb of this.#toolsChangedListeners) cb();
    });

    // Stdio transports expose `stderr` only when constructed with stderr: "pipe"
    // (which createTransport does). Forward whatever the server writes —
    // line-buffered via readline so multi-line tracebacks (common from Python
    // MCP servers) aren't fragmented across log entries by chunk boundaries.
    const stderr = (this.#transport as { stderr?: NodeJS.ReadableStream }).stderr;
    if (stderr) {
      const rl = createInterface({ input: stderr, crlfDelay: Infinity });
      rl.on("line", (line) => {
        if (line.length > 0) logger.warn({ mcpStderr: line }, "MCP server stderr");
      });
    }
  }

  async callTool(name: string, input: unknown, opts: { timeoutMs: number }): Promise<unknown> {
    if (this.#closed) throw new Error("MCP connection is closed");
    return this.#client.callTool(
      { name, arguments: (input ?? {}) as Record<string, unknown> },
      undefined,
      { timeout: opts.timeoutMs },
    );
  }

  async listTools(): Promise<readonly McpToolDescriptor[]> {
    if (this.#closed) throw new Error("MCP connection is closed");
    const result = await this.#client.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object" },
    }));
  }

  onToolsChanged(cb: () => void): () => void {
    this.#toolsChangedListeners.add(cb);
    return () => {
      this.#toolsChangedListeners.delete(cb);
    };
  }

  onClose(cb: () => void): () => void {
    if (this.#closed) {
      cb();
      return () => {};
    }
    this.#closeListeners.add(cb);
    return () => {
      this.#closeListeners.delete(cb);
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    // Don't pre-set #closed — let `client.close()` propagate to the
    // transport, whose `onclose` handler flips state and notifies listeners.
    // This keeps remote-initiated and explicit close paths symmetric.
    await this.#client.close();
    // Safety net: if the SDK transport didn't fire `onclose` for some reason
    // (different transport impl, edge condition), notify here. Idempotency
    // is guaranteed by the `if (this.#closed) return` guard inside the
    // handler — if the transport already fired, this is a no-op.
    if (!this.#closed) {
      this.#closed = true;
      for (const cb of this.#closeListeners) cb();
      this.#closeListeners.clear();
    }
  }
}
