import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaytonaAuthenticationError,
  DaytonaAuthorizationError,
  DaytonaConflictError,
  DaytonaConnectionError,
  DaytonaError,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  type Sandbox as DaytonaSdkSandbox,
  DaytonaTimeoutError,
  DaytonaValidationError,
  SandboxState,
} from "@daytonaio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../logger.js";
import { expectDefined } from "../../test/assertions.js";
import {
  expectCreatedNamesMatch,
  FakeDaytonaSnapshotPipeline,
} from "../../test/daytona-snapshot-pipeline-fake.js";
import type { SessionSpec } from "../index.js";
import { DaytonaSandboxClient, isTransientSnapshotCreateError, snapshotNameFor } from "./client.js";

/**
 * Snapshot state literals match the SDK's `SnapshotState` enum (which
 * isn't re-exported as a runtime value). Hand-pinned here to keep the
 * test off the transitive `@daytona/api-client` dep, matching the
 * approach in `client.ts`.
 */
const SnapshotState = {
  BUILDING: "building",
  PENDING: "pending",
  PULLING: "pulling",
  ACTIVE: "active",
  INACTIVE: "inactive",
  BUILD_FAILED: "build_failed",
} as const;
// Test-side stub shape for Daytona's Snapshot — the client reads only
// `name` and `state`, so a structural lookalike is enough.
type DaytonaSnapshot = { name: string; state: string };

// Mock the SDK at the module boundary so tests don't need a network roundtrip.
// The Daytona class's internal behaviour isn't under test here — what matters
// is the shape of calls Cogmo's client makes against it (labels, resources,
// auto-stop math, lifecycle order).
//
const daytonaCalls = {
  list: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  get: vi.fn<(...args: unknown[]) => Promise<DaytonaSdkSandbox>>(),
  create: vi.fn<(...args: unknown[]) => Promise<DaytonaSdkSandbox>>(),
  snapshotGet: vi.fn<(name: string) => Promise<DaytonaSnapshot>>(),
  snapshotCreate: vi.fn<(...args: unknown[]) => Promise<DaytonaSnapshot>>(),
  snapshotDelete: vi.fn<(snap: DaytonaSnapshot) => Promise<void>>(),
};
vi.mock("@daytonaio/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@daytonaio/sdk")>();
  // Constructor-shaped mock — `new Daytona(...)` in client.ts requires a
  // callable that produces an object via `new`, so a plain `vi.fn()` won't
  // do. A class declaration is the cleanest way to satisfy `new`.
  //
  // No `volume` field: production code never touches `daytona.volume` (the
  // backend advertises `depsCacheSharing: "per-sandbox"` and `create()`
  // throws on `SessionSpec.depsCacheVolume` before any volume API call).
  // If a regression re-introduces a `daytona.volume.*` access, the test
  // crashes with "Cannot read properties of undefined" — a stronger
  // contract than a `.not.toHaveBeenCalled()` assertion, which only fires
  // after the bad call already shipped.
  class MockDaytona {
    list = daytonaCalls.list;
    get = daytonaCalls.get;
    create = daytonaCalls.create;
    snapshot = {
      get: daytonaCalls.snapshotGet,
      create: daytonaCalls.snapshotCreate,
      delete: daytonaCalls.snapshotDelete,
    };
  }
  return { ...actual, Daytona: MockDaytona };
});

interface FakeSandboxOptions {
  id: string;
  state: SandboxState;
  labels?: Record<string, string>;
}

interface FakeSandbox extends DaytonaSdkSandbox {
  // Expose the spies directly so tests can assert against them without
  // a `(sandbox.git.clone as Mock)` cast at every call site.
  __spies: {
    delete: ReturnType<typeof vi.fn>;
    gitClone: ReturnType<typeof vi.fn>;
    fsUploadFiles: ReturnType<typeof vi.fn>;
    fsSetFilePermissions: ReturnType<typeof vi.fn>;
  };
}

function fakeSandbox(opts: FakeSandboxOptions): FakeSandbox {
  const spies = {
    delete: vi.fn(async () => {}),
    gitClone: vi.fn(async () => {}),
    fsUploadFiles: vi.fn(async () => {}),
    fsSetFilePermissions: vi.fn(async () => {}),
  };
  const sandbox = {
    id: opts.id,
    state: opts.state,
    labels: opts.labels ?? {},
    start: vi.fn(async () => {
      sandbox.state = SandboxState.STARTED;
    }),
    stop: vi.fn(async () => {}),
    delete: spies.delete,
    archive: vi.fn(async () => {}),
    refreshActivity: vi.fn(async () => {}),
    setLabels: vi.fn(async (l: Record<string, string>) => l),
    setAutostopInterval: vi.fn(async () => {}),
    process: {
      /* opaque to these tests */
    } as DaytonaSdkSandbox["process"],
    git: { clone: spies.gitClone },
    fs: { uploadFiles: spies.fsUploadFiles, setFilePermissions: spies.fsSetFilePermissions },
    __spies: spies,
  };
  return sandbox as unknown as FakeSandbox;
}

beforeEach(() => {
  daytonaCalls.list.mockReset();
  daytonaCalls.get.mockReset();
  daytonaCalls.create.mockReset();
  daytonaCalls.snapshotGet.mockReset();
  daytonaCalls.snapshotCreate.mockReset();
  daytonaCalls.snapshotDelete.mockReset();
});
afterEach(() => {
  vi.clearAllTimers();
});

function fakeSnapshot(opts: { name: string; state: string }): DaytonaSnapshot {
  return { name: opts.name, state: opts.state };
}

// Test images + their derived snapshot names. Computed via the real
// `snapshotNameFor` helper so the hash suffix stays in sync if the
// derivation changes — hardcoding the suffix would force every test to
// edit when the algorithm evolves.
const DEVBASE_IMAGE = "ghcr.io/iskhakovt/cogmo-devbase:1.66.0";
const DEVBASE_SNAPSHOT = snapshotNameFor(DEVBASE_IMAGE);
if (DEVBASE_SNAPSHOT === null) throw new Error("DEVBASE_IMAGE must be snapshot-warmable");
const PYTHON_IMAGE = "python:3.14-slim";
const PYTHON_SNAPSHOT = snapshotNameFor(PYTHON_IMAGE);
if (PYTHON_SNAPSHOT === null) throw new Error("PYTHON_IMAGE must be snapshot-warmable");

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

    it("rejects depsCacheVolume because Daytona Volumes can't honour uv's POSIX assumptions", async () => {
      daytonaCalls.create.mockResolvedValue(
        fakeSandbox({ id: "sb-vol", state: SandboxState.STARTED }),
      );

      const client = await makeClient();
      await expect(
        client.create({
          ...BASE_SPEC,
          depsCacheVolume: { volumeName: "cogmo-skills-deps-cache" },
        }),
      ).rejects.toThrow(/depsCacheSharing: 'per-sandbox'/);

      // No Daytona SDK calls made — the spec is rejected before we touch the wire.
      expect(daytonaCalls.create).not.toHaveBeenCalled();
    });

    it("omits volumes from create when depsCacheVolume is absent", async () => {
      daytonaCalls.create.mockResolvedValue(
        fakeSandbox({ id: "sb-novol", state: SandboxState.STARTED }),
      );
      const client = await makeClient();
      await client.create(BASE_SPEC);
      const call = daytonaCalls.create.mock.calls[0]?.[0] as { volumes?: unknown };
      expect("volumes" in call).toBe(false);
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
        resources: { cpu: number; memory: number; disk?: number };
      };
      expect(call.resources.cpu).toBe(1);
      expect(call.resources.memory).toBe(1);
      // Omitting disk_bytes leaves the `disk` field unset so Daytona's
      // platform default applies (currently 3 GiB).
      expect(call.resources.disk).toBeUndefined();
    });

    it("maps disk_bytes onto Daytona's `disk` field (GiB, floor 1)", async () => {
      daytonaCalls.create.mockResolvedValue(
        fakeSandbox({ id: "sb-disk", state: SandboxState.STARTED }),
      );
      const client = await makeClient();
      await client.create({
        ...BASE_SPEC,
        // 1.5 GiB → ceil to 2 GiB so the caller never gets under-provisioned.
        resourceLimits: {
          cpus: 1,
          memory_bytes: 1024 * 1024 * 1024,
          pids: 256,
          disk_bytes: 1.5 * 1024 * 1024 * 1024,
        },
      });
      const call = daytonaCalls.create.mock.calls[0]?.[0] as {
        resources: { disk?: number };
      };
      expect(call.resources.disk).toBe(2);
    });

    it("floors disk_bytes at 1 GiB (Daytona's per-resource minimum)", async () => {
      daytonaCalls.create.mockResolvedValue(
        fakeSandbox({ id: "sb-disk-floor", state: SandboxState.STARTED }),
      );
      const client = await makeClient();
      await client.create({
        ...BASE_SPEC,
        // 500 MiB ceiled to 1 GiB then floored at 1 — the floor branch of
        // `daytonaUnit` is what keeps callers from asking Daytona for
        // sub-minimum sizes that the API would reject.
        resourceLimits: {
          cpus: 1,
          memory_bytes: 1024 * 1024 * 1024,
          pids: 256,
          disk_bytes: 500 * 1024 * 1024,
        },
      });
      const call = daytonaCalls.create.mock.calls[0]?.[0] as {
        resources: { disk?: number };
      };
      expect(call.resources.disk).toBe(1);
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

    it("threads spec.env into Daytona's `envVars` field", async () => {
      daytonaCalls.create.mockResolvedValue(
        fakeSandbox({ id: "sb-env", state: SandboxState.STARTED }),
      );
      const client = await makeClient();
      await client.create({
        ...BASE_SPEC,
        env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-abc", FOO: "bar" },
      });
      const call = daytonaCalls.create.mock.calls[0]?.[0] as {
        envVars?: Record<string, string>;
      };
      expect(call.envVars).toEqual({
        CLAUDE_CODE_OAUTH_TOKEN: "tok-abc",
        FOO: "bar",
      });
    });

    it("omits envVars entirely when spec.env is absent", async () => {
      daytonaCalls.create.mockResolvedValue(
        fakeSandbox({ id: "sb-noenv", state: SandboxState.STARTED }),
      );
      const client = await makeClient();
      await client.create(BASE_SPEC);
      const call = daytonaCalls.create.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(call).not.toHaveProperty("envVars");
    });

    it("omits envVars when spec.env is an empty object", async () => {
      daytonaCalls.create.mockResolvedValue(
        fakeSandbox({ id: "sb-empty", state: SandboxState.STARTED }),
      );
      const client = await makeClient();
      await client.create({ ...BASE_SPEC, env: {} });
      const call = daytonaCalls.create.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(call).not.toHaveProperty("envVars");
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

    it("clones via SDK git.clone when worktree.type is 'git-remote'", async () => {
      const sb = fakeSandbox({ id: "sb-git", state: SandboxState.STARTED });
      daytonaCalls.create.mockResolvedValue(sb);
      const client = await makeClient();

      await client.create({
        ...BASE_SPEC,
        worktree: {
          type: "git-remote",
          url: "https://github.com/cogmo/example.git",
          branch: "cogmo/run/019d0000-0000-7000-8000-000000000aaa",
          auth: { username: "x-access-token", password: "ghp_test_pat" },
        },
      });

      // Sandbox-relative `/workspace` matches the bind-mount path
      // Local-Docker uses, so the verify orchestrator's
      // `WORKTREE_DIR_IN_CONTAINER` works on either backend unchanged.
      expect(sb.__spies.gitClone).toHaveBeenCalledTimes(1);
      expect(sb.__spies.gitClone).toHaveBeenCalledWith(
        "https://github.com/cogmo/example.git",
        "/workspace",
        "cogmo/run/019d0000-0000-7000-8000-000000000aaa",
        undefined,
        "x-access-token",
        "ghp_test_pat",
      );
    });

    it("uploads askpass + applies modes when spec.askpass is set", async () => {
      const sb = fakeSandbox({ id: "sb-ask", state: SandboxState.STARTED });
      daytonaCalls.create.mockResolvedValue(sb);

      const hostDir = mkdtempSync(join(tmpdir(), "cogmo-ask-client-"));
      try {
        writeFileSync(join(hostDir, "helper"), "#!/bin/sh\nexec /bin/cat /tmp/pat\n");
        writeFileSync(join(hostDir, "pat"), "ghp_test_pat");
        writeFileSync(join(hostDir, "signing-key"), "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n");
        writeFileSync(join(hostDir, "signing-key.pub"), "ssh-ed25519 AAAA... cogmo-bot\n");

        const client = await makeClient();
        await client.create({
          ...BASE_SPEC,
          askpass: { hostDir, containerDir: "/tmp/cogmo-askpass" },
        });

        expect(sb.__spies.fsUploadFiles).toHaveBeenCalledTimes(1);
        // Detailed mode/contents assertions live in askpass-upload.test.ts;
        // here we just confirm the integration fires.
        expect(sb.__spies.fsSetFilePermissions).toHaveBeenCalledTimes(4);
      } finally {
        rmSync(hostDir, { recursive: true, force: true });
      }
    });

    it("rolls back via sdk delete() when post-create clone fails", async () => {
      const sb = fakeSandbox({ id: "sb-fail", state: SandboxState.STARTED });
      sb.__spies.gitClone.mockRejectedValue(new Error("clone forbidden"));
      daytonaCalls.create.mockResolvedValue(sb);
      const client = await makeClient();

      await expect(
        client.create({
          ...BASE_SPEC,
          worktree: {
            type: "git-remote",
            url: "https://github.com/cogmo/example.git",
            branch: "cogmo/run/x",
            auth: { username: "x-access-token", password: "bad" },
          },
        }),
      ).rejects.toThrow(/clone forbidden/);
      // Without the rollback the freshly-billed sandbox would orphan
      // until the (Phase 3c) reaper picks it up — expensive on a
      // per-sandbox-billing provider.
      expect(sb.__spies.delete).toHaveBeenCalledTimes(1);
    });

    it("rolls back when fs.setFilePermissions fails mid-upload", async () => {
      const sb = fakeSandbox({ id: "sb-perm-fail", state: SandboxState.STARTED });
      sb.__spies.fsSetFilePermissions.mockRejectedValue(new Error("perm denied"));
      daytonaCalls.create.mockResolvedValue(sb);

      const hostDir = mkdtempSync(join(tmpdir(), "cogmo-perm-fail-"));
      try {
        writeFileSync(join(hostDir, "helper"), "#!/bin/sh\nexec /bin/cat /tmp/pat\n");
        writeFileSync(join(hostDir, "pat"), "ghp_x");
        writeFileSync(join(hostDir, "signing-key"), "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n");
        writeFileSync(join(hostDir, "signing-key.pub"), "ssh-ed25519 AAAA... cogmo-bot\n");

        const client = await makeClient();
        await expect(
          client.create({
            ...BASE_SPEC,
            askpass: { hostDir, containerDir: "/tmp/cogmo-askpass" },
          }),
        ).rejects.toThrow(/perm denied/);
        // 600 on signing-key is non-negotiable for ssh-keygen -Y sign;
        // a setFilePermissions failure is the same provisioning hazard
        // as a clone failure and rolls back identically.
        expect(sb.__spies.delete).toHaveBeenCalledTimes(1);
      } finally {
        rmSync(hostDir, { recursive: true, force: true });
      }
    });

    it("provisions both askpass and git-remote when both are set", async () => {
      const sb = fakeSandbox({ id: "sb-both", state: SandboxState.STARTED });
      daytonaCalls.create.mockResolvedValue(sb);

      const hostDir = mkdtempSync(join(tmpdir(), "cogmo-both-"));
      try {
        writeFileSync(join(hostDir, "helper"), "#!/bin/sh\nexec /bin/cat /tmp/pat\n");
        writeFileSync(join(hostDir, "pat"), "ghp_combined");
        writeFileSync(join(hostDir, "signing-key"), "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n");
        writeFileSync(join(hostDir, "signing-key.pub"), "ssh-ed25519 AAAA... cogmo-bot\n");

        const client = await makeClient();
        const session = await client.create({
          ...BASE_SPEC,
          worktree: {
            type: "git-remote",
            url: "https://github.com/cogmo/example.git",
            branch: "cogmo/run/combined",
            auth: { username: "x-access-token", password: "ghp_combined" },
          },
          askpass: { hostDir, containerDir: "/tmp/cogmo-askpass" },
        });

        // Production shape (3b.2 coding pipeline) sets both — this
        // catches a regression that would otherwise only surface end-to-end.
        expect(sb.__spies.fsUploadFiles).toHaveBeenCalledTimes(1);
        expect(sb.__spies.gitClone).toHaveBeenCalledTimes(1);
        expect(sb.__spies.delete).not.toHaveBeenCalled();
        expect(session.state.sandboxId).toBe("sb-both");
      } finally {
        rmSync(hostDir, { recursive: true, force: true });
      }
    });

    it("does not propagate teardown errors during rollback — original cause survives", async () => {
      const sb = fakeSandbox({ id: "sb-tear-fail", state: SandboxState.STARTED });
      sb.__spies.gitClone.mockRejectedValue(new Error("clone forbidden"));
      sb.__spies.delete.mockRejectedValue(new Error("teardown 503"));
      daytonaCalls.create.mockResolvedValue(sb);
      const client = await makeClient();

      // Caller sees the ROOT cause (clone forbidden), not the teardown
      // failure — otherwise an alert chain triggered by "teardown 503"
      // would mask the original auth misconfig that started it.
      await expect(
        client.create({
          ...BASE_SPEC,
          worktree: {
            type: "git-remote",
            url: "https://github.com/cogmo/example.git",
            branch: "cogmo/run/x",
            auth: { username: "x-access-token", password: "bad" },
          },
        }),
      ).rejects.toThrow(/clone forbidden/);
      expect(sb.__spies.delete).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        "host-path worktree",
        {
          worktree: { type: "host-path", hostPath: "/tmp/wt" },
        } as Partial<SessionSpec>,
        /git-remote/,
      ],
      ["homeVolume", { homeVolume: { volumeName: "v" } } as Partial<SessionSpec>, /auto-persists/],
      [
        "allowPrivilegedRunc",
        { allowPrivilegedRunc: true } as Partial<SessionSpec>,
        /Local-Docker-specific/,
      ],
    ])("rejects %s as backend-incompatible", async (_label, override, msg) => {
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

    it("survives two concurrent calls for the same taskId (both return, both start() tolerated)", async () => {
      // Race window: get-or-create-session retry collides with the
      // reaper's reconcile pass, or two orchestrator step.run replays
      // fire on the same taskId. Daytona's `list()` returns handles
      // pointing at the same server-side sandbox; both callers see
      // `state === STOPPED` in their snapshot before either start()
      // flips it server-side. The SDK treats start() on an
      // already-started sandbox as a no-op — this test pins that
      // contract from Cogmo's side and exercises the wrap path
      // returning consistent state both times.
      const sb = fakeSandbox({ id: "sb-stopped", state: SandboxState.STOPPED });
      // Override the default start() with a microtask-deferred body so
      // both concurrent callers see `state === STOPPED` on their list
      // snapshot before either start() flips it. Mirrors real SDK
      // semantics: `list()` returns a stale view, `start()` mutates
      // server-side state asynchronously.
      sb.start = vi.fn(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        sb.state = SandboxState.STARTED;
      });
      daytonaCalls.list.mockResolvedValue({
        items: [sb],
        totalPages: 1,
        currentPage: 1,
        totalItems: 1,
        itemsPerPage: 50,
      });
      const client = await makeClient();
      const [aMaybe, bMaybe] = await Promise.all([
        client.tryResumeByTaskId("t1"),
        client.tryResumeByTaskId("t1"),
      ]);
      const a = expectDefined(aMaybe, "first concurrent tryResumeByTaskId");
      const b = expectDefined(bMaybe, "second concurrent tryResumeByTaskId");
      expect(a.state.sandboxId).toBe("sb-stopped");
      expect(b.state.sandboxId).toBe("sb-stopped");
      // Both callers saw STOPPED in their copy of the list result and
      // each fired their own start(); the second is a no-op upstream
      // but the client doesn't dedupe, by design — list() snapshots
      // are stale by the time we act on them and re-checking would
      // burn another HTTP roundtrip with no upside.
      expect(sb.start).toHaveBeenCalledTimes(2);
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
        // 10-minute deadline + 5-min KEEPALIVE_INTERVAL_MS:
        //   - t=5: within deadline → fires.
        //   - t=10: AT deadline (`Date.now() >= expiresAtMs`) →
        //          self-stops without firing.
        //   - t=15+: ticker is gone.
        await client.create({ ...BASE_SPEC, expiresAt: new Date(Date.now() + 10 * 60_000) });

        // t=5: within deadline → fires.
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(sb.refreshActivity).toHaveBeenCalledTimes(1);

        // t=10: at deadline → self-stops, no fire.
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(sb.refreshActivity).toHaveBeenCalledTimes(1);

        // t=15+: ticker already cleared.
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(sb.refreshActivity).toHaveBeenCalledTimes(1);
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
      // keepalive cleanup by `sandboxId`, the in-process ticker would
      // leak.
      //
      // Asserted via fake timers: confirm the ticker fires once before
      // delete, then advance time past several intervals AFTER delete
      // and assert it does NOT fire again. Crucially, we never call
      // `shutdown()` before the assertion — `shutdown()` itself
      // iterates `#keepalives` and would clear a leaked timer,
      // masking a broken `delete(session)`.
      vi.useFakeTimers();
      try {
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
        const session = await client.create({
          ...BASE_SPEC,
          expiresAt: new Date(Date.now() + 60 * 60_000),
        });

        // Baseline: keepalive is alive and firing.
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(sb.refreshActivity).toHaveBeenCalledTimes(1);

        // `delete(session)` must clear the timer even though the
        // cascade `daytona.list({task})` returns empty (provider-side
        // sandbox already gone).
        await client.delete(session);

        // Advance well past several intervals — refreshActivity must
        // NOT fire again. If `delete(session)` failed to stop the
        // timer by sandboxId, this would tick up to 7+.
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
        expect(sb.refreshActivity).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
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
        depsCacheSharing: "per-sandbox",
      });
    });
  });

  describe("ensureImagePresent (snapshot prewarm) + reconcileCrashedInstances", () => {
    it("skips warming for :latest tag (Daytona rejects it via snapshot.create)", async () => {
      const client = await makeClient();
      await client.ensureImagePresent("ghcr.io/iskhakovt/cogmo-devbase:latest");
      expect(daytonaCalls.snapshotGet).not.toHaveBeenCalled();
      expect(daytonaCalls.snapshotCreate).not.toHaveBeenCalled();
    });

    it("skips warming for untagged image (no version to pin)", async () => {
      const client = await makeClient();
      await client.ensureImagePresent("python");
      expect(daytonaCalls.snapshotGet).not.toHaveBeenCalled();
      expect(daytonaCalls.snapshotCreate).not.toHaveBeenCalled();
    });

    it("snapshot already ACTIVE → no create call", async () => {
      daytonaCalls.snapshotGet.mockResolvedValue(
        fakeSnapshot({ name: DEVBASE_SNAPSHOT, state: SnapshotState.ACTIVE }),
      );
      const client = await makeClient();
      await client.ensureImagePresent("ghcr.io/iskhakovt/cogmo-devbase:1.66.0");
      expect(daytonaCalls.snapshotGet).toHaveBeenCalledWith(DEVBASE_SNAPSHOT);
      expect(daytonaCalls.snapshotCreate).not.toHaveBeenCalled();
    });

    it("snapshot missing (404) → snapshot.create fires with derived name + image", async () => {
      daytonaCalls.snapshotGet.mockRejectedValue(new DaytonaNotFoundError("not found"));
      daytonaCalls.snapshotCreate.mockResolvedValue(
        fakeSnapshot({ name: DEVBASE_SNAPSHOT, state: SnapshotState.ACTIVE }),
      );
      const client = await makeClient();
      await client.ensureImagePresent("ghcr.io/iskhakovt/cogmo-devbase:1.66.0");
      expect(daytonaCalls.snapshotCreate).toHaveBeenCalledWith({
        name: DEVBASE_SNAPSHOT,
        image: "ghcr.io/iskhakovt/cogmo-devbase:1.66.0",
      });
    });

    it("bakes resourceLimits into snapshot.create so post-warm sessions inherit them", async () => {
      // `daytona.create({ snapshot })` has no per-session resources
      // override — the snapshot's baked CPU/memory/disk govern every
      // session spun from it. Skipping the resources hint here would
      // erase the consumer's intent (notably skills' 1 GiB disk),
      // because once the snapshot is ACTIVE every subsequent task
      // inherits Daytona's platform default (1 cpu / 1 GiB / 3 GiB).
      daytonaCalls.snapshotGet.mockRejectedValue(new DaytonaNotFoundError("not found"));
      daytonaCalls.snapshotCreate.mockResolvedValue(
        fakeSnapshot({ name: PYTHON_SNAPSHOT, state: SnapshotState.ACTIVE }),
      );
      const client = await makeClient();
      await client.ensureImagePresent(PYTHON_IMAGE, {
        cpus: 1,
        memory_bytes: 512 * 1024 * 1024,
        pids: 1024,
        disk_bytes: 1024 * 1024 * 1024,
      });
      expect(daytonaCalls.snapshotCreate).toHaveBeenCalledWith({
        name: PYTHON_SNAPSHOT,
        image: PYTHON_IMAGE,
        resources: { cpu: 1, memory: 1, disk: 1 },
      });
    });

    it("omits resources when ensureImagePresent is called without a hint (accepts platform default)", async () => {
      // No-arg call should not silently fabricate resources — the
      // overload exists so the lazy `{ image }` fallback in `create()`
      // can take the platform default explicitly. Tested separately so
      // the contract is visible in the matrix.
      daytonaCalls.snapshotGet.mockRejectedValue(new DaytonaNotFoundError("not found"));
      daytonaCalls.snapshotCreate.mockResolvedValue(
        fakeSnapshot({ name: DEVBASE_SNAPSHOT, state: SnapshotState.ACTIVE }),
      );
      const client = await makeClient();
      await client.ensureImagePresent("ghcr.io/iskhakovt/cogmo-devbase:1.66.0");
      const createArg = daytonaCalls.snapshotCreate.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(createArg).not.toHaveProperty("resources");
    });

    it("snapshot in BUILDING → polls until ACTIVE, no extra create call", async () => {
      // Models another cogmo instance (or a prior boot of this one)
      // racing the warm. `snapshot.get` initially returns BUILDING; the
      // poll cadence reads it again and observes the transition to
      // ACTIVE. We must NOT call `snapshot.create` ourselves in this
      // path — the in-flight build owns the name.
      vi.useFakeTimers();
      try {
        daytonaCalls.snapshotGet
          .mockResolvedValueOnce(
            fakeSnapshot({ name: DEVBASE_SNAPSHOT, state: SnapshotState.BUILDING }),
          )
          .mockResolvedValueOnce(
            fakeSnapshot({ name: DEVBASE_SNAPSHOT, state: SnapshotState.BUILDING }),
          )
          .mockResolvedValue(fakeSnapshot({ name: DEVBASE_SNAPSHOT, state: SnapshotState.ACTIVE }));
        const client = await makeClient();
        const warm = client.ensureImagePresent("ghcr.io/iskhakovt/cogmo-devbase:1.66.0");
        // Two poll cycles to land on ACTIVE — the SDK polls at 1s.
        await vi.advanceTimersByTimeAsync(2_500);
        await warm;
        expect(daytonaCalls.snapshotCreate).not.toHaveBeenCalled();
        expect(daytonaCalls.snapshotGet.mock.calls.length).toBeGreaterThanOrEqual(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("poll exits on unknown-non-inflight state (INACTIVE) → delete + recreate, no infinite loop", async () => {
      // Regression for gemini-code-assist PR #275 finding: the poll
      // loop must treat any state outside the documented in-flight set
      // (BUILDING / PENDING / PULLING) as terminal-from-our-perspective.
      // INACTIVE is the canonical non-{terminal-success, terminal-fail,
      // in-flight} state — if the loop misses it, warm hangs forever.
      // Reaching this branch: initial `get` returns BUILDING (enters
      // poll), then poll's next `get` returns INACTIVE (exits poll),
      // then the caller deletes + recreates.
      vi.useFakeTimers();
      try {
        daytonaCalls.snapshotGet
          .mockResolvedValueOnce(
            fakeSnapshot({ name: DEVBASE_SNAPSHOT, state: SnapshotState.BUILDING }),
          )
          .mockResolvedValueOnce(
            fakeSnapshot({ name: DEVBASE_SNAPSHOT, state: SnapshotState.INACTIVE }),
          );
        daytonaCalls.snapshotDelete.mockResolvedValue();
        daytonaCalls.snapshotCreate.mockResolvedValue(
          fakeSnapshot({ name: DEVBASE_SNAPSHOT, state: SnapshotState.ACTIVE }),
        );
        const client = await makeClient();
        const warm = client.ensureImagePresent("ghcr.io/iskhakovt/cogmo-devbase:1.66.0");
        await vi.advanceTimersByTimeAsync(2_500);
        await warm;
        expect(daytonaCalls.snapshotDelete).toHaveBeenCalledTimes(1);
        expect(daytonaCalls.snapshotCreate).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("snapshot in failure state (BUILD_FAILED) → delete + recreate under a fresh name", async () => {
      const stale = fakeSnapshot({
        name: DEVBASE_SNAPSHOT,
        state: SnapshotState.BUILD_FAILED,
      });
      daytonaCalls.snapshotGet.mockResolvedValue(stale);
      daytonaCalls.snapshotDelete.mockResolvedValue();
      daytonaCalls.snapshotCreate.mockImplementation(async (arg: unknown) => {
        const { name } = arg as { name: string };
        return fakeSnapshot({ name, state: SnapshotState.ACTIVE });
      });
      daytonaCalls.create.mockResolvedValue(
        fakeSandbox({ id: "sb-rebuilt", state: SandboxState.STARTED }),
      );

      const client = await makeClient();
      await client.ensureImagePresent("ghcr.io/iskhakovt/cogmo-devbase:1.66.0");
      // Delete fires for the stale row; we never wait on it. Create
      // dispatches against a freshly-suffixed name — `<original>-r-<hex>`
      // — so a subsequent create can't race Daytona's async REMOVING
      // state on the original.
      expect(daytonaCalls.snapshotDelete).toHaveBeenCalledWith(stale);
      expect(daytonaCalls.snapshotCreate).toHaveBeenCalledTimes(1);
      const createArg = daytonaCalls.snapshotCreate.mock.calls[0]?.[0] as { name: string };
      expect(createArg.name).toMatch(new RegExp(`^${DEVBASE_SNAPSHOT}-r-[0-9a-f]{8}$`));
      expect(createArg.name).not.toBe(DEVBASE_SNAPSHOT);

      // The cache must hold the resolved (rebuilt) name, not the
      // original — otherwise the follow-up `create()` would dispatch
      // against a snapshot that doesn't exist.
      await client.create({ ...BASE_SPEC, image: "ghcr.io/iskhakovt/cogmo-devbase:1.66.0" });
      const sandboxArg = daytonaCalls.create.mock.calls[0]?.[0] as { snapshot?: string };
      expect(sandboxArg.snapshot).toBe(createArg.name);
    });

    it("rebuild proceeds even if the stale delete fails (fire-and-forget)", async () => {
      // Models Daytona's documented behaviour: delete can fail or hang
      // while the row sits in REMOVING. The warm path must NOT block on
      // it — the rebuild uses a fresh name, so the stale row's eventual
      // disposition is irrelevant.
      const stale = fakeSnapshot({
        name: DEVBASE_SNAPSHOT,
        state: SnapshotState.BUILD_FAILED,
      });
      daytonaCalls.snapshotGet.mockResolvedValue(stale);
      daytonaCalls.snapshotDelete.mockRejectedValue(new Error("REMOVING — please retry"));
      daytonaCalls.snapshotCreate.mockImplementation(async (arg: unknown) => {
        const { name } = arg as { name: string };
        return fakeSnapshot({ name, state: SnapshotState.ACTIVE });
      });

      // Spy on the warn log the fire-and-forget catch fires. Asserting
      // on it via `vi.waitFor` is sturdier than draining a `setImmediate`
      // tick: it actively waits for the catch to attach + run, instead
      // of hoping the microtask queue's ordering matches our drain.
      const warnSpy = vi.spyOn(logger, "warn");
      try {
        const client = await makeClient();
        await client.ensureImagePresent("ghcr.io/iskhakovt/cogmo-devbase:1.66.0");
        expect(daytonaCalls.snapshotCreate).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => {
          expect(warnSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              snapshot: DEVBASE_SNAPSHOT,
              staleState: SnapshotState.BUILD_FAILED,
            }),
            "background delete of stale snapshot failed — Daytona reaper will retry",
          );
        });
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("retries snapshot.create on transient 'repository … not found' daemon error", async () => {
      // Models the Daytona-side builder pipeline race where the internal
      // registry hasn't pre-provisioned the per-snapshot repo before
      // push. The error surfaces as `unprocessable entity: Error response
      // from daemon: unknown: repository sbox/daytona-<sha256> not
      // found`. Transient — typically clears in 1-2s.
      vi.useFakeTimers();
      try {
        daytonaCalls.snapshotGet.mockRejectedValue(new DaytonaNotFoundError("not found"));
        const transient = new Error(
          "unprocessable entity: Error response from daemon: unknown: repository sbox/daytona-abc123 not found",
        );
        daytonaCalls.snapshotCreate
          .mockRejectedValueOnce(transient)
          .mockResolvedValueOnce(
            fakeSnapshot({ name: DEVBASE_SNAPSHOT, state: SnapshotState.ACTIVE }),
          );

        const client = await makeClient();
        const warm = client.ensureImagePresent("ghcr.io/iskhakovt/cogmo-devbase:1.66.0");
        // Drive p-retry's setTimeout through its 1s base backoff (+ up
        // to 1s jitter via `randomize: true` in `withRetry`).
        await vi.advanceTimersByTimeAsync(3_000);
        await warm;
        expect(daytonaCalls.snapshotCreate).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("recovers from snapshot.create 409 (stale-stub conflict) by rebuilding under a fresh name", async () => {
      // Daytona's snapshot builder occasionally leaks a stub when
      // `withRetry` re-attempts `snapshot.create` after the "repository
      // … not found" transient — attempt 0 leaves a stub server-side,
      // attempt 1 then hits 409 on the same name. The 409 propagates
      // out of `withRetry` (pRetry classifies it as non-retryable),
      // which was the v2.1.0 first-task-after-deploy failure mode. The
      // `#buildWithConflictRecovery` wrapper catches it and rebuilds
      // once under `<name>-r-<hex>`. Two `snapshot.create` calls total:
      // the original-name attempt that 409s, and the rebuild-name
      // attempt that lands ACTIVE.
      daytonaCalls.snapshotGet.mockRejectedValue(new DaytonaNotFoundError("not found"));
      const conflict = new DaytonaConflictError(
        `Snapshot with name "${DEVBASE_SNAPSHOT}" already exists for this organization`,
      );
      daytonaCalls.snapshotCreate
        .mockRejectedValueOnce(conflict)
        .mockImplementation(async (arg: unknown) => {
          const { name } = arg as { name: string };
          return fakeSnapshot({ name, state: SnapshotState.ACTIVE });
        });

      const client = await makeClient();
      await client.ensureImagePresent("ghcr.io/iskhakovt/cogmo-devbase:1.66.0");

      expect(daytonaCalls.snapshotCreate).toHaveBeenCalledTimes(2);
      const firstArg = daytonaCalls.snapshotCreate.mock.calls[0]?.[0] as { name: string };
      const secondArg = daytonaCalls.snapshotCreate.mock.calls[1]?.[0] as { name: string };
      expect(firstArg.name).toBe(DEVBASE_SNAPSHOT);
      expect(secondArg.name).toMatch(new RegExp(`^${DEVBASE_SNAPSHOT}-r-[0-9a-f]{8}$`));
    });

    it("does NOT retry snapshot.create on persistent (non-matching) errors", async () => {
      // A real image-build failure (broken Dockerfile, missing upstream
      // image, auth) doesn't match the transient signature and must
      // surface immediately — burning the retry budget on a persistent
      // failure just delays the user-visible error.
      daytonaCalls.snapshotGet.mockRejectedValue(new DaytonaNotFoundError("not found"));
      daytonaCalls.snapshotCreate.mockRejectedValue(new Error("invalid Dockerfile syntax"));

      const client = await makeClient();
      await expect(
        client.ensureImagePresent("ghcr.io/iskhakovt/cogmo-devbase:1.66.0"),
      ).rejects.toThrow(/invalid Dockerfile/);
      expect(daytonaCalls.snapshotCreate).toHaveBeenCalledTimes(1);
    });

    it("warns when a second ensureImagePresent call requests resourceLimits that differ from the cached bake", async () => {
      // Snapshot resources are immutable post-create; a second caller
      // can't get different limits without rebuilding. Drift is rare at
      // single-user scale but the warn makes it operationally visible
      // when it happens.
      daytonaCalls.snapshotGet.mockRejectedValue(new DaytonaNotFoundError("not found"));
      daytonaCalls.snapshotCreate.mockResolvedValue(
        fakeSnapshot({ name: PYTHON_SNAPSHOT, state: SnapshotState.ACTIVE }),
      );
      const warnSpy = vi.spyOn(logger, "warn");
      try {
        const client = await makeClient();
        const limitsA = { cpus: 1, memory_bytes: 512 * 1024 * 1024, pids: 256 };
        const limitsB = { cpus: 2, memory_bytes: 2 * 1024 * 1024 * 1024, pids: 256 };
        await client.ensureImagePresent(PYTHON_IMAGE, limitsA);
        await client.ensureImagePresent(PYTHON_IMAGE, limitsB);
        expect(daytonaCalls.snapshotCreate).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({ image: PYTHON_IMAGE, cached: limitsA, requested: limitsB }),
          expect.stringContaining("resourceLimits differ from prior warm"),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("does NOT warn when the same limits are passed twice", async () => {
      // The matching case is the common path (boot → task-time uses
      // identical limits). A warn here would spam the logs on every
      // task arrival.
      daytonaCalls.snapshotGet.mockRejectedValue(new DaytonaNotFoundError("not found"));
      daytonaCalls.snapshotCreate.mockResolvedValue(
        fakeSnapshot({ name: PYTHON_SNAPSHOT, state: SnapshotState.ACTIVE }),
      );
      const warnSpy = vi.spyOn(logger, "warn");
      try {
        const client = await makeClient();
        const limits = { cpus: 1, memory_bytes: 512 * 1024 * 1024, pids: 256 };
        await client.ensureImagePresent(PYTHON_IMAGE, limits);
        await client.ensureImagePresent(PYTHON_IMAGE, { ...limits });
        expect(warnSpy).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.stringContaining("resourceLimits differ"),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("exhausts the retry budget under a sustained transient signature (not infinite)", async () => {
      // Pins that the retry budget is finite (3 retries + initial = 4
      // attempts). Without this assertion, a regression that changes
      // the budget to "infinite" — or a predicate edit that flips
      // the SDK's own retry into our envelope — would not be caught
      // by the existing "retries once then succeeds" matrix.
      vi.useFakeTimers();
      try {
        daytonaCalls.snapshotGet.mockRejectedValue(new DaytonaNotFoundError("not found"));
        daytonaCalls.snapshotCreate.mockRejectedValue(
          new Error(
            "unprocessable entity: Error response from daemon: unknown: repository sbox/daytona-xyz not found",
          ),
        );

        const client = await makeClient();
        const warm = client.ensureImagePresent("ghcr.io/iskhakovt/cogmo-devbase:1.66.0");
        // Capture the rejection up front so vitest's unhandled-rejection
        // tracker doesn't flag it during the timer-advance window.
        const captured = warm.catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(20_000);
        const err = await captured;
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/repository sbox/);
        // 1 initial + 3 retries = 4 calls.
        expect(daytonaCalls.snapshotCreate).toHaveBeenCalledTimes(4);
      } finally {
        vi.useRealTimers();
      }
    });

    it("concurrent callers share one warm cycle", async () => {
      let resolveCreate: (value: DaytonaSnapshot) => void = () => {};
      const createGate = new Promise<DaytonaSnapshot>((resolve) => {
        resolveCreate = resolve;
      });
      daytonaCalls.snapshotGet.mockRejectedValue(new DaytonaNotFoundError("not found"));
      daytonaCalls.snapshotCreate.mockReturnValue(createGate);

      const client = await makeClient();
      const a = client.ensureImagePresent("ghcr.io/iskhakovt/cogmo-devbase:1.66.0");
      const b = client.ensureImagePresent("ghcr.io/iskhakovt/cogmo-devbase:1.66.0");
      resolveCreate(fakeSnapshot({ name: DEVBASE_SNAPSHOT, state: SnapshotState.ACTIVE }));
      await Promise.all([a, b]);
      // First call kicks off the cycle; the second observes the same
      // in-flight promise via the per-image memoisation, so only one
      // create call fires for both awaits.
      expect(daytonaCalls.snapshotCreate).toHaveBeenCalledTimes(1);
    });

    it("failed warm is evicted from cache — next call retries", async () => {
      daytonaCalls.snapshotGet.mockRejectedValue(new DaytonaNotFoundError("not found"));
      daytonaCalls.snapshotCreate
        .mockRejectedValueOnce(new Error("provider 5xx"))
        .mockResolvedValueOnce(
          fakeSnapshot({ name: DEVBASE_SNAPSHOT, state: SnapshotState.ACTIVE }),
        );
      const client = await makeClient();
      await expect(
        client.ensureImagePresent("ghcr.io/iskhakovt/cogmo-devbase:1.66.0"),
      ).rejects.toThrow(/provider 5xx/);
      // Second call must observe a fresh start, NOT a cached rejected
      // promise. Without the eviction, this would re-throw the prior
      // failure without retrying.
      await client.ensureImagePresent("ghcr.io/iskhakovt/cogmo-devbase:1.66.0");
      expect(daytonaCalls.snapshotCreate).toHaveBeenCalledTimes(2);
    });

    it("after ensureImagePresent succeeds, create() uses snapshot reference", async () => {
      daytonaCalls.snapshotGet.mockRejectedValue(new DaytonaNotFoundError("not found"));
      daytonaCalls.snapshotCreate.mockResolvedValue(
        fakeSnapshot({ name: PYTHON_SNAPSHOT, state: SnapshotState.ACTIVE }),
      );
      daytonaCalls.create.mockResolvedValue(
        fakeSandbox({ id: "sb-snap", state: SandboxState.STARTED }),
      );
      const client = await makeClient();
      await client.ensureImagePresent("python:3.14-slim");
      await client.create(BASE_SPEC);
      const call = daytonaCalls.create.mock.calls[0]?.[0] as {
        snapshot?: string;
        image?: string;
        resources?: unknown;
      };
      expect(call.snapshot).toBe(PYTHON_SNAPSHOT);
      expect(call.image).toBeUndefined();
      // Resources are baked into the snapshot — `CreateSandboxFromSnapshotParams`
      // has no `resources` field. Don't pass one or the SDK type would reject.
      expect(call.resources).toBeUndefined();
    });

    it("without ensureImagePresent, create() falls back to image + resources", async () => {
      daytonaCalls.create.mockResolvedValue(
        fakeSandbox({ id: "sb-img", state: SandboxState.STARTED }),
      );
      const client = await makeClient();
      await client.create(BASE_SPEC);
      const call = daytonaCalls.create.mock.calls[0]?.[0] as {
        snapshot?: string;
        image?: string;
        resources?: { cpu: number };
      };
      expect(call.image).toBe(BASE_SPEC.image);
      expect(call.snapshot).toBeUndefined();
      expect(call.resources?.cpu).toBe(1);
    });

    it("snapshot deleted server-side → create({ snapshot }) NotFound → fallback to image + cache eviction", async () => {
      // Models the post-warm "snapshot was deleted from the Daytona
      // dashboard / GC cron" path. Without the fallback, every
      // subsequent task in this process would error with NotFound.
      daytonaCalls.snapshotGet.mockRejectedValue(new DaytonaNotFoundError("not found"));
      daytonaCalls.snapshotCreate.mockResolvedValue(
        fakeSnapshot({ name: PYTHON_SNAPSHOT, state: SnapshotState.ACTIVE }),
      );
      // First sandbox create attempt (snapshot path) → NotFound.
      // Fallback attempt (image path) → success.
      daytonaCalls.create
        .mockRejectedValueOnce(new DaytonaNotFoundError("snapshot not found"))
        .mockResolvedValueOnce(fakeSandbox({ id: "sb-fallback", state: SandboxState.STARTED }));

      const client = await makeClient();
      await client.ensureImagePresent(PYTHON_IMAGE);
      // First create exercises the snapshot path with the cached name.
      const session = await client.create({ ...BASE_SPEC, image: PYTHON_IMAGE });
      expect(session.state.sandboxId).toBe("sb-fallback");
      expect(daytonaCalls.create).toHaveBeenCalledTimes(2);
      // First call: snapshot reference.
      expect(daytonaCalls.create.mock.calls[0]?.[0]).toMatchObject({
        snapshot: PYTHON_SNAPSHOT,
      });
      // Second call: image fallback.
      expect(daytonaCalls.create.mock.calls[1]?.[0]).toMatchObject({
        image: PYTHON_IMAGE,
      });
    });

    it("NotFound fallback re-warms with the spec's resourceLimits (regression: re-warm must not bake platform default)", async () => {
      // The fallback fires a background `ensureImagePresent` to
      // re-bake the snapshot. Earlier this path passed no
      // `resourceLimits`, baking Daytona's platform default and
      // silently undoing the consumer's intent on every subsequent
      // session.
      daytonaCalls.snapshotGet.mockRejectedValue(new DaytonaNotFoundError("not found"));
      daytonaCalls.snapshotCreate.mockImplementation(async (arg: unknown) => {
        const { name } = arg as { name: string };
        return fakeSnapshot({ name, state: SnapshotState.ACTIVE });
      });
      daytonaCalls.create
        .mockRejectedValueOnce(new DaytonaNotFoundError("snapshot not found"))
        .mockResolvedValueOnce(fakeSandbox({ id: "sb-rewarm", state: SandboxState.STARTED }));

      const customLimits = {
        cpus: 1,
        memory_bytes: 512 * 1024 * 1024,
        pids: 1024,
        disk_bytes: 1024 * 1024 * 1024,
      };
      const client = await makeClient();
      await client.ensureImagePresent(PYTHON_IMAGE, customLimits);
      // Triggers the NotFound → fallback path with `spec.resourceLimits`
      // pulled from BASE_SPEC's defaults — but the limits the re-warm
      // bakes must come from spec, not the original ensureImagePresent
      // call.
      const specLimits = {
        cpus: 4,
        memory_bytes: 4 * 1024 * 1024 * 1024,
        pids: 512,
      };
      await client.create({
        ...BASE_SPEC,
        image: PYTHON_IMAGE,
        resourceLimits: specLimits,
      });

      // Drain the background re-warm microtask. The re-warm fires via
      // `void ensureImagePresent(...)`; its `snapshot.create` call has
      // to land before we can assert on the resources argument.
      await vi.waitFor(() => {
        expect(daytonaCalls.snapshotCreate).toHaveBeenCalledTimes(2);
      });
      // The first warm baked the customLimits the test provided;
      // the second (re-warm) bakes spec.resourceLimits = specLimits.
      const firstCreate = daytonaCalls.snapshotCreate.mock.calls[0]?.[0] as {
        resources: { cpu: number; memory: number; disk?: number };
      };
      expect(firstCreate.resources).toEqual({ cpu: 1, memory: 1, disk: 1 });
      const secondCreate = daytonaCalls.snapshotCreate.mock.calls[1]?.[0] as {
        resources: { cpu: number; memory: number };
      };
      expect(secondCreate.resources).toEqual({ cpu: 4, memory: 4 });
    });

    it("snapshot path: non-NotFound errors do NOT fall back (auth / rate-limit / connection re-throw)", async () => {
      daytonaCalls.snapshotGet.mockRejectedValue(new DaytonaNotFoundError("not found"));
      daytonaCalls.snapshotCreate.mockResolvedValue(
        fakeSnapshot({ name: PYTHON_SNAPSHOT, state: SnapshotState.ACTIVE }),
      );
      // Generic Error (auth / rate-limit / connection) must propagate —
      // silently falling back would mask outages.
      daytonaCalls.create.mockRejectedValue(new Error("rate limit exceeded"));

      const client = await makeClient();
      await client.ensureImagePresent(PYTHON_IMAGE);
      await expect(client.create({ ...BASE_SPEC, image: PYTHON_IMAGE })).rejects.toThrow(
        /rate limit exceeded/,
      );
      // No fallback attempt.
      expect(daytonaCalls.create).toHaveBeenCalledTimes(1);
    });

    it("reconcileCrashedInstances reports zero (provider auto-cleanup)", async () => {
      const client = await makeClient();
      const result = await client.reconcileCrashedInstances("instance-1");
      expect(result).toEqual({ orphansReaped: 0 });
    });
  });

  describe("FakeDaytonaSnapshotPipeline contract", () => {
    // Pins the fake's load-bearing invariant: a same-name recreate
    // against a snapshot in REMOVING 409s. If this assertion ever
    // weakens, the fake stops being a structural safety net for the
    // rename-on-rebuild bug class, and the tests below would pass
    // against the original buggy code path they exist to catch.
    it("rejects snapshot.create against a name currently in REMOVING with DaytonaConflictError", async () => {
      const pipeline = new FakeDaytonaSnapshotPipeline()
        .setState("stuck", "build_failed")
        .bindTo(daytonaCalls);
      // Simulate the OLD delete-then-create-same-name path manually,
      // bypassing the SUT, to prove the fake would have caught the
      // original bug regardless of what `#ensureSnapshotActive` thinks
      // it's doing.
      const existing = await daytonaCalls.snapshotGet("stuck");
      await daytonaCalls.snapshotDelete(existing);
      await expect(
        daytonaCalls.snapshotCreate({ name: "stuck", image: "any" }),
      ).rejects.toBeInstanceOf(DaytonaConflictError);
      expect(pipeline.state("stuck")).toBe("removing");
    });
  });

  describe("ensureImagePresent against stateful snapshot pipeline", () => {
    // These tests use `FakeDaytonaSnapshotPipeline` to model Daytona's
    // async snapshot lifecycle — `REMOVING`-state drain, `BUILDING` →
    // `ACTIVE` polling, conflict-on-same-name-recreate. The flat
    // `vi.fn().mockResolvedValue(...)` mocks above can't represent these
    // because they're stateless. The pipeline fake is the structural
    // mechanism that catches the original 409-on-rebuild bug class:
    // with a stateful model, `snapshot.create({ name: <existing> })`
    // throws `DaytonaConflictError` while the row is in `REMOVING`,
    // so any test that exercises rebuild-against-stale-name FAILS in
    // the fake regardless of what the SUT thinks it's doing.

    it("rebuild after BUILD_FAILED succeeds against a REMOVING-aware provider", async () => {
      // The load-bearing scenario: with delete-then-recreate against
      // the original name, this test would 409 (the fake models
      // Daytona's async REMOVING drain). With rename-on-rebuild, it
      // succeeds because the create dispatches against a fresh name.
      const pipeline = new FakeDaytonaSnapshotPipeline()
        .setState(DEVBASE_SNAPSHOT, "build_failed")
        .bindTo(daytonaCalls);
      // Drain the stale `REMOVING` row eventually — but slowly enough
      // that any same-name recreate during the drain window 409s.
      pipeline.scheduleTransition(DEVBASE_SNAPSHOT, { afterGets: 50, to: "absent" });

      const client = await makeClient();
      await client.ensureImagePresent("ghcr.io/iskhakovt/cogmo-devbase:1.66.0");

      // Exactly one create, and against a freshly-suffixed name.
      expect(daytonaCalls.snapshotCreate).toHaveBeenCalledTimes(1);
      expectCreatedNamesMatch(pipeline, [new RegExp(`^${DEVBASE_SNAPSHOT}-r-[0-9a-f]{8}$`)]);
    });

    it("transient builder error clears on retry; persistent error fails on the same name (no rename loop)", async () => {
      const pipeline = new FakeDaytonaSnapshotPipeline()
        .setState(DEVBASE_SNAPSHOT, "absent")
        .setCreateBehavior((_name, _image, attempt, { setState }) => {
          if (attempt === 1) {
            throw new Error(
              "unprocessable entity: Error response from daemon: unknown: repository sbox/daytona-xyz not found",
            );
          }
          setState("active");
        })
        .bindTo(daytonaCalls);

      vi.useFakeTimers();
      try {
        const client = await makeClient();
        const warm = client.ensureImagePresent("ghcr.io/iskhakovt/cogmo-devbase:1.66.0");
        await vi.advanceTimersByTimeAsync(3_000);
        await warm;
      } finally {
        vi.useRealTimers();
      }

      // Two attempts on the SAME name — retry doesn't trigger rename
      // (rename is a state-machine action, not a retry action).
      expect(daytonaCalls.snapshotCreate).toHaveBeenCalledTimes(2);
      expect(pipeline.attempts(DEVBASE_SNAPSHOT)).toBe(2);
      expect(pipeline.createdNames()).toEqual([DEVBASE_SNAPSHOT]);
    });

    it("BUILDING in flight → polling reaches ACTIVE via the same observed name", async () => {
      // Sanity-check the BUILDING → ACTIVE poll path through the fake.
      // Catches a regression where the pipeline-fake's transition
      // counter goes out of sync with the SUT's poll cadence.
      const pipeline = new FakeDaytonaSnapshotPipeline()
        .setState(DEVBASE_SNAPSHOT, "building")
        .scheduleTransition(DEVBASE_SNAPSHOT, { afterGets: 2, to: "active" })
        .bindTo(daytonaCalls);

      vi.useFakeTimers();
      try {
        const client = await makeClient();
        const warm = client.ensureImagePresent("ghcr.io/iskhakovt/cogmo-devbase:1.66.0");
        // Three poll ticks at the SDK's 1s cadence covers the
        // 2-observation drain plus the final ACTIVE read.
        await vi.advanceTimersByTimeAsync(3_500);
        await warm;
      } finally {
        vi.useRealTimers();
      }

      // No create — the in-flight build owned the name and reached ACTIVE.
      expect(daytonaCalls.snapshotCreate).not.toHaveBeenCalled();
      expect(pipeline.state(DEVBASE_SNAPSHOT)).toBe("active");
    });
  });

  describe("isTransientSnapshotCreateError (retry predicate)", () => {
    // The retry predicate is the gate between "retry, wait for the
    // flake to clear" and "fail fast, surface the error". Misclassifying
    // either side burns operator time — too aggressive retries an
    // unrecoverable failure for ~7s before surfacing; too conservative
    // drops a recoverable build into the user-visible error path.
    // Pin behavior per documented Daytona error class so any future
    // edit has to declare what the new policy is for each row.
    const cases: ReadonlyArray<{
      label: string;
      err: unknown;
      expected: boolean;
      reason: string;
    }> = [
      {
        label: "DaytonaAuthenticationError",
        err: new DaytonaAuthenticationError("invalid api key", 401),
        expected: false,
        reason: "bad key — won't clear on retry",
      },
      {
        label: "DaytonaAuthorizationError",
        err: new DaytonaAuthorizationError("forbidden", 403),
        expected: false,
        reason: "scope error — won't clear",
      },
      {
        label: "DaytonaValidationError",
        err: new DaytonaValidationError("malformed request", 400),
        expected: false,
        reason: "request rejected for shape — won't clear",
      },
      {
        label: "DaytonaNotFoundError",
        err: new DaytonaNotFoundError("not found", 404),
        expected: false,
        reason: "snapshot 404 is the absent path; retry would re-404",
      },
      {
        label: "DaytonaConflictError",
        err: new DaytonaConflictError("snapshot already exists", 409),
        expected: false,
        reason:
          "rebuild path uses fresh names, so reaching 409 means caller logic is wrong — retry hides the bug",
      },
      {
        label: "DaytonaRateLimitError",
        err: new DaytonaRateLimitError("rate limit exceeded", 429),
        expected: true,
        reason:
          "SDK does NOT retry 429 (only OpenTelemetry interceptors, no Retry-After parsing); first hit surfaces straight through, retry envelope is the only defense",
      },
      {
        label: "DaytonaTimeoutError",
        err: new DaytonaTimeoutError("request timed out"),
        expected: false,
        reason:
          "SDK's axios timeout is 24h, so this only fires on backend-side hangs; short retries won't unstick them",
      },
      {
        label: "DaytonaConnectionError",
        err: new DaytonaConnectionError("ECONNRESET"),
        expected: true,
        reason:
          "transient network blip on one of the SDK's internal poll cycles; SDK rethrows raw, retry envelope is the only defense",
      },
      {
        label: "DaytonaError (base) with transient signature",
        err: new DaytonaError(
          "unprocessable entity: Error response from daemon: unknown: repository sbox/daytona-xyz not found",
          422,
        ),
        expected: true,
        reason: "documented Daytona internal-registry race — clears on retry",
      },
      {
        label: "Generic Error with transient signature",
        err: new Error(
          "Error response from daemon: unknown: repository sbox/daytona-abc not found",
        ),
        expected: true,
        reason: "same signature, surfaced as a non-Daytona error class",
      },
      {
        label: "Generic Error with persistent-Dockerfile signature",
        err: new Error("invalid Dockerfile syntax: line 3"),
        expected: false,
        reason: "real image build failure — retry would just delay the error",
      },
      {
        label: "Generic Error with missing-upstream signature",
        err: new Error("manifest for ghcr.io/example/image:1.0 not found"),
        expected: false,
        reason:
          "upstream image doesn't exist — won't clear, and the substring `not found` alone must NOT pass the regex",
      },
      {
        label: "Non-Error throwable",
        err: "string thrown directly",
        expected: false,
        reason: "predicate must not crash on non-Error values",
      },
      {
        label: "null",
        err: null,
        expected: false,
        reason: "predicate must not crash on null",
      },
    ];

    for (const { label, err, expected, reason } of cases) {
      it(`${expected ? "retries" : "does NOT retry"} ${label} — ${reason}`, () => {
        expect(isTransientSnapshotCreateError(err)).toBe(expected);
      });
    }
  });

  describe("snapshotNameFor", () => {
    it("strips registry prefix, replaces tag colon, lowercases, and appends hash", () => {
      const got = snapshotNameFor("ghcr.io/iskhakovt/cogmo-devbase:1.66.0");
      expect(got).toMatch(/^cogmo-cogmo-devbase-1\.66\.0-[0-9a-f]{8}$/);
    });
    it("lowercases the slug", () => {
      expect(snapshotNameFor("MyOrg/Foo:V2.0")).toMatch(/^cogmo-foo-v2\.0-[0-9a-f]{8}$/);
    });
    it("is deterministic per image (same input → same name)", () => {
      const a = snapshotNameFor("ghcr.io/iskhakovt/cogmo-devbase:1.66.0");
      const b = snapshotNameFor("ghcr.io/iskhakovt/cogmo-devbase:1.66.0");
      expect(a).toBe(b);
    });
    it("disambiguates same-final-segment images from different registries", () => {
      // Without the content hash, both images would collapse to the
      // same name and silently share one snapshot. With the hash, the
      // path prefix participates in the derivation so they diverge.
      const a = snapshotNameFor("ghcr.io/iskhakovt/cogmo-devbase:1.66.0");
      const b = snapshotNameFor("ghcr.io/someone-else/cogmo-devbase:1.66.0");
      expect(a).not.toBe(b);
    });
    it("returns null for :latest (Daytona rejects)", () => {
      expect(snapshotNameFor("foo:latest")).toBeNull();
    });
    it("returns null for untagged image (no version to pin)", () => {
      expect(snapshotNameFor("python")).toBeNull();
    });
    it("returns null for empty tag", () => {
      expect(snapshotNameFor("python:")).toBeNull();
    });
    it("returns null for digest-pinned images (@sha256:...)", () => {
      // Naive `lastIndexOf(":")` would treat the digest's colon as a
      // tag separator and produce a malformed name with `@` in it.
      // Falling back to the lazy `{ image }` path is cheaper than
      // special-casing the digest format — cogmo doesn't pin digests
      // today.
      expect(snapshotNameFor("ghcr.io/iskhakovt/cogmo-devbase@sha256:abc123def456")).toBeNull();
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
