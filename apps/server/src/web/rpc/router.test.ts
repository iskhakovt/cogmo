import { createRouterClient } from "@orpc/server";
import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
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

  it("forwards input to a parameterized procedure (evolution.getEvent)", async () => {
    const client = clientFor(mockTransportDeep({ evolution: { getEvent: async () => ok(null) } }));
    expect(await client.evolution.getEvent({ id: "abc" })).toBeNull();
  });
});
