import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { fakeRunInTx } from "../test/factories.js";
import { revokeConnector } from "./revoke-connector.js";
import type { ConnectorStore } from "./store/index.js";

const NOW = new Date("2026-11-08T12:00:00.000Z");

function deps() {
  const connectorStore = mock<ConnectorStore>();
  connectorStore.revoke.mockResolvedValue(ok({ id: "c1" }));
  return { runInTx: fakeRunInTx, connectorStore };
}

describe("revokeConnector", () => {
  it("revokes the named connector at now", async () => {
    const d = deps();
    expect(await revokeConnector(d, { name: "laptop", now: NOW })).toEqual(ok(undefined));
    expect(d.connectorStore.revoke).toHaveBeenCalledWith(expect.anything(), {
      name: "laptop",
      now: NOW,
    });
  });

  it("passes the store's not_found through", async () => {
    const d = deps();
    d.connectorStore.revoke.mockResolvedValue(err({ kind: "not_found" }));
    expect(await revokeConnector(d, { name: "ghost", now: NOW })).toEqual(
      err({ kind: "not_found" }),
    );
  });
});
