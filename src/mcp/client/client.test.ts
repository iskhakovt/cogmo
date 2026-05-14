import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it, vi } from "vitest";
import { SdkMcpConnection } from "./client.js";

/**
 * `SdkMcpConnection` is mostly an SDK passthrough — real-server behaviour is
 * covered by `mcp.integration.test.ts`. The unit tests here pin the wiring
 * we own: notification-handler dispatch and idempotent close-listener
 * notification through the `transport.onclose` path.
 */

interface FakeTransport extends Transport {
  triggerClose(): void;
}

function fakeTransport(): FakeTransport {
  const t: Partial<FakeTransport> = {
    start: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    close: vi.fn(async () => {
      t.onclose?.();
    }),
  };
  t.triggerClose = () => t.onclose?.();
  return t as FakeTransport;
}

interface FakeClientHandle extends Pick<Client, "connect" | "close"> {
  /** Fire the registered tools/list_changed handler from the test. */
  fireToolsChanged(): void;
}

function fakeClient(): FakeClientHandle {
  let toolsChangedHandler: (() => void | Promise<void>) | null = null;
  return {
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    setNotificationHandler: vi.fn((_schema: unknown, handler: () => void | Promise<void>) => {
      toolsChangedHandler = handler;
    }),
    fireToolsChanged: () => {
      if (toolsChangedHandler) toolsChangedHandler();
    },
  } as unknown as FakeClientHandle;
}

describe("SdkMcpConnection", () => {
  it("notifies onToolsChanged subscribers when the SDK emits tools/list_changed", async () => {
    const client = fakeClient();
    const transport = fakeTransport();
    const conn = new SdkMcpConnection(client as unknown as Client, transport);
    await conn.connect();

    const cb = vi.fn();
    conn.onToolsChanged(cb);
    client.fireToolsChanged();
    expect(cb).toHaveBeenCalledTimes(1);

    // Multiple subscribers each fire on the same event.
    const cb2 = vi.fn();
    conn.onToolsChanged(cb2);
    client.fireToolsChanged();
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops further notifications", async () => {
    const client = fakeClient();
    const transport = fakeTransport();
    const conn = new SdkMcpConnection(client as unknown as Client, transport);
    await conn.connect();

    const cb = vi.fn();
    const off = conn.onToolsChanged(cb);
    off();
    client.fireToolsChanged();
    expect(cb).not.toHaveBeenCalled();
  });

  it("fires onClose listeners exactly once when the transport closes remotely", async () => {
    const client = fakeClient();
    const transport = fakeTransport();
    const conn = new SdkMcpConnection(client as unknown as Client, transport);
    await conn.connect();

    const cb = vi.fn();
    conn.onClose(cb);
    transport.triggerClose();
    transport.triggerClose(); // idempotent — must not double-fire
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("close() routes through transport.onclose so listeners are notified", async () => {
    const client = fakeClient();
    const transport = fakeTransport();
    const conn = new SdkMcpConnection(client as unknown as Client, transport);
    await conn.connect();

    const cb = vi.fn();
    conn.onClose(cb);
    await conn.close();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("invokes onClose immediately if subscribed after the connection is already closed", async () => {
    const client = fakeClient();
    const transport = fakeTransport();
    const conn = new SdkMcpConnection(client as unknown as Client, transport);
    await conn.connect();
    transport.triggerClose();

    const cb = vi.fn();
    conn.onClose(cb);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("rejects callTool / listTools after close", async () => {
    const client = fakeClient();
    const transport = fakeTransport();
    const conn = new SdkMcpConnection(client as unknown as Client, transport);
    await conn.connect();
    await conn.close();
    await expect(conn.callTool("x", {}, { timeoutMs: 1000 })).rejects.toThrow(/closed/);
    await expect(conn.listTools()).rejects.toThrow(/closed/);
  });

  it("calls terminateSession() before close for streamable-http transports", async () => {
    const client = fakeClient();
    // Real instance so the `instanceof` check matches — we patch
    // `terminateSession` and `close` to capture invocation order without
    // standing up a live HTTP server.
    const httpTransport = new StreamableHTTPClientTransport(new URL("https://example.test/mcp"));
    const order: string[] = [];
    const terminateSession = vi
      .spyOn(httpTransport, "terminateSession")
      .mockImplementation(async () => {
        order.push("terminate");
      });
    const transportClose = vi.spyOn(httpTransport, "close").mockImplementation(async () => {
      order.push("close");
      httpTransport.onclose?.();
    });
    client.close = vi.fn(async () => {
      await httpTransport.close();
    }) as unknown as Client["close"];

    const conn = new SdkMcpConnection(
      client as unknown as Client,
      httpTransport as unknown as Transport,
    );
    await conn.connect();
    await conn.close();

    expect(terminateSession).toHaveBeenCalledOnce();
    expect(transportClose).toHaveBeenCalledOnce();
    expect(order).toEqual(["terminate", "close"]);
  });

  it("swallows terminateSession errors so close still completes", async () => {
    const client = fakeClient();
    const httpTransport = new StreamableHTTPClientTransport(new URL("https://example.test/mcp"));
    vi.spyOn(httpTransport, "terminateSession").mockRejectedValue(new Error("server gone"));
    vi.spyOn(httpTransport, "close").mockImplementation(async () => {
      httpTransport.onclose?.();
    });
    client.close = vi.fn(async () => {
      await httpTransport.close();
    }) as unknown as Client["close"];

    const conn = new SdkMcpConnection(
      client as unknown as Client,
      httpTransport as unknown as Transport,
    );
    await conn.connect();

    const cb = vi.fn();
    conn.onClose(cb);
    await expect(conn.close()).resolves.toBeUndefined();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
