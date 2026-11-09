import { err, ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { expectDefined, expectOk } from "../test/assertions.js";
import { fakeRunInTx } from "../test/factories.js";
import { addConnector } from "./add-connector.js";
import type { ConnectorStore } from "./store/index.js";
import { hashConnectorToken } from "./token.js";

function deps() {
  const connectorStore = mock<ConnectorStore>();
  connectorStore.insert.mockResolvedValue(ok({ id: "c1" }));
  return { runInTx: fakeRunInTx, connectorStore };
}

describe("addConnector", () => {
  it("inserts the hash of the token it returns", async () => {
    const d = deps();
    const { id, token } = expectOk(await addConnector(d, { name: "laptop", kind: "coding" }));
    expect(id).toBe("c1");
    const [, params] = expectDefined(d.connectorStore.insert.mock.calls[0], "insert call");
    expect(params).toEqual({
      name: "laptop",
      kind: "coding",
      tokenHash: hashConnectorToken(token),
    });
  });

  it.each([["Laptop"], ["1laptop"], ["-laptop"], ["lap top"], ["a".repeat(33)], ["laptop!"]])(
    "rejects the name %j before touching the store",
    async (name) => {
      const d = deps();
      expect(await addConnector(d, { name, kind: "coding" })).toEqual(
        err({ kind: "invalid_name" }),
      );
      expect(d.connectorStore.insert).not.toHaveBeenCalled();
    },
  );

  it.each([["a"], ["a".repeat(32)], ["my-laptop_2"]])("accepts the name %j", async (name) => {
    expect((await addConnector(deps(), { name, kind: "coding" })).isOk()).toBe(true);
  });

  it("passes the store's name_taken through", async () => {
    const d = deps();
    d.connectorStore.insert.mockResolvedValue(err({ kind: "name_taken" }));
    expect(await addConnector(d, { name: "laptop", kind: "coding" })).toEqual(
      err({ kind: "name_taken" }),
    );
  });
});
