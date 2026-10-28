import { err, ok } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../db/index.js";
import type { DockerFacade } from "./docker-facade.js";
import { type DaemonError, killAndRemoveContainer } from "./kill-and-remove-container.js";
import { reapContainer, reapDiscoveredContainer } from "./reap-container.js";
import type { ContainerRow, SandboxStore } from "./store/index.js";

vi.mock("./kill-and-remove-container.js", () => ({ killAndRemoveContainer: vi.fn() }));
const killAndRemove = vi.mocked(killAndRemoveContainer);

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);
const AT = new Date("2026-04-27T12:00:00Z");
const TASK_ID = "019d0000-0000-7000-8000-000000000001";
const INSTANCE_ID = "019d0000-0000-7000-8000-000000000002";
const REFUSED: DaemonError = {
  kind: "daemon_error",
  op: "kill",
  statusCode: 500,
  error: new Error("daemon i/o"),
};

const docker = mock<DockerFacade>();

function deps(): {
  deps: { docker: DockerFacade; store: SandboxStore; runInTx: Transactor };
  store: ReturnType<typeof mock<SandboxStore>>;
  /** Order of the daemon and store calls, as they were made. */
  order: string[];
} {
  const order: string[] = [];
  killAndRemove.mockImplementation(async () => {
    order.push("kill+remove");
    return ok(undefined);
  });
  const store = mock<SandboxStore>();
  store.transitionContainerStatus.mockImplementation(async () => {
    order.push("transition");
    return { kind: "transitioned" };
  });
  return { deps: { docker, store, runInTx: fakeRunInTx }, store, order };
}

function row(status: ContainerRow["status"]): ContainerRow {
  return {
    id: "row-1",
    dockerId: "c1",
    parentId: null,
    rootTaskId: TASK_ID,
    depth: 0,
    image: "alpine",
    runtime: "runc",
    labels: {
      "cogmo.managed": "true",
      "cogmo.instance": INSTANCE_ID,
      "cogmo.root_task": TASK_ID,
      "cogmo.parent": "",
      "cogmo.depth": "0",
    },
    resourceLimits: { cpus: 1, memory_bytes: 256 * 1024 * 1024, pids: 64 },
    status,
    exitCode: null,
    ttlExpiresAt: new Date("2026-04-27T13:00:00Z"),
    startedAt: status === "starting" ? null : AT,
    exitedAt: null,
    instanceId: INSTANCE_ID,
    createdAt: new Date("2026-04-27T11:00:00Z"),
  };
}

const ARGS = { id: "row-1", dockerId: "c1", reason: "ttl_expired" as const, at: AT };

beforeEach(() => {
  killAndRemove.mockReset();
});

describe("reapContainer", () => {
  it("removes the daemon object first, then moves the row to reaped", async () => {
    const { deps: d, store, order } = deps();
    const result = await reapContainer(d, ARGS);
    expect(result.isOk() && result.value).toEqual({ kind: "transitioned" });
    expect(killAndRemove).toHaveBeenCalledWith(docker, "c1");
    expect(order).toEqual(["kill+remove", "transition"]);
    expect(store.transitionContainerStatus).toHaveBeenCalledWith(expect.anything(), {
      id: "row-1",
      to: "reaped",
      at: AT,
    });
  });

  it("returns stale when another path reaped the row", async () => {
    const { deps: d, store } = deps();
    store.transitionContainerStatus.mockResolvedValue({ kind: "stale", status: "reaped" });
    const result = await reapContainer(d, { ...ARGS, reason: "cascade" });
    expect(result.isOk() && result.value).toEqual({ kind: "stale", status: "reaped" });
  });

  it("returns the daemon error and leaves the row untouched when the daemon refuses", async () => {
    const { deps: d, store } = deps();
    killAndRemove.mockResolvedValue(err(REFUSED));
    const result = await reapContainer(d, ARGS);
    expect(result.isErr() && result.error).toBe(REFUSED);
    expect(store.transitionContainerStatus).not.toHaveBeenCalled();
  });
});

describe("reapDiscoveredContainer", () => {
  it("only removes the daemon object when there is no row", async () => {
    const { deps: d, store } = deps();
    const result = await reapDiscoveredContainer(d, {
      dockerId: "c1",
      row: undefined,
      reason: "dead_instance",
      at: AT,
    });
    expect(result.isOk()).toBe(true);
    expect(killAndRemove).toHaveBeenCalledWith(docker, "c1");
    expect(store.transitionContainerStatus).not.toHaveBeenCalled();
  });

  it.each(["starting", "running", "exited", "reaped"] as const)(
    "reaps a %s row through the store's guard",
    async (status) => {
      const { deps: d, store, order } = deps();
      const result = await reapDiscoveredContainer(d, {
        dockerId: "c1",
        row: row(status),
        reason: "crash_reconcile",
        at: AT,
      });
      expect(result.isOk()).toBe(true);
      expect(order).toEqual(["kill+remove", "transition"]);
      expect(store.transitionContainerStatus).toHaveBeenCalledWith(expect.anything(), {
        id: "row-1",
        to: "reaped",
        at: AT,
      });
    },
  );

  it("passes a daemon error through with the row untouched", async () => {
    const { deps: d, store } = deps();
    killAndRemove.mockResolvedValue(err(REFUSED));
    const result = await reapDiscoveredContainer(d, {
      dockerId: "c1",
      row: row("running"),
      reason: "dead_instance",
      at: AT,
    });
    expect(result.isErr() && result.error).toBe(REFUSED);
    expect(store.transitionContainerStatus).not.toHaveBeenCalled();
  });
});
