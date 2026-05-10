import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DaytonaSessionState, SessionSpec } from "../sandbox/index.js";
import { FakeDaytonaSandboxClient } from "./daytona-sandbox-fake.js";

const execFileP = promisify(execFile);

let baseRoot: string;
let baseDir: string;
let sourceRepo: string;
let askpassDir: string;
let client: FakeDaytonaSandboxClient;

const RESOURCE_LIMITS = { cpus: 0.5, memory_bytes: 128 * 1024 * 1024, pids: 32 };

beforeAll(async () => {
  // Stand up a tiny bare git repo on disk that the fake can clone from.
  // The orchestrator's `pushTaskBranchToRemote` would push a
  // `cogmo/run/<task-id>` ref to the equivalent of this dir; here we
  // pre-seed the branch so `clone --branch` resolves.
  const stage = mkdtempSync(join(tmpdir(), "cogmo-fake-stage-"));
  const work = join(stage, "work");
  mkdirSync(work);
  await execFileP("git", ["init", "--initial-branch=main", work]);
  await execFileP("git", ["-C", work, "config", "user.email", "t@t"]);
  await execFileP("git", ["-C", work, "config", "user.name", "t"]);
  await execFileP("git", ["-C", work, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(work, "README.md"), "fixture\n");
  await execFileP("git", ["-C", work, "add", "."]);
  await execFileP("git", ["-C", work, "commit", "-m", "init"]);
  await execFileP("git", ["-C", work, "branch", "cogmo/run/test-task"]);
  // Convert the work tree into a bare repo the fake can clone.
  sourceRepo = join(stage, "remote.git");
  await execFileP("git", ["clone", "--bare", work, sourceRepo]);

  baseRoot = mkdtempSync(join(tmpdir(), "cogmo-fake-base-"));
});

beforeEach(async () => {
  // Per-test baseDir so the monotonic `sb-fake-N` counter (per client
  // instance) never collides with a leftover sandbox dir from a prior
  // test that didn't call delete().
  baseDir = mkdtempSync(join(baseRoot, "test-"));
  client = await FakeDaytonaSandboxClient.create({
    baseDir,
    instanceId: "test-instance",
  });
  // Provision a synthetic askpass dir like `provisionAskpass` would on
  // the host. Helper script body embeds the canonical container path
  // `/.cogmo-askpass/pat` so the fake's rewrite-on-mirror logic gets
  // exercised.
  askpassDir = mkdtempSync(join(tmpdir(), "cogmo-fake-askpass-"));
  writeFileSync(join(askpassDir, "helper"), "#!/bin/sh\nexec /bin/cat '/.cogmo-askpass/pat'\n", {
    mode: 0o755,
  });
  writeFileSync(join(askpassDir, "pat"), "ghp_fake_pat_value", { mode: 0o600 });
  writeFileSync(
    join(askpassDir, "signing-key"),
    "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n",
    { mode: 0o600 },
  );
  writeFileSync(join(askpassDir, "signing-key.pub"), "ssh-ed25519 AAAA fake\n", { mode: 0o644 });
  // chmod to make sure modes carry across copy regardless of umask.
  chmodSync(join(askpassDir, "helper"), 0o755);
  chmodSync(join(askpassDir, "pat"), 0o600);
});

afterEach(() => {
  rmSync(askpassDir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(baseRoot, { recursive: true, force: true });
});

function makeSpec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    taskId: "test-task",
    image: "ghcr.io/iskhakovt/cogmo-devbase:test",
    resourceLimits: RESOURCE_LIMITS,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

describe("FakeDaytonaSandboxClient — capabilities + handshake", () => {
  it("advertises the same capability shape as the real DaytonaSandboxClient", () => {
    expect(client.capabilities).toEqual({
      siblingContainers: "sandbox-internal",
      hostBindMount: false,
      customImage: true,
      volumes: "managed",
      workingTreeTransport: "git-remote",
    });
  });

  it("healthCheck always returns ok=true (no side effects)", async () => {
    const result = await client.healthCheck();
    expect(result).toEqual({ ok: true, runtime: "daytona-fake" });
  });

  it("reconcileCrashedInstances is a no-op (managed-backend semantics)", async () => {
    const result = await client.reconcileCrashedInstances("any");
    expect(result).toEqual({ orphansReaped: 0 });
  });

  it("ensureImagePresent is a no-op", async () => {
    await expect(client.ensureImagePresent("any-image")).resolves.toBeUndefined();
  });
});

describe("FakeDaytonaSandboxClient.create — git-remote worktree", () => {
  it("clones the requested branch into the sandbox's workspace", async () => {
    const session = await client.create(
      makeSpec({
        worktree: {
          type: "git-remote",
          url: `file://${sourceRepo}`,
          branch: "cogmo/run/test-task",
          auth: { username: "x-access-token", password: "ghp_test" },
        },
      }),
    );

    expect(session.state.type).toBe("daytona");
    expect(session.state.taskId).toBe("test-task");
    expect(session.state.sandboxId).toMatch(/^sb-fake-\d+$/);

    // Verify the workspace actually has the cloned content.
    const result = await session.exec(["cat", "README.md"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("fixture");
  });

  it("rejects host-path WorktreeSpec (capability mismatch)", async () => {
    await expect(
      client.create(
        makeSpec({
          worktree: {
            type: "host-path",
            hostPath: "/tmp/whatever",
          },
        }),
      ),
    ).rejects.toThrow(/host-path.*git-remote/);
  });

  it("rejects homeVolume (managed backends auto-persist)", async () => {
    await expect(
      client.create(
        makeSpec({
          homeVolume: { volumeName: "cogmo-task-home-x" },
        }),
      ),
    ).rejects.toThrow(/homeVolume is unused/);
  });

  it("wipes sandboxRoot on post-create failure (no leak)", async () => {
    const aliveBefore = client.aliveSandboxIds.length;
    await expect(
      client.create(
        makeSpec({
          worktree: {
            type: "git-remote",
            url: `file://${sourceRepo}`,
            branch: "cogmo/run/does-not-exist",
            auth: { username: "x-access-token", password: "ghp_test" },
          },
        }),
      ),
    ).rejects.toThrow();
    // No sandbox record was added.
    expect(client.aliveSandboxIds.length).toBe(aliveBefore);
  });
});

describe("FakeDaytonaSandboxClient.create — askpass mirror", () => {
  it("mirrors the askpass dir into the sandbox root", async () => {
    const session = await client.create(
      makeSpec({
        askpass: { hostDir: askpassDir, containerDir: "/.cogmo-askpass" },
      }),
    );

    // Inspect the host filesystem directly — using `exec` would route
    // the cmd args through the path-rewriter, which (correctly) treats
    // any `/.cogmo-askpass` substring as a fixup target.
    const sandboxRoot = join(baseDir, session.state.sandboxId);
    expect(existsSync(join(sandboxRoot, ".cogmo-askpass", "helper"))).toBe(true);
    expect(existsSync(join(sandboxRoot, ".cogmo-askpass", "pat"))).toBe(true);
    expect(existsSync(join(sandboxRoot, ".cogmo-askpass", "signing-key"))).toBe(true);
    expect(existsSync(join(sandboxRoot, ".cogmo-askpass", "signing-key.pub"))).toBe(true);
  });

  it("rewrites the helper script's PAT path to the host-mirrored location", async () => {
    const session = await client.create(
      makeSpec({
        askpass: { hostDir: askpassDir, containerDir: "/.cogmo-askpass" },
      }),
    );

    const helperPath = join(baseDir, session.state.sandboxId, ".cogmo-askpass", "helper");
    const helperBody = readFileSync(helperPath, "utf8");
    const expectedHostPath = join(baseDir, session.state.sandboxId, ".cogmo-askpass", "pat");

    // Body must reference the rewritten host path. (We can't simply check
    // `not.toContain("/.cogmo-askpass/pat")` because the rewritten host
    // path itself ends in `.cogmo-askpass/pat`.)
    expect(helperBody).toContain(expectedHostPath);
    // The bare canonical path (without the host prefix) must NOT appear
    // as a quoted argument anywhere — the helper would `cat` a missing
    // file and `git` would silently fail to authenticate.
    expect(helperBody).not.toMatch(/'\/\.cogmo-askpass\/pat'/);
  });
});

describe("FakeDaytonaSandboxClient — lifecycle", () => {
  it("resume() finds an existing sandbox by sandboxId", async () => {
    const session = await client.create(
      makeSpec({
        worktree: {
          type: "git-remote",
          url: `file://${sourceRepo}`,
          branch: "cogmo/run/test-task",
          auth: { username: "x-access-token", password: "ghp_test" },
        },
      }),
    );
    const resumed = await client.resume(session.state);
    expect(resumed.state).toEqual(session.state);

    // Resumed handle still resolves the workspace correctly.
    const out = await resumed.exec(["cat", "README.md"]);
    expect(out.exitCode).toBe(0);
  });

  it("resume() throws when sandbox is unknown", async () => {
    const fakeState: DaytonaSessionState = {
      type: "daytona",
      taskId: "ghost",
      sandboxId: "sb-fake-999",
    };
    await expect(client.resume(fakeState)).rejects.toThrow(/not found/);
  });

  it("tryResumeByTaskId returns the matching sandbox or null", async () => {
    const sessionA = await client.create(makeSpec({ taskId: "task-a" }));
    await client.create(makeSpec({ taskId: "task-b" }));

    const found = await client.tryResumeByTaskId("task-a");
    expect(found?.state.taskId).toBe("task-a");
    expect(found?.state.sandboxId).toBe(sessionA.state.sandboxId);

    const missing = await client.tryResumeByTaskId("task-z");
    expect(missing).toBeNull();
  });

  it("delete() removes the sandbox and its filesystem", async () => {
    const session = await client.create(
      makeSpec({
        worktree: {
          type: "git-remote",
          url: `file://${sourceRepo}`,
          branch: "cogmo/run/test-task",
          auth: { username: "x-access-token", password: "ghp_test" },
        },
      }),
    );
    const sandboxRoot = join(baseDir, session.state.sandboxId);
    expect(existsSync(sandboxRoot)).toBe(true);

    await client.delete(session);
    expect(existsSync(sandboxRoot)).toBe(false);
    expect(client.aliveSandboxIds).not.toContain(session.state.sandboxId);
  });

  it("deleteByTaskId reaps every sandbox tagged with the same task", async () => {
    // Real Daytona allows >1 sandbox per task; the fake mirrors that.
    await client.create(makeSpec({ taskId: "shared" }));
    await client.create(makeSpec({ taskId: "shared" }));
    await client.create(makeSpec({ taskId: "other" }));
    expect(client.aliveSandboxIds).toHaveLength(3);

    await client.deleteByTaskId("shared");
    expect(client.aliveSandboxIds).toHaveLength(1);
  });

  it("deleteByTaskId is idempotent on unknown task ids", async () => {
    await expect(client.deleteByTaskId("never-existed")).resolves.toBeUndefined();
  });
});

describe("FakeDaytonaSandboxClient — state serialization", () => {
  it("round-trips DaytonaSessionState through serialize/deserialize", async () => {
    const session = await client.create(makeSpec());
    const serialized = client.serializeState(session.state);
    const deserialized = client.deserializeState(serialized);
    expect(deserialized).toEqual(session.state);
  });

  it("rejects malformed state on deserialize (Zod schema)", () => {
    expect(() =>
      client.deserializeState({ type: "local-docker", taskId: "x", sandboxId: "y" } as never),
    ).toThrow();
  });
});

describe("FakeDaytonaSandboxClient — execStreaming", () => {
  it("captures stdout from a successful command", async () => {
    const session = await client.create(
      makeSpec({
        worktree: {
          type: "git-remote",
          url: `file://${sourceRepo}`,
          branch: "cogmo/run/test-task",
          auth: { username: "x-access-token", password: "ghp_test" },
        },
      }),
    );
    const handle = await session.execStreaming(["sh", "-c", "echo hello && exit 0"]);
    const chunks: Buffer[] = [];
    for await (const chunk of handle.stdout) chunks.push(Buffer.from(chunk));
    const { exitCode } = await handle.wait();
    expect(exitCode).toBe(0);
    expect(Buffer.concat(chunks).toString("utf8")).toContain("hello");
  });

  it("reports non-zero exit code via wait()", async () => {
    const session = await client.create(
      makeSpec({
        worktree: {
          type: "git-remote",
          url: `file://${sourceRepo}`,
          branch: "cogmo/run/test-task",
          auth: { username: "x-access-token", password: "ghp_test" },
        },
      }),
    );
    const handle = await session.execStreaming(["sh", "-c", "exit 7"]);
    handle.stdout.resume();
    handle.stderr.resume();
    const { exitCode } = await handle.wait();
    expect(exitCode).toBe(7);
  });

  it("respects workingDir override (not /workspace alias)", async () => {
    const session = await client.create(
      makeSpec({
        worktree: {
          type: "git-remote",
          url: `file://${sourceRepo}`,
          branch: "cogmo/run/test-task",
          auth: { username: "x-access-token", password: "ghp_test" },
        },
      }),
    );
    // Use the host tmpdir as cwd; pwd should reflect it.
    const result = await session.exec(["pwd"], { workingDir: tmpdir() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(tmpdir());
  });

  it("returns the streaming handle BEFORE the process exits (not blocking)", async () => {
    // Contract: execStreaming returns immediately so the caller can
    // consume stdout / dispose during the run. Block-until-exit defeats
    // the purpose. This test asserts the handle resolves while the
    // process is still alive.
    const session = await client.create(
      makeSpec({
        worktree: {
          type: "git-remote",
          url: `file://${sourceRepo}`,
          branch: "cogmo/run/test-task",
          auth: { username: "x-access-token", password: "ghp_test" },
        },
      }),
    );
    // 1s sleep + 250ms bound so a contended CI runner doesn't trip
    // — but a blocking impl would still take 1000ms+, well past the
    // assertion. Generous + correct.
    const startedAt = Date.now();
    const handle = await session.execStreaming(["sh", "-c", "sleep 1; echo done"]);
    const handleReturnedAt = Date.now();
    expect(handleReturnedAt - startedAt).toBeLessThan(250);
    // Drain to completion + assert the actual process did finish.
    const chunks: Buffer[] = [];
    for await (const chunk of handle.stdout) chunks.push(Buffer.from(chunk));
    const { exitCode } = await handle.wait();
    expect(exitCode).toBe(0);
    expect(Buffer.concat(chunks).toString("utf8")).toContain("done");
  }, 10_000);

  it("dispose() rejects wait() with DisposedError per the ExecStreamingHandle contract", async () => {
    const session = await client.create(
      makeSpec({
        worktree: {
          type: "git-remote",
          url: `file://${sourceRepo}`,
          branch: "cogmo/run/test-task",
          auth: { username: "x-access-token", password: "ghp_test" },
        },
      }),
    );
    // Long-running process so dispose() lands before natural exit.
    const handle = await session.execStreaming(["sh", "-c", "sleep 30"]);
    handle.stdout.resume();
    handle.stderr.resume();
    await handle.dispose();
    await expect(handle.wait()).rejects.toThrow(/disposed/i);
  });

  it("dispose() is idempotent — second call is a no-op", async () => {
    const session = await client.create(
      makeSpec({
        worktree: {
          type: "git-remote",
          url: `file://${sourceRepo}`,
          branch: "cogmo/run/test-task",
          auth: { username: "x-access-token", password: "ghp_test" },
        },
      }),
    );
    const handle = await session.execStreaming(["sh", "-c", "sleep 30"]);
    handle.stdout.resume();
    handle.stderr.resume();
    await handle.dispose();
    // Second call must not throw and must not re-reject wait().
    await expect(handle.dispose()).resolves.toBeUndefined();
  });

  it("exec() throws on empty command (matches execStreaming)", async () => {
    const session = await client.create(makeSpec());
    await expect(session.exec([])).rejects.toThrow(/empty command/);
  });

  it("execStreaming() throws on empty command", async () => {
    const session = await client.create(makeSpec());
    await expect(session.execStreaming([])).rejects.toThrow(/empty command/);
  });

  it("exec() rethrows ENOENT instead of masking as exitCode=1", async () => {
    const session = await client.create(makeSpec());
    // `does-not-exist-binary-cogmo` is unambiguously not on PATH.
    // Real backends fail visibly when the image lacks a binary; the
    // fake must do the same instead of returning a confusing exit-1
    // result that hides the spawn failure.
    await expect(session.exec(["does-not-exist-binary-cogmo-fixture"])).rejects.toThrow(/ENOENT/);
  });

  it("remaps /workspace subpaths to <sandboxRoot>/workspace/<subpath>", async () => {
    const session = await client.create(
      makeSpec({
        worktree: {
          type: "git-remote",
          url: `file://${sourceRepo}`,
          branch: "cogmo/run/test-task",
          auth: { username: "x-access-token", password: "ghp_test" },
        },
      }),
    );
    // Pre-create a subdir inside the cloned workspace so the cwd resolves.
    await session.exec(["mkdir", "-p", "src"]);
    // Run `pwd` with a `/workspace/src` working dir — the fake should
    // remap it to `<sandboxRoot>/workspace/src`, not the host's
    // (non-existent) `/workspace/src`.
    const result = await session.exec(["pwd"], { workingDir: "/workspace/src" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(join(baseDir, session.state.sandboxId, "workspace", "src"));
  });
});
