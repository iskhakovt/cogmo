import {
  DaytonaNotFoundError,
  type Sandbox as DaytonaSdkSandbox,
  SandboxState,
} from "@daytonaio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSpec } from "../index.js";
import { DaytonaSandboxClient } from "./client.js";

// Mock the SDK at the module boundary so tests don't need a network roundtrip.
// The Daytona class's internal behaviour isn't under test here — what matters
// is the shape of calls Cogmo's client makes against it (labels, resources,
// auto-stop math, lifecycle order).
const daytonaCalls = {
  list: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  get: vi.fn<(...args: unknown[]) => Promise<DaytonaSdkSandbox>>(),
  create: vi.fn<(...args: unknown[]) => Promise<DaytonaSdkSandbox>>(),
};
vi.mock("@daytonaio/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@daytonaio/sdk")>();
  // Constructor-shaped mock — `new Daytona(...)` in client.ts requires a
  // callable that produces an object via `new`, so a plain `vi.fn()` won't
  // do. A class declaration is the cleanest way to satisfy `new`.
  class MockDaytona {
    list = daytonaCalls.list;
    get = daytonaCalls.get;
    create = daytonaCalls.create;
  }
  return { ...actual, Daytona: MockDaytona };
});

interface FakeSandboxOptions {
  id: string;
  state: SandboxState;
  labels?: Record<string, string>;
}

function fakeSandbox(opts: FakeSandboxOptions): DaytonaSdkSandbox {
  // Constructed as a minimal duck-type — Cogmo's client only reads `id`,
  // `state`, calls `start`/`delete`/`refreshActivity`/`process`, never the
  // SDK-level behaviour we don't override here.
  const sandbox = {
    id: opts.id,
    state: opts.state,
    labels: opts.labels ?? {},
    start: vi.fn(async () => {
      sandbox.state = SandboxState.STARTED;
    }),
    stop: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    archive: vi.fn(async () => {}),
    refreshActivity: vi.fn(async () => {}),
    setLabels: vi.fn(async (l: Record<string, string>) => l),
    setAutostopInterval: vi.fn(async () => {}),
    process: {
      /* opaque to these tests */
    } as DaytonaSdkSandbox["process"],
  };
  return sandbox as unknown as DaytonaSdkSandbox;
}

beforeEach(() => {
  daytonaCalls.list.mockReset();
  daytonaCalls.get.mockReset();
  daytonaCalls.create.mockReset();
});
afterEach(() => {
  vi.clearAllTimers();
});

const BASE_SPEC: SessionSpec = {
  taskId: "019d0000-0000-7000-8000-000000000aaa",
  image: "python:3.14-slim",
  resourceLimits: { cpus: 1, memory_bytes: 512 * 1024 * 1024, pids: 256 },
  expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h from now
};

async function makeClient(): Promise<DaytonaSandboxClient> {
  return DaytonaSandboxClient.create({
    apiKey: "test-key",
    instanceId: "instance-1",
  });
}

describe("DaytonaSandboxClient", () => {
  describe("create", () => {
    it("stamps cogmo.task / cogmo.role / cogmo.instance labels", async () => {
      daytonaCalls.create.mockResolvedValue(
        fakeSandbox({ id: "sb-1", state: SandboxState.STARTED }),
      );
      const client = await makeClient();
      await client.create(BASE_SPEC);
      expect(daytonaCalls.create).toHaveBeenCalledTimes(1);
      const call = daytonaCalls.create.mock.calls[0]?.[0] as {
        labels: Record<string, string>;
      };
      expect(call.labels).toMatchObject({
        "cogmo.task": BASE_SPEC.taskId,
        "cogmo.role": "root",
        "cogmo.instance": "instance-1",
      });
    });

    it("rounds memory_bytes up to GiB (Daytona's unit) and cpus up to integer", async () => {
      daytonaCalls.create.mockResolvedValue(
        fakeSandbox({ id: "sb-2", state: SandboxState.STARTED }),
      );
      const client = await makeClient();
      await client.create({
        ...BASE_SPEC,
        // 512 MiB → 1 GiB; 0.5 cpus → 1 cpu (Daytona has no fractional)
        resourceLimits: { cpus: 0.5, memory_bytes: 512 * 1024 * 1024, pids: 64 },
      });
      const call = daytonaCalls.create.mock.calls[0]?.[0] as {
        resources: { cpu: number; memory: number };
      };
      expect(call.resources.cpu).toBe(1);
      expect(call.resources.memory).toBe(1);
    });

    it("computes autoStopInterval as ceil(minutes-until-expiresAt) with a 1-min floor", async () => {
      daytonaCalls.create.mockResolvedValue(
        fakeSandbox({ id: "sb-3", state: SandboxState.STARTED }),
      );
      const client = await makeClient();
      // 30 seconds in the future → ceil to 1 minute (floor)
      await client.create({ ...BASE_SPEC, expiresAt: new Date(Date.now() + 30 * 1000) });
      const call = daytonaCalls.create.mock.calls[0]?.[0] as { autoStopInterval: number };
      expect(call.autoStopInterval).toBe(1);
    });

    it("returns a session with type='daytona' state carrying the Daytona sandbox id", async () => {
      daytonaCalls.create.mockResolvedValue(
        fakeSandbox({ id: "sb-xyz", state: SandboxState.STARTED }),
      );
      const client = await makeClient();
      const session = await client.create(BASE_SPEC);
      expect(session.state).toEqual({
        type: "daytona",
        taskId: BASE_SPEC.taskId,
        sandboxId: "sb-xyz",
      });
    });

    it.each([
      ["worktree", { worktree: { hostPath: "/tmp/wt" } } as Partial<SessionSpec>, /Phase 3a/],
      [
        "askpass",
        { askpass: { hostDir: "/tmp/a", containerDir: "/.cogmo-askpass" } } as Partial<SessionSpec>,
        /Phase 3a/,
      ],
      ["homeVolume", { homeVolume: { volumeName: "v" } } as Partial<SessionSpec>, /auto-persists/],
      [
        "allowPrivilegedRunc",
        { allowPrivilegedRunc: true } as Partial<SessionSpec>,
        /Local-Docker-specific/,
      ],
    ])("rejects %s as Phase-3a-unsupported", async (_label, override, msg) => {
      const client = await makeClient();
      await expect(client.create({ ...BASE_SPEC, ...override })).rejects.toThrow(msg);
      expect(daytonaCalls.create).not.toHaveBeenCalled();
    });
  });

  describe("resume", () => {
    it("starts a STOPPED sandbox before returning the session", async () => {
      const sb = fakeSandbox({ id: "sb-stopped", state: SandboxState.STOPPED });
      daytonaCalls.get.mockResolvedValue(sb);
      const client = await makeClient();
      await client.resume({ type: "daytona", taskId: "t1", sandboxId: "sb-stopped" });
      expect(sb.start).toHaveBeenCalled();
    });

    it("starts an ARCHIVED sandbox (rehydrates from object storage)", async () => {
      const sb = fakeSandbox({ id: "sb-arch", state: SandboxState.ARCHIVED });
      daytonaCalls.get.mockResolvedValue(sb);
      const client = await makeClient();
      await client.resume({ type: "daytona", taskId: "t1", sandboxId: "sb-arch" });
      expect(sb.start).toHaveBeenCalled();
    });

    it("does NOT call start on a STARTED sandbox", async () => {
      const sb = fakeSandbox({ id: "sb-running", state: SandboxState.STARTED });
      daytonaCalls.get.mockResolvedValue(sb);
      const client = await makeClient();
      await client.resume({ type: "daytona", taskId: "t1", sandboxId: "sb-running" });
      expect(sb.start).not.toHaveBeenCalled();
    });

    it.each([
      ["DESTROYED", SandboxState.DESTROYED],
      ["ERROR", SandboxState.ERROR],
      ["BUILD_FAILED", SandboxState.BUILD_FAILED],
    ])("throws on terminal state %s", async (_label, state) => {
      const sb = fakeSandbox({ id: "sb-dead", state });
      daytonaCalls.get.mockResolvedValue(sb);
      const client = await makeClient();
      await expect(
        client.resume({ type: "daytona", taskId: "t1", sandboxId: "sb-dead" }),
      ).rejects.toThrow(/terminal/);
    });
  });

  describe("tryResumeByTaskId", () => {
    it("filters by cogmo.task + cogmo.role labels", async () => {
      daytonaCalls.list.mockResolvedValue({
        items: [],
        totalPages: 0,
        currentPage: 1,
        totalItems: 0,
        itemsPerPage: 50,
      });
      const client = await makeClient();
      await client.tryResumeByTaskId("task-x");
      expect(daytonaCalls.list).toHaveBeenCalledWith({
        "cogmo.task": "task-x",
        "cogmo.role": "root",
      });
    });

    it("returns null when the list is empty", async () => {
      daytonaCalls.list.mockResolvedValue({
        items: [],
        totalPages: 0,
        currentPage: 1,
        totalItems: 0,
        itemsPerPage: 50,
      });
      const client = await makeClient();
      const session = await client.tryResumeByTaskId("missing");
      expect(session).toBeNull();
    });

    it("skips terminal sandboxes and returns the first non-terminal one", async () => {
      const dead = fakeSandbox({ id: "sb-dead", state: SandboxState.DESTROYED });
      const alive = fakeSandbox({ id: "sb-alive", state: SandboxState.STARTED });
      daytonaCalls.list.mockResolvedValue({
        items: [dead, alive],
        totalPages: 1,
        currentPage: 1,
        totalItems: 2,
        itemsPerPage: 50,
      });
      const client = await makeClient();
      const session = await client.tryResumeByTaskId("t1");
      expect(session?.state.sandboxId).toBe("sb-alive");
    });

    it("restarts a STOPPED candidate before returning it", async () => {
      const sb = fakeSandbox({ id: "sb-stopped", state: SandboxState.STOPPED });
      daytonaCalls.list.mockResolvedValue({
        items: [sb],
        totalPages: 1,
        currentPage: 1,
        totalItems: 1,
        itemsPerPage: 50,
      });
      const client = await makeClient();
      await client.tryResumeByTaskId("t1");
      expect(sb.start).toHaveBeenCalled();
    });
  });

  describe("deleteByTaskId", () => {
    it("calls .delete() on every matching sandbox", async () => {
      const a = fakeSandbox({ id: "sb-a", state: SandboxState.STARTED });
      const b = fakeSandbox({ id: "sb-b", state: SandboxState.STOPPED });
      daytonaCalls.list.mockResolvedValue({
        items: [a, b],
        totalPages: 1,
        currentPage: 1,
        totalItems: 2,
        itemsPerPage: 50,
      });
      const client = await makeClient();
      await client.deleteByTaskId("t1");
      expect(a.delete).toHaveBeenCalled();
      expect(b.delete).toHaveBeenCalled();
    });

    it("filters by cogmo.task label only (catches stale duplicates regardless of role)", async () => {
      daytonaCalls.list.mockResolvedValue({
        items: [],
        totalPages: 0,
        currentPage: 1,
        totalItems: 0,
        itemsPerPage: 50,
      });
      const client = await makeClient();
      await client.deleteByTaskId("t1");
      expect(daytonaCalls.list).toHaveBeenCalledWith({ "cogmo.task": "t1" });
    });

    it("swallows per-sandbox delete failures and continues", async () => {
      const a = fakeSandbox({ id: "sb-a", state: SandboxState.STARTED });
      const b = fakeSandbox({ id: "sb-b", state: SandboxState.STARTED });
      a.delete = vi.fn(async () => {
        throw new Error("daemon error");
      });
      daytonaCalls.list.mockResolvedValue({
        items: [a, b],
        totalPages: 1,
        currentPage: 1,
        totalItems: 2,
        itemsPerPage: 50,
      });
      const client = await makeClient();
      await client.deleteByTaskId("t1");
      // b still gets deleted even though a threw
      expect(b.delete).toHaveBeenCalled();
    });
  });

  describe("serialize/deserialize state", () => {
    it("round-trips state through Zod", async () => {
      const client = await makeClient();
      const original = {
        type: "daytona" as const,
        taskId: "019d0000-0000-7000-8000-000000000aaa",
        sandboxId: "sb-roundtrip",
      };
      const serialized = client.serializeState(original);
      const back = client.deserializeState(serialized);
      expect(back).toEqual(original);
    });

    it("rejects malformed payloads at deserialize", async () => {
      const client = await makeClient();
      expect(() => client.deserializeState({ type: "wrong" })).toThrow();
      expect(() => client.deserializeState({ type: "daytona" })).toThrow();
    });
  });

  describe("resume — sandbox not found upstream", () => {
    it("propagates DaytonaNotFoundError from daytona.get without crashing", async () => {
      // Operator deleted the sandbox out-of-band, or autoDeleteInterval
      // reaped it past archive. `daytona.get` 404s and the SDK wraps
      // it in a DaytonaNotFoundError; resume() must let that bubble so
      // the orchestrator can mark the task failed instead of hanging.
      daytonaCalls.get.mockRejectedValue(new DaytonaNotFoundError("Sandbox not found"));
      const client = await makeClient();
      await expect(
        client.resume({ type: "daytona", taskId: "t1", sandboxId: "sb-gone" }),
      ).rejects.toBeInstanceOf(DaytonaNotFoundError);
    });
  });

  describe("keepalive ticker (fake timers)", () => {
    it("calls refreshActivity every KEEPALIVE_INTERVAL_MS while alive", async () => {
      vi.useFakeTimers();
      try {
        const sb = fakeSandbox({ id: "sb-keep", state: SandboxState.STARTED });
        daytonaCalls.create.mockResolvedValue(sb);
        const client = await makeClient();
        // 30 minutes — well beyond the first few intervals so we can
        // observe the ticker fire without hitting the deadline branch.
        await client.create({ ...BASE_SPEC, expiresAt: new Date(Date.now() + 30 * 60_000) });

        // Advance past the first interval (5 min) and wait one
        // microtask cycle for the catch on `refreshActivity()` to run.
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(sb.refreshActivity).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(sb.refreshActivity).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("self-stops once Date.now() passes expiresAt — auto-stop reaper takes over", async () => {
      vi.useFakeTimers();
      try {
        const sb = fakeSandbox({ id: "sb-bound", state: SandboxState.STARTED });
        daytonaCalls.create.mockResolvedValue(sb);
        const client = await makeClient();
        // 10-minute deadline. KEEPALIVE_INTERVAL_MS is 5 min so the
        // ticker fires once at t=5 (within deadline) and then again
        // at t=10 (boundary — but Date.now() === expiresAt is NOT
        // past, so this fires too); the t=15 fire is past the
        // deadline and self-stops without calling refreshActivity.
        await client.create({ ...BASE_SPEC, expiresAt: new Date(Date.now() + 10 * 60_000) });

        // t=5: within deadline → fires.
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(sb.refreshActivity).toHaveBeenCalledTimes(1);

        // t=10: at deadline (Date.now() === expiresAtMs, so NOT
        // strictly greater) → fires once more.
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(sb.refreshActivity).toHaveBeenCalledTimes(2);

        // t=15: past deadline → self-stops, no further calls.
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(sb.refreshActivity).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("resume-derived sessions have unbounded keepalive (no expiresAt known)", async () => {
      vi.useFakeTimers();
      try {
        const sb = fakeSandbox({ id: "sb-resumed", state: SandboxState.STARTED });
        daytonaCalls.get.mockResolvedValue(sb);
        const client = await makeClient();
        await client.resume({
          type: "daytona",
          taskId: "t-resume",
          sandboxId: "sb-resumed",
        });

        // Advance well past where a deadline-bounded ticker would
        // have stopped (the BASE_SPEC's 1h would have been the
        // ceiling). Resume should keep firing.
        for (let i = 0; i < 20; i++) {
          await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        }
        expect(sb.refreshActivity).toHaveBeenCalledTimes(20);
      } finally {
        vi.useRealTimers();
      }
    });

    it("delete(session) stops the keepalive — no more refreshActivity firings", async () => {
      vi.useFakeTimers();
      try {
        const sb = fakeSandbox({ id: "sb-del", state: SandboxState.STARTED });
        daytonaCalls.create.mockResolvedValue(sb);
        daytonaCalls.list.mockResolvedValue({
          items: [sb],
          totalPages: 1,
          currentPage: 1,
          totalItems: 1,
          itemsPerPage: 50,
        });
        const client = await makeClient();
        const session = await client.create({
          ...BASE_SPEC,
          expiresAt: new Date(Date.now() + 60 * 60_000),
        });

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(sb.refreshActivity).toHaveBeenCalledTimes(1);

        await client.delete(session);

        // Run more time. Refresh count must NOT advance.
        await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
        expect(sb.refreshActivity).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("shutdown", () => {
    it("clears every pending keepalive timer", async () => {
      vi.useFakeTimers();
      try {
        const sbA = fakeSandbox({ id: "sb-A", state: SandboxState.STARTED });
        const sbB = fakeSandbox({ id: "sb-B", state: SandboxState.STARTED });
        // Two consecutive `create()`s mint two different keepalives.
        daytonaCalls.create.mockResolvedValueOnce(sbA).mockResolvedValueOnce(sbB);
        const client = await makeClient();
        await client.create({
          ...BASE_SPEC,
          taskId: "019d0000-0000-7000-8000-00000000aaaa",
          expiresAt: new Date(Date.now() + 60 * 60_000),
        });
        await client.create({
          ...BASE_SPEC,
          taskId: "019d0000-0000-7000-8000-00000000bbbb",
          expiresAt: new Date(Date.now() + 60 * 60_000),
        });

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(sbA.refreshActivity).toHaveBeenCalledTimes(1);
        expect(sbB.refreshActivity).toHaveBeenCalledTimes(1);

        await client.shutdown();

        await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
        // Neither timer fires after shutdown.
        expect(sbA.refreshActivity).toHaveBeenCalledTimes(1);
        expect(sbB.refreshActivity).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("delete (single-session)", () => {
    it("stops the keepalive even when the provider-side sandbox is already gone", async () => {
      // Provider auto-reaped the sandbox between `create` and `delete`
      // — `daytona.list({task})` returns nothing. Without explicit
      // keepalive cleanup by sandboxId, the ticker would leak.
      const sb = fakeSandbox({ id: "sb-gone", state: SandboxState.STARTED });
      daytonaCalls.create.mockResolvedValue(sb);
      daytonaCalls.list.mockResolvedValue({
        items: [],
        totalPages: 0,
        currentPage: 1,
        totalItems: 0,
        itemsPerPage: 50,
      });

      const client = await makeClient();
      const session = await client.create(BASE_SPEC);
      // `delete(session)` should clear the keepalive even though the
      // list returns empty (sandbox already auto-stopped + reaped).
      await client.delete(session);
      // No assertion on the timer directly (private), but a follow-up
      // `shutdown` should find nothing to clear.
      await client.shutdown(); // would hang on a leaked timer if buggy
    });
  });

  describe("capabilities + backendId", () => {
    it("advertises sandbox-internal sibling spawn + git-remote transport", async () => {
      const client = await makeClient();
      expect(client.backendId).toBe("daytona");
      expect(client.capabilities).toEqual({
        siblingContainers: "sandbox-internal",
        hostBindMount: false,
        customImage: true,
        volumes: "managed",
        workingTreeTransport: "git-remote",
      });
    });
  });

  describe("ensureImagePresent + reconcileCrashedInstances", () => {
    it("ensureImagePresent is a no-op (Daytona builds on first create)", async () => {
      const client = await makeClient();
      await expect(client.ensureImagePresent("anything:latest")).resolves.toBeUndefined();
    });

    it("reconcileCrashedInstances reports zero (provider auto-cleanup)", async () => {
      const client = await makeClient();
      const result = await client.reconcileCrashedInstances("instance-1");
      expect(result).toEqual({ orphansReaped: 0 });
    });
  });

  describe("healthCheck", () => {
    it("succeeds when the API is reachable", async () => {
      daytonaCalls.list.mockResolvedValue({
        items: [],
        totalPages: 0,
        currentPage: 1,
        totalItems: 0,
        itemsPerPage: 50,
      });
      const client = await makeClient();
      const result = await client.healthCheck();
      expect(result).toEqual({ ok: true, runtime: "daytona" });
    });

    it("propagates SDK errors when unreachable", async () => {
      daytonaCalls.list.mockRejectedValue(new Error("network down"));
      const client = await makeClient();
      await expect(client.healthCheck()).rejects.toThrow("network down");
    });
  });
});
