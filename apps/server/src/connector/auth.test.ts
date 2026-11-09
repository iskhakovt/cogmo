import { err, ok } from "neverthrow";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { fakeRunInTx } from "../test/factories.js";
import { ConnectorAuth } from "./auth.js";
import type { ActiveConnector, ConnectorStore } from "./store/index.js";
import { hashConnectorToken } from "./token.js";

const PASEO: ActiveConnector = {
  id: "conn-paseo",
  name: "paseo",
  kind: "coding",
  tokenHash: hashConnectorToken("paseo-token"),
};
const NEW_CONNECTOR: ActiveConnector = {
  id: "conn-new",
  name: "new",
  kind: "coding",
  tokenHash: hashConnectorToken("new-token"),
};

let store: ReturnType<typeof mock<ConnectorStore>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  store = mock<ConnectorStore>();
  store.listActive.mockResolvedValue([PASEO]);
});

afterEach(() => {
  vi.useRealTimers();
});

function never(): Promise<never> {
  return new Promise(() => {});
}

it("authenticates a cached token without reloading", async () => {
  const auth = await ConnectorAuth.create({ runInTx: fakeRunInTx, connectorStore: store });
  expect(await auth.authenticate("paseo-token")).toEqual(ok(PASEO));
  expect(store.listActive).toHaveBeenCalledTimes(1);
});

it("reloads for an unknown token at most once every 5 s", async () => {
  const auth = await ConnectorAuth.create({ runInTx: fakeRunInTx, connectorStore: store });
  store.listActive.mockResolvedValue([PASEO, NEW_CONNECTOR]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await auth.authenticate("new-token")).toEqual(err({ kind: "unauthenticated" }));
  await vi.advanceTimersByTimeAsync(4_000);
  expect(await auth.authenticate("new-token")).toEqual(ok(NEW_CONNECTOR));
  expect(store.listActive).toHaveBeenCalledTimes(2);
});

it("lets concurrent calls with a new token share the reload the first one started", async () => {
  const auth = await ConnectorAuth.create({ runInTx: fakeRunInTx, connectorStore: store });
  store.listActive.mockResolvedValue([PASEO, NEW_CONNECTOR]);
  await vi.advanceTimersByTimeAsync(5_000);
  const results = await Promise.all([
    auth.authenticate("new-token"),
    auth.authenticate("new-token"),
  ]);
  expect(results).toEqual([ok(NEW_CONNECTOR), ok(NEW_CONNECTOR)]);
  expect(store.listActive).toHaveBeenCalledTimes(2);
});

it("answers unavailable for an unknown token after a failed reload, and within 5 s of it", async () => {
  const auth = await ConnectorAuth.create({ runInTx: fakeRunInTx, connectorStore: store });
  store.listActive.mockRejectedValue(new Error("db down"));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await auth.authenticate("new-token")).toEqual(err({ kind: "unavailable" }));
  expect(await auth.authenticate("new-token")).toEqual(err({ kind: "unavailable" }));
});

it("goes stale 90 s after the last good load started, failing even a cached token closed", async () => {
  // The first load takes 1 s.
  store.listActive.mockImplementationOnce(
    () => new Promise((resolve) => setTimeout(() => resolve([PASEO]), 1_000)),
  );
  const created = ConnectorAuth.create({ runInTx: fakeRunInTx, connectorStore: store });
  await vi.advanceTimersByTimeAsync(1_000);
  const auth = await created;
  store.listActive.mockRejectedValue(new Error("db down"));

  await vi.advanceTimersByTimeAsync(88_999);
  expect(auth.isStale()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(auth.isStale()).toBe(true);
  expect(await auth.authenticate("paseo-token")).toEqual(err({ kind: "unavailable" }));
});

it("answers unavailable within 5 s when a stalled reload outlives the cache", async () => {
  const auth = await ConnectorAuth.create({ runInTx: fakeRunInTx, connectorStore: store });
  store.listActive.mockReturnValue(never());
  void auth.refresh();
  await vi.advanceTimersByTimeAsync(90_000);
  const call = auth.authenticate("paseo-token");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await call).toEqual(err({ kind: "unavailable" }));
});

it("answers unavailable at once once a stalled reload has outlived its wait", async () => {
  const auth = await ConnectorAuth.create({ runInTx: fakeRunInTx, connectorStore: store });
  store.listActive.mockReturnValue(never());
  await vi.advanceTimersByTimeAsync(5_000);
  void auth.authenticate("new-token");
  await vi.advanceTimersByTimeAsync(5_000);
  // The reload started 5 s ago and is still stalled: a new call doesn't wait another 5 s.
  const settled = await Promise.race([
    auth.authenticate("new-token"),
    new Promise<"waiting">((resolve) => setImmediate(() => resolve("waiting"))),
  ]);
  expect(settled).toEqual(err({ kind: "unavailable" }));
  expect(store.listActive).toHaveBeenCalledTimes(2);
});

it("ages the cache on the monotonic clock, so a wall-clock jump leaves it fresh", async () => {
  const auth = await ConnectorAuth.create({ runInTx: fakeRunInTx, connectorStore: store });
  vi.setSystemTime(Date.now() + 3_600_000);
  expect(auth.isStale()).toBe(false);
  expect(await auth.authenticate("paseo-token")).toEqual(ok(PASEO));
});

it("keeps the old cache when a reload fails", async () => {
  const auth = await ConnectorAuth.create({ runInTx: fakeRunInTx, connectorStore: store });
  store.listActive.mockRejectedValue(new Error("db down"));
  await auth.refresh();
  expect(await auth.authenticate("paseo-token")).toEqual(ok(PASEO));
});

it("tells whether a connector is still active under the token it authenticated with", async () => {
  const auth = await ConnectorAuth.create({ runInTx: fakeRunInTx, connectorStore: store });
  expect(auth.isCurrent(PASEO)).toBe(true);
  store.listActive.mockResolvedValue([{ ...PASEO, tokenHash: hashConnectorToken("rotated") }]);
  await auth.refresh();
  expect(auth.isCurrent(PASEO)).toBe(false);
});

it("fails to create when the first load fails", async () => {
  store.listActive.mockRejectedValue(new Error("db down"));
  await expect(
    ConnectorAuth.create({ runInTx: fakeRunInTx, connectorStore: store }),
  ).rejects.toThrow("db down");
});
