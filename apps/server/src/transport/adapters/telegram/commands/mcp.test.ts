import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { handleMcp } from "./mcp.js";
import { mkCtx, transportWith } from "./test-fixtures.js";

describe("handleMcp", () => {
  function mcpServerStatus(overrides: {
    name: string;
    approvalStatus?: "pending" | "approved" | "needs_reapproval";
    toolCount?: number;
    approvedToolCount?: number;
    enabled?: boolean;
    lastError?: string | null;
  }) {
    return {
      id: `id-${overrides.name}`,
      name: overrides.name,
      config: {
        transport: "stdio" as const,
        command: "npx",
        args: [],
        env: {},
      },
      enabled: overrides.enabled ?? true,
      approvalStatus: overrides.approvalStatus ?? "pending",
      lastConnectedAt: null,
      lastError: overrides.lastError ?? null,
      createdAt: new Date(),
      toolCount: overrides.toolCount ?? 0,
      approvedToolCount: overrides.approvedToolCount ?? 0,
    };
  }

  it("replies with usage when called with no args", async () => {
    const ctx = mkCtx();
    await handleMcp(transportWith(), ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/Usage: \/mcp/));
  });

  it("list with no servers prompts to add one", async () => {
    const transport = transportWith({
      mcp: {
        toolBudget: vi.fn().mockReturnValue(25),
        addServer: vi.fn(),
        removeServer: vi.fn(),
        listServers: vi.fn().mockResolvedValue(ok([])),
        approveServer: vi.fn(),
        approveTool: vi.fn(),
        rejectTool: vi.fn(),
      },
    });
    const ctx = mkCtx("list");
    await handleMcp(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/No MCP servers configured/));
  });

  it("list renders status, transport, and approved/total counts", async () => {
    const transport = transportWith({
      mcp: {
        toolBudget: vi.fn().mockReturnValue(25),
        addServer: vi.fn(),
        removeServer: vi.fn(),
        listServers: vi.fn().mockResolvedValue(
          ok([
            mcpServerStatus({
              name: "github",
              approvalStatus: "approved",
              toolCount: 5,
              approvedToolCount: 3,
            }),
            mcpServerStatus({
              name: "linear",
              approvalStatus: "pending",
              toolCount: 0,
              approvedToolCount: 0,
              enabled: false,
            }),
          ]),
        ),
        approveServer: vi.fn(),
        approveTool: vi.fn(),
        rejectTool: vi.fn(),
      },
    });
    const ctx = mkCtx("list");
    await handleMcp(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toMatch(/github \[stdio\] — approved, 3\/5 tools approved/);
    expect(reply).toMatch(/linear \[stdio\] — pending, 0\/0 tools approved \(disabled\)/);
  });

  it("add parses trailing JSON config", async () => {
    const addServer = vi.fn().mockResolvedValue(
      ok({
        id: "id-1",
        name: "github",
        approvalStatus: "pending",
      }),
    );
    const transport = transportWith({
      mcp: {
        toolBudget: vi.fn().mockReturnValue(25),
        addServer,
        removeServer: vi.fn(),
        listServers: vi.fn(),
        approveServer: vi.fn(),
        approveTool: vi.fn(),
        rejectTool: vi.fn(),
      },
    });
    const ctx = mkCtx(
      'add github {"transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":{}}',
    );
    await handleMcp(transport, ctx);
    expect(addServer).toHaveBeenCalledWith(
      "1",
      expect.objectContaining({ name: "github", enabled: true }),
    );
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/added \(status: pending\)/));
  });

  it("add rejects malformed JSON with a precise error", async () => {
    const transport = transportWith();
    const ctx = mkCtx("add github {not json}");
    await handleMcp(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/Invalid JSON/));
  });

  it("approve <name> calls approveServer with the resolved id", async () => {
    const approveServer = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({
      mcp: {
        toolBudget: vi.fn().mockReturnValue(25),
        addServer: vi.fn(),
        removeServer: vi.fn(),
        listServers: vi.fn().mockResolvedValue(ok([mcpServerStatus({ name: "github" })])),
        approveServer,
        approveTool: vi.fn(),
        rejectTool: vi.fn(),
      },
    });
    const ctx = mkCtx("approve github");
    await handleMcp(transport, ctx);
    expect(approveServer).toHaveBeenCalledWith("1", "id-github");
  });

  it("approve <name> <tool> flips a single tool", async () => {
    const approveTool = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({
      mcp: {
        toolBudget: vi.fn().mockReturnValue(25),
        addServer: vi.fn(),
        removeServer: vi.fn(),
        listServers: vi.fn().mockResolvedValue(ok([mcpServerStatus({ name: "github" })])),
        approveServer: vi.fn(),
        approveTool,
        rejectTool: vi.fn(),
      },
    });
    const ctx = mkCtx("approve github create_pr");
    await handleMcp(transport, ctx);
    expect(approveTool).toHaveBeenCalledWith("1", "id-github", "create_pr");
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringMatching(/Tool "github\.create_pr" approved/),
    );
  });

  it("approve <name> <typo> surfaces mcp_tool_not_found instead of false-positive success", async () => {
    const approveTool = vi
      .fn()
      .mockResolvedValue(
        err({ code: "mcp_tool_not_found" as const, serverId: "id-github", toolName: "typo" }),
      );
    const transport = transportWith({
      mcp: {
        toolBudget: vi.fn().mockReturnValue(25),
        addServer: vi.fn(),
        removeServer: vi.fn(),
        listServers: vi.fn().mockResolvedValue(ok([mcpServerStatus({ name: "github" })])),
        approveServer: vi.fn(),
        approveTool,
        rejectTool: vi.fn(),
      },
    });
    const ctx = mkCtx("approve github typo");
    await handleMcp(transport, ctx);
    expect(approveTool).toHaveBeenCalledWith("1", "id-github", "typo");
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringMatching(/Tool "typo" not found on server/),
    );
  });

  it("reject requires both name and tool", async () => {
    const ctx = mkCtx("reject github");
    await handleMcp(transportWith(), ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/Usage: \/mcp/));
  });

  it("remove resolves the name to the server id and calls removeServer", async () => {
    const removeServer = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({
      mcp: {
        toolBudget: vi.fn().mockReturnValue(25),
        addServer: vi.fn(),
        removeServer,
        listServers: vi.fn().mockResolvedValue(ok([mcpServerStatus({ name: "github" })])),
        approveServer: vi.fn(),
        approveTool: vi.fn(),
        rejectTool: vi.fn(),
      },
    });
    const ctx = mkCtx("remove github");
    await handleMcp(transport, ctx);
    expect(removeServer).toHaveBeenCalledWith("1", "id-github");
  });

  it("pending lists only servers with unapproved state", async () => {
    const transport = transportWith({
      mcp: {
        toolBudget: vi.fn().mockReturnValue(25),
        addServer: vi.fn(),
        removeServer: vi.fn(),
        listServers: vi.fn().mockResolvedValue(
          ok([
            mcpServerStatus({
              name: "approved-fully",
              approvalStatus: "approved",
              toolCount: 2,
              approvedToolCount: 2,
            }),
            mcpServerStatus({
              name: "needs-tools",
              approvalStatus: "approved",
              toolCount: 3,
              approvedToolCount: 1,
            }),
            mcpServerStatus({ name: "pending-server", approvalStatus: "pending" }),
          ]),
        ),
        approveServer: vi.fn(),
        approveTool: vi.fn(),
        rejectTool: vi.fn(),
      },
    });
    const ctx = mkCtx("pending");
    await handleMcp(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toMatch(/needs-tools.*\(2 tools pending\)/);
    expect(reply).toMatch(/pending-server.*server status: pending/);
    expect(reply).not.toMatch(/approved-fully/);
  });

  it("maps mcp_disabled to a friendly message", async () => {
    const transport = transportWith({
      mcp: {
        toolBudget: vi.fn().mockReturnValue(25),
        addServer: vi.fn(),
        removeServer: vi.fn(),
        listServers: vi.fn().mockResolvedValue(err({ code: "mcp_disabled" as const })),
        approveServer: vi.fn(),
        approveTool: vi.fn(),
        rejectTool: vi.fn(),
      },
    });
    const ctx = mkCtx("list");
    await handleMcp(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringMatching(/MCP integrations are unavailable/),
    );
  });
});
