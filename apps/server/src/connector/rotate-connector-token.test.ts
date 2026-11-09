import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { expectDefined, expectOk } from "../test/assertions.js";
import { fakeRunInTx } from "../test/factories.js";
import { rotateConnectorToken } from "./rotate-connector-token.js";
import type { ConnectorStore } from "./store/index.js";
import { hashConnectorToken } from "./token.js";

function deps() {
  const connectorStore = mock<ConnectorStore>();
  connectorStore.rotateToken.mockResolvedValue(ok({ id: "c1" }));
  return { runInTx: fakeRunInTx, connectorStore };
}

describe("rotateConnectorToken", () => {
  it("stores the hash of the new token it returns", async () => {
    const d = deps();
    const { token } = expectOk(await rotateConnectorToken(d, { name: "laptop" }));
    const [, params] = expectDefined(d.connectorStore.rotateToken.mock.calls[0], "rotate call");
    expect(params).toEqual({ name: "laptop", tokenHash: hashConnectorToken(token) });
  });

  it("passes the store's not_found through", async () => {
    const d = deps();
    d.connectorStore.rotateToken.mockResolvedValue(err({ kind: "not_found" }));
    expect(await rotateConnectorToken(d, { name: "ghost" })).toEqual(err({ kind: "not_found" }));
  });
});
