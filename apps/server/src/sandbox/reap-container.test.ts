import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../db/index.js";
import type { DockerContainer, DockerFacade } from "./docker-facade.js";
import { reapContainer, reapDiscoveredContainer } from "./reap-container.js";
import type { ContainerRow, SandboxStore } from "./store/index.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);
const AT = new Date("2026-04-27T12:00:00Z");

function deps(opts: { killFails?: boolean } = {}): {
  deps: { docker: DockerFacade; store: SandboxStore; runInTx: Transactor };
  store: ReturnType<typeof mock<SandboxStore>>;
  container: ReturnType<typeof mock<DockerContainer>>;
} {
  const container = mock<DockerContainer>();
  if (opts.killFails) {
    container.kill.mockRejectedValue(Object.assign(new Error("daemon i/o"), { statusCode: 500 }));
  } else {
    container.kill.mockResolvedValue(undefined);
  }
  container.remove.mockResolvedValue(undefined);
  const docker = mock<DockerFacade>();
  docker.getContainer.mockReturnValue(container);
  const store = mock<SandboxStore>();
  store.transitionContainerStatus.mockResolvedValue({ kind: "transitioned" });
  return { deps: { docker, store, runInTx: fakeRunInTx }, store, container };
}

function row(status: ContainerRow["status"]): ContainerRow {
  const r = mock<ContainerRow>();
  Object.defineProperty(r, "id", { value: "row-1", configurable: true });
  Object.defineProperty(r, "status", { value: status, configurable: true });
  return r;
}

describe("reapContainer", () => {
  it("kills and removes the container, then moves the row to reaped", async () => {
    const { deps: d, store, container } = deps();
    const result = await reapContainer(d, {
      id: "row-1",
      dockerId: "c1",
      from: "running",
      reason: "ttl_expired",
      at: AT,
    });
    expect(result.isOk() && result.value).toEqual({ kind: "transitioned" });
    expect(container.kill).toHaveBeenCalledWith({ signal: "SIGTERM" });
    expect(container.remove).toHaveBeenCalledWith({ force: true });
    expect(store.transitionContainerStatus).toHaveBeenCalledWith(expect.anything(), {
      id: "row-1",
      from: "running",
      to: "reaped",
      at: AT,
    });
  });

  it("returns stale when another path finished the row", async () => {
    const { deps: d, store } = deps();
    store.transitionContainerStatus.mockResolvedValue({ kind: "stale", status: "reaped" });
    const result = await reapContainer(d, {
      id: "row-1",
      dockerId: "c1",
      from: "running",
      reason: "cascade",
      at: AT,
    });
    expect(result.isOk() && result.value).toEqual({ kind: "stale", status: "reaped" });
  });

  it("returns the daemon error and leaves the row alone when the kill is refused", async () => {
    const { deps: d, store } = deps({ killFails: true });
    const result = await reapContainer(d, {
      id: "row-1",
      dockerId: "c1",
      from: "running",
      reason: "ttl_expired",
      at: AT,
    });
    expect(result.isErr() && result.error).toMatchObject({
      kind: "daemon_error",
      op: "kill",
      statusCode: 500,
    });
    expect(store.transitionContainerStatus).not.toHaveBeenCalled();
  });
});

describe("reapDiscoveredContainer", () => {
  it("only removes the daemon object when there is no row", async () => {
    const { deps: d, store, container } = deps();
    const result = await reapDiscoveredContainer(d, {
      dockerId: "c1",
      row: undefined,
      reason: "dead_instance",
      at: AT,
    });
    expect(result.isOk()).toBe(true);
    expect(container.remove).toHaveBeenCalledTimes(1);
    expect(store.transitionContainerStatus).not.toHaveBeenCalled();
  });

  it("only removes the daemon object when the row is already reaped", async () => {
    const { deps: d, store, container } = deps();
    const result = await reapDiscoveredContainer(d, {
      dockerId: "c1",
      row: row("reaped"),
      reason: "crash_reconcile",
      at: AT,
    });
    expect(result.isOk()).toBe(true);
    expect(container.remove).toHaveBeenCalledTimes(1);
    expect(store.transitionContainerStatus).not.toHaveBeenCalled();
  });

  it.each(["starting", "running", "exited"] as const)(
    "reaps a %s row from its read status",
    async (status) => {
      const { deps: d, store } = deps();
      const result = await reapDiscoveredContainer(d, {
        dockerId: "c1",
        row: row(status),
        reason: "dead_instance",
        at: AT,
      });
      expect(result.isOk()).toBe(true);
      expect(store.transitionContainerStatus).toHaveBeenCalledWith(expect.anything(), {
        id: "row-1",
        from: status,
        to: "reaped",
        at: AT,
      });
    },
  );

  it("passes a daemon error through", async () => {
    const { deps: d } = deps({ killFails: true });
    const result = await reapDiscoveredContainer(d, {
      dockerId: "c1",
      row: row("running"),
      reason: "dead_instance",
      at: AT,
    });
    expect(result.isErr() && result.error).toMatchObject({ kind: "daemon_error", op: "kill" });
  });
});
