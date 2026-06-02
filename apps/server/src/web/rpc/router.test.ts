import { createRouterClient } from "@orpc/server";
import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import type { McpServerStatus } from "../../mcp/config.js";
import { expectDefined } from "../../test/assertions.js";
import { mockTransportDeep } from "../../test/factories.js";
import type { Transport } from "../../transport/transport.js";
import { OWNER_HANDLE, type WebRpcContext } from "./context.js";
import { webRouter } from "./router.js";

function clientFor(transport: Transport) {
  return createRouterClient(webRouter, {
    context: { platformUserHandle: OWNER_HANDLE, transport } satisfies WebRpcContext,
  });
}

describe("webRouter", () => {
  it("returns a non-Result value directly (models.list)", async () => {
    const client = clientFor(
      mockTransportDeep({ models: { list: async () => ["gpt", "claude"] } }),
    );
    expect(await client.models.list()).toEqual(["gpt", "claude"]);
  });

  it("unwraps an ok Result (profiles.list)", async () => {
    const client = clientFor(mockTransportDeep({ profiles: { list: async () => ok([]) } }));
    expect(await client.profiles.list()).toEqual([]);
  });

  it("maps an err Result to a TRANSPORT_ERROR carrying the code", async () => {
    const client = clientFor(
      mockTransportDeep({ profiles: { list: async () => err({ code: "identity_rejected" }) } }),
    );
    await expect(client.profiles.list()).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
      data: { code: "identity_rejected" },
    });
  });

  it("passes structured error fields through (repos.list -> sandbox_disabled)", async () => {
    const client = clientFor(
      mockTransportDeep({ repos: { list: async () => err({ code: "sandbox_disabled" }) } }),
    );
    await expect(client.repos.list()).rejects.toMatchObject({
      data: { code: "sandbox_disabled" },
    });
  });

  it("passes the sync mcp.toolBudget through", async () => {
    const client = clientFor(mockTransportDeep({ mcp: { toolBudget: () => 25 } }));
    expect(await client.mcp.toolBudget()).toBe(25);
  });

  it("projects mcp.listServers to a config-free summary (no secret-source leak)", async () => {
    const status: McpServerStatus = {
      id: "srv-1",
      name: "files",
      config: {
        transport: "stdio",
        command: "mcp-files",
        args: ["--root", "/data"],
        env: { TOKEN: { kind: "secret", name: "files-token" } },
      },
      enabled: true,
      approvalStatus: "approved",
      lastConnectedAt: new Date("2026-01-01T00:00:00Z"),
      lastError: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      toolCount: 5,
      approvedToolCount: 3,
    };
    const client = clientFor(mockTransportDeep({ mcp: { listServers: async () => ok([status]) } }));

    const summary = expectDefined((await client.mcp.listServers())[0], "mcp summary");
    expect(summary).not.toHaveProperty("config");
    expect(summary).toMatchObject({
      id: "srv-1",
      name: "files",
      transport: "stdio",
      enabled: true,
      approvalStatus: "approved",
      toolCount: 5,
      approvedToolCount: 3,
      lastError: null,
    });
    // The secret-source name from `config.env` must never reach the client.
    expect(JSON.stringify(summary)).not.toContain("files-token");
  });

  it("forwards input to a parameterized procedure (evolution.getEvent)", async () => {
    const client = clientFor(mockTransportDeep({ evolution: { getEvent: async () => ok(null) } }));
    expect(await client.evolution.getEvent({ id: "abc" })).toBeNull();
  });
});
