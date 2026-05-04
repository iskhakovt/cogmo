import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/index.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import type { McpConnection } from "./client/client.js";
import type { Runner } from "./client/runner.js";
import type { McpServer, McpToolDescriptor } from "./config.js";
import { McpRegistryImpl } from "./registry.js";
import { DrizzleMcpStore } from "./store/index.js";

let db: Database;
let close: () => Promise<void>;
let store: DrizzleMcpStore;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  store = new DrizzleMcpStore(db);
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

// --- Fakes ---

function makeRunner(toolsByServerName: Record<string, McpToolDescriptor[]>): Runner {
  return {
    async spawn(server: McpServer): Promise<McpConnection> {
      const tools = toolsByServerName[server.name] ?? [];
      return {
        callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
        listTools: vi.fn(async () => tools),
        onToolsChanged: vi.fn(() => () => {}),
        onClose: vi.fn(() => () => {}),
        close: vi.fn(async () => {}),
      };
    },
  };
}

const dummySecrets = {} as SecretsStore;

function makeRegistry(runner: Runner, toolBudget = 25) {
  return new McpRegistryImpl({
    store,
    secrets: dummySecrets,
    runner,
    callTimeoutMs: 30_000,
    idleEvictionMs: 60_000,
    evictionIntervalMs: 0,
    toolBudget,
  });
}

const stdioConfig = {
  transport: "stdio" as const,
  command: "npx",
  args: [] as string[],
  env: {} as Record<string, never>,
};

// --- Tests ---

describe("McpRegistryImpl.approveServer", () => {
  it("lists tools, pins them as pending, and flips server status to approved", async () => {
    const server = await store.addServer({
      name: "github",
      config: stdioConfig,
      enabled: true,
    });
    const reg = makeRegistry(
      makeRunner({
        github: [
          {
            name: "create_pr",
            description: "Open a PR",
            inputSchema: { type: "object", properties: { repo: { type: "string" } } },
          },
          {
            name: "list_issues",
            description: "List issues",
            inputSchema: { type: "object" },
          },
        ],
      }),
    );
    await reg.approveServer(server.id);

    const refreshed = await store.getServerById(server.id);
    expect(refreshed?.approvalStatus).toBe("approved");

    const pins = await store.getToolPins(server.id);
    expect(pins.map((p) => p.toolName).sort()).toEqual(["create_pr", "list_issues"]);
    expect(pins.every((p) => p.approvalStatus === "pending")).toBe(true);

    await reg.stop();
  });

  it("preserves an approved tool's status when its schema is unchanged", async () => {
    const server = await store.addServer({ name: "github", config: stdioConfig, enabled: true });
    const tools: McpToolDescriptor[] = [
      { name: "create_pr", description: "Open a PR", inputSchema: { type: "object" } },
    ];
    const reg = makeRegistry(makeRunner({ github: tools }));

    await reg.approveServer(server.id);
    await store.setToolApproval(server.id, "create_pr", "approved");
    // Re-running approveServer with identical tool list must not downgrade.
    await reg.approveServer(server.id);
    const pins = await store.getToolPins(server.id);
    expect(pins[0]?.approvalStatus).toBe("approved");

    await reg.stop();
  });

  it("downgrades an approved tool to pending when its schema mutates", async () => {
    const server = await store.addServer({ name: "github", config: stdioConfig, enabled: true });

    let tools: McpToolDescriptor[] = [
      { name: "create_pr", description: "Open a PR", inputSchema: { type: "object" } },
    ];
    const runner: Runner = {
      async spawn() {
        return {
          callTool: vi.fn(),
          listTools: vi.fn(async () => tools),
          onToolsChanged: vi.fn(() => () => {}),
          onClose: vi.fn(() => () => {}),
          close: vi.fn(async () => {}),
        };
      },
    };
    const reg = makeRegistry(runner);

    await reg.approveServer(server.id);
    await store.setToolApproval(server.id, "create_pr", "approved");

    // Mutate the description — schema hash changes.
    tools = [
      {
        name: "create_pr",
        description: "Open a pull request (new copy)",
        inputSchema: { type: "object" },
      },
    ];
    await reg.approveServer(server.id);
    const pins = await store.getToolPins(server.id);
    expect(pins[0]?.approvalStatus).toBe("pending");

    await reg.stop();
  });

  it("deletes pins for tools the server no longer exposes", async () => {
    const server = await store.addServer({ name: "github", config: stdioConfig, enabled: true });
    let tools: McpToolDescriptor[] = [
      { name: "create_pr", description: "d", inputSchema: { type: "object" } },
      { name: "list_issues", description: "d", inputSchema: { type: "object" } },
    ];
    const runner: Runner = {
      async spawn() {
        return {
          callTool: vi.fn(),
          listTools: vi.fn(async () => tools),
          onToolsChanged: vi.fn(() => () => {}),
          onClose: vi.fn(() => () => {}),
          close: vi.fn(async () => {}),
        };
      },
    };
    const reg = makeRegistry(runner);

    await reg.approveServer(server.id);
    expect((await store.getToolPins(server.id)).map((p) => p.toolName).sort()).toEqual([
      "create_pr",
      "list_issues",
    ]);

    tools = [tools[0]!];
    await reg.approveServer(server.id);
    expect((await store.getToolPins(server.id)).map((p) => p.toolName)).toEqual(["create_pr"]);

    await reg.stop();
  });

  it("throws when the server id is unknown", async () => {
    const reg = makeRegistry(makeRunner({}));
    await expect(reg.approveServer("00000000-0000-0000-0000-000000000000")).rejects.toThrow(
      /MCP server not found/,
    );
    await reg.stop();
  });
});

describe("McpRegistryImpl.resolveTools", () => {
  async function seedApprovedServer(name: string, tools: McpToolDescriptor[]) {
    const server = await store.addServer({ name, config: stdioConfig, enabled: true });
    const reg = makeRegistry(makeRunner({ [name]: tools }));
    await reg.approveServer(server.id);
    for (const t of tools) await store.setToolApproval(server.id, t.name, "approved");
    return { server, reg };
  }

  it("returns only tools whose composed name matches a glob", async () => {
    const { reg } = await seedApprovedServer("github", [
      { name: "create_pr", description: "d", inputSchema: { type: "object" } },
      { name: "list_issues", description: "d", inputSchema: { type: "object" } },
    ]);
    const tools = await reg.resolveTools({ toolGlobs: ["mcp__github__list_*"] });
    expect(tools.map((t) => t.name)).toEqual(["mcp__github__list_issues"]);
    await reg.stop();
  });

  it("excludes pending tools even when the server is approved", async () => {
    const server = await store.addServer({ name: "github", config: stdioConfig, enabled: true });
    const reg = makeRegistry(
      makeRunner({
        github: [
          { name: "approved_tool", description: "d", inputSchema: { type: "object" } },
          { name: "pending_tool", description: "d", inputSchema: { type: "object" } },
        ],
      }),
    );
    await reg.approveServer(server.id);
    await store.setToolApproval(server.id, "approved_tool", "approved");
    // pending_tool stays pending.
    const tools = await reg.resolveTools({ toolGlobs: ["mcp__github__*"] });
    expect(tools.map((t) => t.name)).toEqual(["mcp__github__approved_tool"]);
    await reg.stop();
  });

  it("excludes tools when the server itself is not approved", async () => {
    const server = await store.addServer({ name: "github", config: stdioConfig, enabled: true });
    const reg = makeRegistry(
      makeRunner({
        github: [{ name: "x", description: "d", inputSchema: { type: "object" } }],
      }),
    );
    await reg.approveServer(server.id);
    await store.setToolApproval(server.id, "x", "approved");
    // Manually downgrade the server.
    await store.setServerApprovalStatus(server.id, "needs_reapproval");
    const tools = await reg.resolveTools({ toolGlobs: ["mcp__github__*"] });
    expect(tools).toEqual([]);
    await reg.stop();
  });

  it("excludes disabled servers", async () => {
    const { server, reg } = await seedApprovedServer("github", [
      { name: "x", description: "d", inputSchema: { type: "object" } },
    ]);
    await store.setEnabled(server.id, false);
    const tools = await reg.resolveTools({ toolGlobs: ["mcp__github__*"] });
    expect(tools).toEqual([]);
    await reg.stop();
  });

  it("returns nothing when the glob list is empty", async () => {
    await seedApprovedServer("github", [
      { name: "x", description: "d", inputSchema: { type: "object" } },
    ]);
    const reg = makeRegistry(makeRunner({}));
    expect(await reg.resolveTools({ toolGlobs: [] })).toEqual([]);
    await reg.stop();
  });

  it("caps at the budget alphabetically and drops the tail", async () => {
    const { reg } = await seedApprovedServer("github", [
      { name: "a", description: "d", inputSchema: { type: "object" } },
      { name: "b", description: "d", inputSchema: { type: "object" } },
      { name: "c", description: "d", inputSchema: { type: "object" } },
    ]);
    const tools = await reg.resolveTools({ toolGlobs: ["mcp__github__*"], budget: 2 });
    expect(tools.map((t) => t.name)).toEqual(["mcp__github__a", "mcp__github__b"]);
    await reg.stop();
  });
});

describe("McpRegistryImpl.removeServer", () => {
  it("evicts the pool entry and deletes the row", async () => {
    const server = await store.addServer({ name: "github", config: stdioConfig, enabled: true });
    const reg = makeRegistry(
      makeRunner({
        github: [{ name: "x", description: "d", inputSchema: { type: "object" } }],
      }),
    );
    await reg.approveServer(server.id);
    await reg.removeServer(server.id);
    expect(await store.getServerById(server.id)).toBeUndefined();
    await reg.stop();
  });
});
