/**
 * `Transport.mcp.*` — admin surface for MCP servers, used by the `/mcp`
 * command in the Telegram adapter and (in principle) any other channel.
 * Identity gating, error mapping (Zod parse, UniqueViolationError,
 * McpInvalidServerNameError, McpServerNotFoundError, mcp_tool_not_found),
 * and the `mcp_disabled` short-circuit are the meaningful contracts. The
 * `McpRegistry` is mocked because the test is about the transport-layer
 * branches, not the registry's own behaviour (covered in `mcp/registry.test.ts`).
 */

import type { Inngest } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { UniqueViolationError } from "../agent/store/errors.js";
import type { AgentStore } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import { inboundArrived } from "../inngest/events.js";
import type { McpServer, McpServerConfig, McpServerStatus } from "../mcp/config.js";
import { McpInvalidServerNameError, McpServerNotFoundError } from "../mcp/errors.js";
import type { McpRegistry } from "../mcp/registry.js";
import { mockAgentStore, mockTransportStore } from "../test/factories.js";
import type { AttachmentStore } from "./attachment-store.js";
import type { TransportStore } from "./store/index.js";
import { createTransport } from "./transport.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const KNOWN_HANDLE = "tg-987";
const UNKNOWN_HANDLE = "tg-impostor";
const USER_ID = "019d0000-0000-7000-8000-000000000001";

function makeTransportStore(): TransportStore {
  const ts = mockTransportStore();
  vi.mocked(ts.resolveUser).mockImplementation(async (_tx, _channelId, handle) =>
    handle === KNOWN_HANDLE ? { userId: USER_ID } : undefined,
  );
  return ts;
}

function makeTransport(opts: {
  registry?: McpRegistry;
  agentStore?: AgentStore;
  transportStore?: TransportStore;
}) {
  const { registry } = opts;
  const inngest = mock<Inngest>();
  inngest.send.mockResolvedValue({ ids: [] });
  return createTransport({
    channelId: "ch-1",
    defaultUserId: USER_ID,
    defaultProfileId: "019d0000-0000-7000-8000-000000000099",
    runInTx: fakeRunInTx,
    transportStore: opts.transportStore ?? makeTransportStore(),
    agentStore: opts.agentStore ?? mockAgentStore(),
    ...(registry !== undefined && { mcpRegistry: registry }),
    inngest,
    inboundArrived,
    attachments: mock<AttachmentStore>(),
    idleTimeoutMs: 60_000,
  });
}

const VALID_STDIO_CONFIG: McpServerConfig = {
  transport: "stdio",
  command: "node",
  args: ["server.js"],
  env: {},
};

function makeMcpServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: "019d0000-0000-7000-8000-000000000050",
    name: "github",
    config: VALID_STDIO_CONFIG,
    enabled: true,
    approvalStatus: "pending",
    lastConnectedAt: null,
    lastError: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    ...overrides,
  };
}

function makeMcpServerStatus(overrides: Partial<McpServerStatus> = {}): McpServerStatus {
  return {
    ...makeMcpServer(),
    toolCount: 0,
    approvedToolCount: 0,
    ...overrides,
  };
}

describe("Transport.mcp.toolBudget", () => {
  it("returns the registry's configured budget", () => {
    const registry = mock<McpRegistry>();
    registry.toolBudget.mockReturnValue(50);
    const transport = makeTransport({ registry });

    expect(transport.mcp.toolBudget()).toBe(50);
  });

  it("returns 0 when no registry is wired (mcp_disabled deployment)", () => {
    const transport = makeTransport({});
    expect(transport.mcp.toolBudget()).toBe(0);
  });
});

describe("Transport.mcp.addServer", () => {
  it("happy path: identity ok, Zod parse ok, registry returns server", async () => {
    const registry = mock<McpRegistry>();
    const server = makeMcpServer();
    registry.addServer.mockResolvedValue(server);
    const transport = makeTransport({ registry });

    const result = await transport.mcp.addServer(KNOWN_HANDLE, {
      name: "github",
      config: VALID_STDIO_CONFIG,
      enabled: true,
    });

    expect(result._unsafeUnwrap()).toEqual(server);
    expect(registry.addServer).toHaveBeenCalledWith({
      name: "github",
      config: VALID_STDIO_CONFIG,
      enabled: true,
    });
  });

  it("identity check fires BEFORE the mcp_disabled probe (no info leak)", async () => {
    // An impostor on a deployment without MCP wiring must not learn whether
    // MCP is configured. Order matters: identity must reject first.
    const transport = makeTransport({});
    const result = await transport.mcp.addServer(UNKNOWN_HANDLE, {
      name: "github",
      config: VALID_STDIO_CONFIG,
      enabled: true,
    });
    expect(result._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
  });

  it("returns mcp_disabled when known caller, no registry", async () => {
    const transport = makeTransport({});
    const result = await transport.mcp.addServer(KNOWN_HANDLE, {
      name: "github",
      config: VALID_STDIO_CONFIG,
      enabled: true,
    });
    expect(result._unsafeUnwrapErr()).toEqual({ code: "mcp_disabled" });
  });

  it("returns mcp_invalid_config with joined Zod issues when the config blob is malformed", async () => {
    const registry = mock<McpRegistry>();
    const transport = makeTransport({ registry });

    // Drive a real Zod failure — missing `command` on stdio.
    const result = await transport.mcp.addServer(KNOWN_HANDLE, {
      name: "broken",
      config: { transport: "stdio", args: [], env: {} },
      enabled: true,
    });

    const e = result._unsafeUnwrapErr();
    expect(e.code).toBe("mcp_invalid_config");
    if (e.code === "mcp_invalid_config") {
      expect(e.reason.length).toBeGreaterThan(0);
      // reason is `"<path>: <message>; <path>: <message>"`
      expect(e.reason).toMatch(/:/);
    }
    expect(registry.addServer).not.toHaveBeenCalled();
  });

  it("maps UniqueViolationError → mcp_server_name_taken", async () => {
    const registry = mock<McpRegistry>();
    registry.addServer.mockRejectedValue(new UniqueViolationError("dup name"));
    const transport = makeTransport({ registry });

    const result = await transport.mcp.addServer(KNOWN_HANDLE, {
      name: "github",
      config: VALID_STDIO_CONFIG,
      enabled: true,
    });

    expect(result._unsafeUnwrapErr()).toEqual({
      code: "mcp_server_name_taken",
      name: "github",
    });
  });

  it("maps McpInvalidServerNameError → mcp_invalid_config with the error message", async () => {
    const registry = mock<McpRegistry>();
    registry.addServer.mockRejectedValue(
      new McpInvalidServerNameError("bad_name", "server name cannot contain underscores"),
    );
    const transport = makeTransport({ registry });

    const result = await transport.mcp.addServer(KNOWN_HANDLE, {
      name: "bad_name",
      config: VALID_STDIO_CONFIG,
      enabled: true,
    });

    expect(result._unsafeUnwrapErr()).toEqual({
      code: "mcp_invalid_config",
      reason: "server name cannot contain underscores",
    });
  });

  it("rethrows other registry errors — Result wraps domain failures only", async () => {
    const registry = mock<McpRegistry>();
    registry.addServer.mockRejectedValue(new Error("connection refused"));
    const transport = makeTransport({ registry });

    await expect(
      transport.mcp.addServer(KNOWN_HANDLE, {
        name: "github",
        config: VALID_STDIO_CONFIG,
        enabled: true,
      }),
    ).rejects.toThrow(/connection refused/);
  });
});

describe("Transport.mcp.removeServer", () => {
  it("happy path → ok(undefined)", async () => {
    const registry = mock<McpRegistry>();
    registry.removeServer.mockResolvedValue(undefined);
    const transport = makeTransport({ registry });

    const result = await transport.mcp.removeServer(KNOWN_HANDLE, "server-1");

    expect(result._unsafeUnwrap()).toBe(undefined);
    expect(registry.removeServer).toHaveBeenCalledWith("server-1");
  });

  it("rejects unknown caller", async () => {
    const registry = mock<McpRegistry>();
    const transport = makeTransport({ registry });
    const result = await transport.mcp.removeServer(UNKNOWN_HANDLE, "server-1");
    expect(result._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    expect(registry.removeServer).not.toHaveBeenCalled();
  });

  it("returns mcp_disabled when registry is unwired", async () => {
    const transport = makeTransport({});
    const result = await transport.mcp.removeServer(KNOWN_HANDLE, "server-1");
    expect(result._unsafeUnwrapErr()).toEqual({ code: "mcp_disabled" });
  });
});

describe("Transport.mcp.listServers", () => {
  it("happy path → ok with server statuses", async () => {
    const registry = mock<McpRegistry>();
    const status = makeMcpServerStatus();
    registry.listServers.mockResolvedValue([status]);
    const transport = makeTransport({ registry });

    const result = await transport.mcp.listServers(KNOWN_HANDLE);

    expect(result._unsafeUnwrap()).toEqual([status]);
  });

  it("rejects unknown caller", async () => {
    const transport = makeTransport({ registry: mock<McpRegistry>() });
    const result = await transport.mcp.listServers(UNKNOWN_HANDLE);
    expect(result._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
  });

  it("returns mcp_disabled when registry is unwired", async () => {
    const transport = makeTransport({});
    const result = await transport.mcp.listServers(KNOWN_HANDLE);
    expect(result._unsafeUnwrapErr()).toEqual({ code: "mcp_disabled" });
  });
});

describe("Transport.mcp.approveServer", () => {
  it("happy path → ok(undefined)", async () => {
    const registry = mock<McpRegistry>();
    registry.approveServer.mockResolvedValue(undefined);
    const transport = makeTransport({ registry });

    const result = await transport.mcp.approveServer(KNOWN_HANDLE, "server-1");

    expect(result._unsafeUnwrap()).toBe(undefined);
  });

  it("maps McpServerNotFoundError → mcp_server_not_found", async () => {
    const registry = mock<McpRegistry>();
    registry.approveServer.mockRejectedValue(new McpServerNotFoundError("server-ghost"));
    const transport = makeTransport({ registry });

    const result = await transport.mcp.approveServer(KNOWN_HANDLE, "server-ghost");

    expect(result._unsafeUnwrapErr()).toEqual({
      code: "mcp_server_not_found",
      serverId: "server-ghost",
    });
  });

  it("maps a generic registry error → mcp_connection_failed with the error message", async () => {
    // connect/listTools failures surface as Result errors (not throws) so
    // the Telegram callback can render a precise toast for the operator.
    const registry = mock<McpRegistry>();
    registry.approveServer.mockRejectedValue(new Error("ECONNREFUSED at 127.0.0.1"));
    const transport = makeTransport({ registry });

    const result = await transport.mcp.approveServer(KNOWN_HANDLE, "server-1");

    expect(result._unsafeUnwrapErr()).toEqual({
      code: "mcp_connection_failed",
      serverId: "server-1",
      reason: "ECONNREFUSED at 127.0.0.1",
    });
  });

  it("rejects unknown caller before any registry call", async () => {
    const registry = mock<McpRegistry>();
    const transport = makeTransport({ registry });
    const result = await transport.mcp.approveServer(UNKNOWN_HANDLE, "server-1");
    expect(result._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    expect(registry.approveServer).not.toHaveBeenCalled();
  });

  it("returns mcp_disabled when registry is unwired", async () => {
    const transport = makeTransport({});
    const result = await transport.mcp.approveServer(KNOWN_HANDLE, "server-1");
    expect(result._unsafeUnwrapErr()).toEqual({ code: "mcp_disabled" });
  });
});

describe("Transport.mcp.approveTool", () => {
  it("happy path: registry returns true → ok(undefined)", async () => {
    const registry = mock<McpRegistry>();
    registry.approveTool.mockResolvedValue(true);
    const transport = makeTransport({ registry });

    const result = await transport.mcp.approveTool(KNOWN_HANDLE, "server-1", "read_file");

    expect(result._unsafeUnwrap()).toBe(undefined);
    expect(registry.approveTool).toHaveBeenCalledWith("server-1", "read_file");
  });

  it("registry returns false (no pin for that tool) → mcp_tool_not_found", async () => {
    // The boolean lets us distinguish "approved" from "typoed the name" —
    // a zero-row UPDATE would otherwise look like success.
    const registry = mock<McpRegistry>();
    registry.approveTool.mockResolvedValue(false);
    const transport = makeTransport({ registry });

    const result = await transport.mcp.approveTool(KNOWN_HANDLE, "server-1", "no_such_tool");

    expect(result._unsafeUnwrapErr()).toEqual({
      code: "mcp_tool_not_found",
      serverId: "server-1",
      toolName: "no_such_tool",
    });
  });

  it("rejects unknown caller", async () => {
    const transport = makeTransport({ registry: mock<McpRegistry>() });
    const result = await transport.mcp.approveTool(UNKNOWN_HANDLE, "server-1", "read_file");
    expect(result._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
  });

  it("returns mcp_disabled when registry is unwired", async () => {
    const transport = makeTransport({});
    const result = await transport.mcp.approveTool(KNOWN_HANDLE, "server-1", "read_file");
    expect(result._unsafeUnwrapErr()).toEqual({ code: "mcp_disabled" });
  });
});

describe("Transport.mcp.rejectTool", () => {
  it("happy path → ok(undefined)", async () => {
    const registry = mock<McpRegistry>();
    registry.rejectTool.mockResolvedValue(true);
    const transport = makeTransport({ registry });

    const result = await transport.mcp.rejectTool(KNOWN_HANDLE, "server-1", "write_file");

    expect(result._unsafeUnwrap()).toBe(undefined);
    expect(registry.rejectTool).toHaveBeenCalledWith("server-1", "write_file");
  });

  it("returns mcp_tool_not_found when registry returns false", async () => {
    const registry = mock<McpRegistry>();
    registry.rejectTool.mockResolvedValue(false);
    const transport = makeTransport({ registry });

    const result = await transport.mcp.rejectTool(KNOWN_HANDLE, "server-1", "no_such_tool");

    expect(result._unsafeUnwrapErr()).toEqual({
      code: "mcp_tool_not_found",
      serverId: "server-1",
      toolName: "no_such_tool",
    });
  });

  it("rejects unknown caller", async () => {
    const transport = makeTransport({ registry: mock<McpRegistry>() });
    const result = await transport.mcp.rejectTool(UNKNOWN_HANDLE, "server-1", "write_file");
    expect(result._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
  });
});
