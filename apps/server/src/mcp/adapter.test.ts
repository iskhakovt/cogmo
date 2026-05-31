import { describe, expect, it, vi } from "vitest";
import { mcpDescriptorToToolSpec } from "./adapter.js";
import type { McpConnectionPool } from "./client/pool.js";
import type { McpServer, McpToolDescriptor } from "./config.js";

function makeServer(name = "github"): McpServer {
  return {
    id: "server-1",
    name,
    config: {
      transport: "stdio",
      command: "npx",
      args: ["@modelcontextprotocol/server-github"],
      env: {},
    },
    enabled: true,
    approvalStatus: "approved",
    lastConnectedAt: null,
    lastError: null,
    createdAt: new Date(),
  };
}

function makeDescriptor(name = "create_pr"): McpToolDescriptor {
  return {
    name,
    description: "Create a pull request",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" } },
      required: ["repo"],
    },
  };
}

function makePool(callTool: (...args: unknown[]) => Promise<unknown>): McpConnectionPool {
  const conn = {
    callTool: vi.fn(callTool),
    listTools: vi.fn(),
    onToolsChanged: vi.fn(() => () => {}),
    onClose: vi.fn(() => () => {}),
    close: vi.fn(),
  };
  return {
    getConnection: vi.fn(async () => conn),
    // The adapter only uses getConnection — the rest are unused but typed.
  } as unknown as McpConnectionPool;
}

describe("mcpDescriptorToToolSpec", () => {
  it("composes the canonical tool name", () => {
    const spec = mcpDescriptorToToolSpec({
      server: makeServer("github"),
      descriptor: makeDescriptor("create_pr"),
      pool: makePool(async () => ({ content: [] })),
      timeoutMs: 30_000,
    });
    expect(spec.name).toBe("mcp__github__create_pr");
  });

  it("forwards description verbatim and forces inputSchema.type to object", () => {
    const spec = mcpDescriptorToToolSpec({
      server: makeServer(),
      descriptor: makeDescriptor(),
      pool: makePool(async () => ({ content: [] })),
      timeoutMs: 30_000,
    });
    expect(spec.description).toBe("Create a pull request");
    expect(spec.inputSchema.type).toBe("object");
    expect(spec.inputSchema.properties).toEqual({ repo: { type: "string" } });
    expect(spec.inputSchema.required).toEqual(["repo"]);
  });

  it("marks the spec durable so Inngest memoizes the tool call", () => {
    const spec = mcpDescriptorToToolSpec({
      server: makeServer(),
      descriptor: makeDescriptor(),
      pool: makePool(async () => ({ content: [] })),
      timeoutMs: 30_000,
    });
    expect(spec.durable).toBe(true);
  });

  it("dispatches via the pool with the SDK-shaped timeout option", async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "PR opened" }],
    }));
    const pool = makePool(callTool);
    const spec = mcpDescriptorToToolSpec({
      server: makeServer(),
      descriptor: makeDescriptor(),
      pool,
      timeoutMs: 12_345,
    });

    const out = await spec.handler({ repo: "iskhakovt/cogmo" }, {} as never);
    expect(out).toBe("PR opened");
    expect(pool.getConnection).toHaveBeenCalledWith("server-1");
    expect(callTool).toHaveBeenCalledWith(
      "create_pr",
      { repo: "iskhakovt/cogmo" },
      { timeoutMs: 12_345 },
    );
  });

  it("joins multiple text content blocks with newlines", async () => {
    const pool = makePool(async () => ({
      content: [
        { type: "text", text: "Line 1" },
        { type: "text", text: "Line 2" },
      ],
    }));
    const spec = mcpDescriptorToToolSpec({
      server: makeServer(),
      descriptor: makeDescriptor(),
      pool,
      timeoutMs: 30_000,
    });
    expect(await spec.handler({}, {} as never)).toBe("Line 1\nLine 2");
  });

  it("falls back to JSON-stringifying structuredContent when no text blocks", async () => {
    const pool = makePool(async () => ({
      content: [],
      structuredContent: { number: 42, opened: true },
    }));
    const spec = mcpDescriptorToToolSpec({
      server: makeServer(),
      descriptor: makeDescriptor(),
      pool,
      timeoutMs: 30_000,
    });
    expect(await spec.handler({}, {} as never)).toBe('{"number":42,"opened":true}');
  });

  it("throws on isError so the agent loop wraps as tool_result with isError", async () => {
    const pool = makePool(async () => ({
      isError: true,
      content: [{ type: "text", text: "rate limit hit" }],
    }));
    const spec = mcpDescriptorToToolSpec({
      server: makeServer(),
      descriptor: makeDescriptor(),
      pool,
      timeoutMs: 30_000,
    });
    await expect(spec.handler({}, {} as never)).rejects.toThrow(/rate limit hit/);
  });

  it("throws a generic message when isError is set but content is empty", async () => {
    const pool = makePool(async () => ({ isError: true }));
    const spec = mcpDescriptorToToolSpec({
      server: makeServer(),
      descriptor: makeDescriptor(),
      pool,
      timeoutMs: 30_000,
    });
    await expect(spec.handler({}, {} as never)).rejects.toThrow(/isError without textual content/);
  });
});
