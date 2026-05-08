import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import type { McpServerConfig } from "../config.js";
import { DrizzleMcpStore } from "./index.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleMcpStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleMcpStore(tx);
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

// --- Helpers ---

const stdioConfig: McpServerConfig = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: {
    GITHUB_PERSONAL_ACCESS_TOKEN: { kind: "secret", name: "mcp:github:token" },
  },
};

const httpConfig: McpServerConfig = {
  transport: "http",
  url: "https://api.example.com/mcp",
  headers: {
    Authorization: { kind: "secret", name: "mcp:example:bearer" },
  },
};

async function seedServer(name = "github", enabled = true) {
  return tx((trx) => store.addServer(trx, { name, config: stdioConfig, enabled }));
}

// --- Tests ---

describe("DrizzleMcpStore", () => {
  describe("addServer", () => {
    it("inserts a server with pending approval status", async () => {
      const server = await seedServer();
      expect(server.id).toBeDefined();
      expect(server.name).toBe("github");
      expect(server.approvalStatus).toBe("pending");
      expect(server.enabled).toBe(true);
      expect(server.lastConnectedAt).toBeNull();
      expect(server.lastError).toBeNull();
      expect(server.config).toEqual(stdioConfig);
      expect(server.createdAt).toBeInstanceOf(Date);
    });

    it("rejects duplicate names", async () => {
      await seedServer();
      await expect(seedServer()).rejects.toThrow();
    });

    it("rejects an invalid server name shape", async () => {
      await expect(
        tx((trx) => store.addServer(trx, { name: "GitHub", config: stdioConfig, enabled: true })),
      ).rejects.toThrow(/Invalid MCP server name/);
    });

    it("rejects malformed config at the JSONB boundary", async () => {
      await expect(
        tx((trx) =>
          store.addServer(trx, {
            name: "broken",
            // @ts-expect-error — empty command violates StdioConfigSchema's min(1)
            config: { transport: "stdio", command: "", args: [], env: {} },
            enabled: true,
          }),
        ),
      ).rejects.toThrow();
    });

    it("preserves http config round-trip", async () => {
      const server = await tx((trx) =>
        store.addServer(trx, {
          name: "linear",
          config: httpConfig,
          enabled: true,
        }),
      );
      expect(server.config).toEqual(httpConfig);
    });
  });

  describe("getServer", () => {
    it("returns undefined for unknown id and name", async () => {
      expect(
        await tx((trx) => store.getServerById(trx, "00000000-0000-0000-0000-000000000000")),
      ).toBeUndefined();
      expect(await tx((trx) => store.getServerByName(trx, "nope"))).toBeUndefined();
    });

    it("retrieves by id and by name", async () => {
      const created = await seedServer();
      expect(await tx((trx) => store.getServerById(trx, created.id))).toEqual(created);
      expect(await tx((trx) => store.getServerByName(trx, created.name))).toEqual(created);
    });
  });

  describe("listServers / listEnabledServers", () => {
    it("orders by name and filters by enabled", async () => {
      await seedServer("zeta", true);
      await seedServer("alpha", false);
      await seedServer("beta", true);

      const all = await tx((trx) => store.listServers(trx));
      expect(all.map((s) => s.name)).toEqual(["alpha", "beta", "zeta"]);

      const enabled = await tx((trx) => store.listEnabledServers(trx));
      expect(enabled.map((s) => s.name)).toEqual(["beta", "zeta"]);
    });
  });

  describe("setEnabled / setServerApprovalStatus", () => {
    it("toggles enabled and approval", async () => {
      const created = await seedServer();
      await tx((trx) => store.setEnabled(trx, created.id, false));
      await tx((trx) => store.setServerApprovalStatus(trx, created.id, "approved"));
      const refetched = await tx((trx) => store.getServerById(trx, created.id));
      expect(refetched?.enabled).toBe(false);
      expect(refetched?.approvalStatus).toBe("approved");
    });
  });

  describe("recordLastConnected / recordLastError", () => {
    it("records a connection timestamp and clears prior error", async () => {
      const created = await seedServer();
      await tx((trx) => store.recordLastError(trx, created.id, "boom"));
      const at = new Date("2026-05-04T12:00:00Z");
      await tx((trx) => store.recordLastConnected(trx, created.id, at));
      const refetched = await tx((trx) => store.getServerById(trx, created.id));
      expect(refetched?.lastConnectedAt?.toISOString()).toBe(at.toISOString());
      expect(refetched?.lastError).toBeNull();
    });

    it("records an error without touching last_connected_at", async () => {
      const created = await seedServer();
      const at = new Date("2026-05-04T12:00:00Z");
      await tx((trx) => store.recordLastConnected(trx, created.id, at));
      await tx((trx) => store.recordLastError(trx, created.id, "schema drift"));
      const refetched = await tx((trx) => store.getServerById(trx, created.id));
      expect(refetched?.lastConnectedAt?.toISOString()).toBe(at.toISOString());
      expect(refetched?.lastError).toBe("schema drift");
    });
  });

  describe("upsertToolPin", () => {
    it("inserts a pin", async () => {
      const server = await seedServer();
      const pin = await tx((trx) =>
        store.upsertToolPin(trx, {
          serverId: server.id,
          toolName: "list_issues",
          schemaHash: "deadbeef",
          schemaSnapshot: {
            description: "List issues",
            inputSchema: { type: "object", properties: { repo: { type: "string" } } },
          },
          approvalStatus: "pending",
        }),
      );
      expect(pin.toolName).toBe("list_issues");
      expect(pin.schemaHash).toBe("deadbeef");
      expect(pin.approvalStatus).toBe("pending");
    });

    it("updates an existing pin in place on (server_id, tool_name) conflict", async () => {
      const server = await seedServer();
      const first = await tx((trx) =>
        store.upsertToolPin(trx, {
          serverId: server.id,
          toolName: "list_issues",
          schemaHash: "v1",
          schemaSnapshot: { description: "old", inputSchema: {} },
          approvalStatus: "approved",
        }),
      );
      const second = await tx((trx) =>
        store.upsertToolPin(trx, {
          serverId: server.id,
          toolName: "list_issues",
          schemaHash: "v2",
          schemaSnapshot: { description: "new", inputSchema: {} },
          approvalStatus: "pending",
        }),
      );
      expect(second.id).toBe(first.id);
      expect(second.schemaHash).toBe("v2");
      expect(second.schemaSnapshot.description).toBe("new");
      expect(second.approvalStatus).toBe("pending");

      const all = await tx((trx) => store.getToolPins(trx, server.id));
      expect(all).toHaveLength(1);
    });
  });

  describe("getToolPins / getApprovedToolPins", () => {
    it("returns pins ordered by tool name and filters approved", async () => {
      const server = await seedServer();
      await tx((trx) =>
        store.upsertToolPin(trx, {
          serverId: server.id,
          toolName: "list_issues",
          schemaHash: "h1",
          schemaSnapshot: { description: "d", inputSchema: {} },
          approvalStatus: "approved",
        }),
      );
      await tx((trx) =>
        store.upsertToolPin(trx, {
          serverId: server.id,
          toolName: "create_pr",
          schemaHash: "h2",
          schemaSnapshot: { description: "d", inputSchema: {} },
          approvalStatus: "pending",
        }),
      );

      const all = await tx((trx) => store.getToolPins(trx, server.id));
      expect(all.map((p) => p.toolName)).toEqual(["create_pr", "list_issues"]);

      const approved = await tx((trx) => store.getApprovedToolPins(trx, server.id));
      expect(approved.map((p) => p.toolName)).toEqual(["list_issues"]);
    });
  });

  describe("setToolApproval / deleteToolPin", () => {
    it("transitions tool approval state and returns true", async () => {
      const server = await seedServer();
      await tx((trx) =>
        store.upsertToolPin(trx, {
          serverId: server.id,
          toolName: "create_pr",
          schemaHash: "h",
          schemaSnapshot: { description: "d", inputSchema: {} },
          approvalStatus: "pending",
        }),
      );
      const updated = await tx((trx) =>
        store.setToolApproval(trx, server.id, "create_pr", "approved"),
      );
      expect(updated).toBe(true);
      const pins = await tx((trx) => store.getApprovedToolPins(trx, server.id));
      expect(pins.map((p) => p.toolName)).toEqual(["create_pr"]);
    });

    it("returns false when no pin exists for the tool name", async () => {
      const server = await seedServer();
      const updated = await tx((trx) =>
        store.setToolApproval(trx, server.id, "no_such_tool", "approved"),
      );
      expect(updated).toBe(false);
    });

    it("returns false when the server id is unknown", async () => {
      const updated = await tx((trx) =>
        store.setToolApproval(trx, "00000000-0000-0000-0000-000000000000", "create_pr", "approved"),
      );
      expect(updated).toBe(false);
    });

    it("deletes a single pin without affecting siblings", async () => {
      const server = await seedServer();
      await tx((trx) =>
        store.upsertToolPin(trx, {
          serverId: server.id,
          toolName: "a",
          schemaHash: "h",
          schemaSnapshot: { description: "d", inputSchema: {} },
          approvalStatus: "approved",
        }),
      );
      await tx((trx) =>
        store.upsertToolPin(trx, {
          serverId: server.id,
          toolName: "b",
          schemaHash: "h",
          schemaSnapshot: { description: "d", inputSchema: {} },
          approvalStatus: "approved",
        }),
      );
      await tx((trx) => store.deleteToolPin(trx, server.id, "a"));
      const remaining = await tx((trx) => store.getToolPins(trx, server.id));
      expect(remaining.map((p) => p.toolName)).toEqual(["b"]);
    });
  });

  describe("removeServer", () => {
    it("cascades to tool pins on delete", async () => {
      const server = await seedServer();
      await tx((trx) =>
        store.upsertToolPin(trx, {
          serverId: server.id,
          toolName: "create_pr",
          schemaHash: "h",
          schemaSnapshot: { description: "d", inputSchema: {} },
          approvalStatus: "approved",
        }),
      );
      await tx((trx) => store.removeServer(trx, server.id));
      expect(await tx((trx) => store.getServerById(trx, server.id))).toBeUndefined();
      // Query pins for the deleted server's id directly — if the FK cascade
      // weakened (e.g. ON DELETE SET NULL), orphaned rows would still match.
      const orphanPins = await tx((trx) => store.getToolPins(trx, server.id));
      expect(orphanPins).toHaveLength(0);
    });

    it("is a no-op when the id does not exist", async () => {
      await expect(
        tx((trx) => store.removeServer(trx, "00000000-0000-0000-0000-000000000000")),
      ).resolves.toBeUndefined();
    });
  });

  describe("listServerStatuses", () => {
    it("includes total and approved tool counts", async () => {
      const a = await seedServer("alpha");
      const b = await seedServer("beta");
      await tx((trx) =>
        store.upsertToolPin(trx, {
          serverId: a.id,
          toolName: "x",
          schemaHash: "h",
          schemaSnapshot: { description: "d", inputSchema: {} },
          approvalStatus: "approved",
        }),
      );
      await tx((trx) =>
        store.upsertToolPin(trx, {
          serverId: a.id,
          toolName: "y",
          schemaHash: "h",
          schemaSnapshot: { description: "d", inputSchema: {} },
          approvalStatus: "pending",
        }),
      );
      // beta has no tools

      const statuses = await tx((trx) => store.listServerStatuses(trx));
      const byName = Object.fromEntries(statuses.map((s) => [s.name, s]));
      expect(byName.alpha?.toolCount).toBe(2);
      expect(byName.alpha?.approvedToolCount).toBe(1);
      expect(byName.beta?.toolCount).toBe(0);
      expect(byName.beta?.approvedToolCount).toBe(0);
      void b;
    });
  });

  describe("syncServerApproval", () => {
    it("upserts new pins as pending and flips the server to approved in one tx", async () => {
      const server = await seedServer();
      await tx((trx) =>
        store.syncServerApproval(trx, {
          serverId: server.id,
          snapshots: [
            {
              toolName: "create_pr",
              schemaHash: "h1",
              schemaSnapshot: { description: "d", inputSchema: {} },
            },
            {
              toolName: "list_issues",
              schemaHash: "h2",
              schemaSnapshot: { description: "d", inputSchema: {} },
            },
          ],
        }),
      );
      const refreshed = await tx((trx) => store.getServerById(trx, server.id));
      expect(refreshed?.approvalStatus).toBe("approved");
      const pins = await tx((trx) => store.getToolPins(trx, server.id));
      expect(pins.map((p) => p.toolName).sort()).toEqual(["create_pr", "list_issues"]);
      expect(pins.every((p) => p.approvalStatus === "pending")).toBe(true);
    });

    it("preserves the prior approval status when the schema hash is unchanged", async () => {
      const server = await seedServer();
      await tx((trx) =>
        store.upsertToolPin(trx, {
          serverId: server.id,
          toolName: "create_pr",
          schemaHash: "h1",
          schemaSnapshot: { description: "d", inputSchema: {} },
          approvalStatus: "approved",
        }),
      );
      await tx((trx) =>
        store.syncServerApproval(trx, {
          serverId: server.id,
          snapshots: [
            {
              toolName: "create_pr",
              schemaHash: "h1",
              schemaSnapshot: { description: "d", inputSchema: {} },
            },
          ],
        }),
      );
      const pins = await tx((trx) => store.getToolPins(trx, server.id));
      expect(pins[0]?.approvalStatus).toBe("approved");
    });

    it("downgrades to pending when the schema hash changes", async () => {
      const server = await seedServer();
      await tx((trx) =>
        store.upsertToolPin(trx, {
          serverId: server.id,
          toolName: "create_pr",
          schemaHash: "old",
          schemaSnapshot: { description: "d", inputSchema: {} },
          approvalStatus: "approved",
        }),
      );
      await tx((trx) =>
        store.syncServerApproval(trx, {
          serverId: server.id,
          snapshots: [
            {
              toolName: "create_pr",
              schemaHash: "new",
              schemaSnapshot: { description: "d", inputSchema: {} },
            },
          ],
        }),
      );
      const pins = await tx((trx) => store.getToolPins(trx, server.id));
      expect(pins[0]?.approvalStatus).toBe("pending");
      expect(pins[0]?.schemaHash).toBe("new");
    });

    it("deletes pins for tools that vanished from the snapshot list", async () => {
      const server = await seedServer();
      await tx((trx) =>
        store.upsertToolPin(trx, {
          serverId: server.id,
          toolName: "old_tool",
          schemaHash: "h",
          schemaSnapshot: { description: "d", inputSchema: {} },
          approvalStatus: "approved",
        }),
      );
      await tx((trx) =>
        store.syncServerApproval(trx, {
          serverId: server.id,
          snapshots: [
            {
              toolName: "new_tool",
              schemaHash: "h",
              schemaSnapshot: { description: "d", inputSchema: {} },
            },
          ],
        }),
      );
      const pins = await tx((trx) => store.getToolPins(trx, server.id));
      expect(pins.map((p) => p.toolName)).toEqual(["new_tool"]);
    });

    it("flips the server to approved even when the snapshot list is empty (server with no tools)", async () => {
      const server = await seedServer();
      await tx((trx) => store.syncServerApproval(trx, { serverId: server.id, snapshots: [] }));
      const refreshed = await tx((trx) => store.getServerById(trx, server.id));
      expect(refreshed?.approvalStatus).toBe("approved");
      expect(await tx((trx) => store.getToolPins(trx, server.id))).toHaveLength(0);
    });
  });
});
