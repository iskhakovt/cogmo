import { describe, expect, it } from "vitest";
import {
  assertValidServerName,
  composeMcpToolName,
  MCP_TOOL_NAME_PREFIX,
  McpServerConfigSchema,
  McpValueSourceSchema,
  ToolSchemaSnapshotSchema,
} from "./config.js";

describe("McpValueSourceSchema", () => {
  it("accepts a literal value", () => {
    expect(McpValueSourceSchema.parse({ kind: "literal", value: "production" })).toEqual({
      kind: "literal",
      value: "production",
    });
  });

  it("accepts a secret reference", () => {
    expect(McpValueSourceSchema.parse({ kind: "secret", name: "mcp:github:token" })).toEqual({
      kind: "secret",
      name: "mcp:github:token",
    });
  });

  it("rejects an unknown kind", () => {
    expect(() => McpValueSourceSchema.parse({ kind: "env", name: "GITHUB_TOKEN" })).toThrow();
  });

  it("rejects a secret with empty name", () => {
    expect(() => McpValueSourceSchema.parse({ kind: "secret", name: "" })).toThrow();
  });
});

describe("McpServerConfigSchema", () => {
  it("accepts a stdio config", () => {
    const parsed = McpServerConfigSchema.parse({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: { kind: "secret", name: "mcp:github:token" },
        NODE_ENV: { kind: "literal", value: "production" },
      },
    });
    expect(parsed.transport).toBe("stdio");
  });

  it("accepts an http config", () => {
    const parsed = McpServerConfigSchema.parse({
      transport: "http",
      url: "https://api.example.com/mcp",
      headers: {
        Authorization: { kind: "secret", name: "mcp:example:bearer" },
      },
    });
    expect(parsed.transport).toBe("http");
  });

  it("accepts an sse config", () => {
    const parsed = McpServerConfigSchema.parse({
      transport: "sse",
      url: "https://api.example.com/mcp/sse",
      headers: {},
    });
    expect(parsed.transport).toBe("sse");
  });

  it("rejects an unknown transport", () => {
    expect(() =>
      McpServerConfigSchema.parse({ transport: "websocket", url: "wss://x.example.com" }),
    ).toThrow();
  });

  it("rejects a stdio config with empty command", () => {
    expect(() =>
      McpServerConfigSchema.parse({ transport: "stdio", command: "", args: [], env: {} }),
    ).toThrow();
  });

  it("rejects an http config with a non-URL", () => {
    expect(() =>
      McpServerConfigSchema.parse({ transport: "http", url: "not a url", headers: {} }),
    ).toThrow();
  });

  it("rejects extra unknown env-value kinds", () => {
    expect(() =>
      McpServerConfigSchema.parse({
        transport: "stdio",
        command: "npx",
        args: [],
        env: { TOKEN: { kind: "env_var", name: "GITHUB_TOKEN" } },
      }),
    ).toThrow();
  });
});

describe("ToolSchemaSnapshotSchema", () => {
  it("accepts a minimal JSON-Schema-shaped input", () => {
    expect(
      ToolSchemaSnapshotSchema.parse({
        description: "List PRs",
        inputSchema: { type: "object", properties: { repo: { type: "string" } } },
      }),
    ).toBeTruthy();
  });

  it("rejects a missing description", () => {
    expect(() => ToolSchemaSnapshotSchema.parse({ inputSchema: { type: "object" } })).toThrow();
  });
});

describe("assertValidServerName", () => {
  it.each(["github", "google_calendar", "linear", "x", "g0", "a_b_c"])("accepts %s", (name) => {
    expect(() => assertValidServerName(name)).not.toThrow();
  });

  it.each([
    "GitHub",
    "1github",
    "git-hub",
    "git hub",
    "",
    "GitHub__",
    "foo__bar", // disallowed — would make mcp__foo__bar__tool ambiguous with mcp__foo__bar_tool
    "_github", // leading underscore
    "github_", // trailing underscore
    "foo___bar", // triple underscore
  ])("rejects %s", (name) => {
    expect(() => assertValidServerName(name)).toThrow(/Invalid MCP server name/);
  });
});

describe("composeMcpToolName", () => {
  it("composes the canonical mcp__<server>__<tool> form", () => {
    expect(composeMcpToolName("github", "create_pr")).toBe("mcp__github__create_pr");
  });

  it("uses the documented prefix", () => {
    expect(composeMcpToolName("x", "y").startsWith(MCP_TOOL_NAME_PREFIX)).toBe(true);
  });
});
