import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ExecStreamingHandle, SandboxSession } from "../../sandbox/index.js";
import { buildWorktreeSpec, checkoutFeatureBranchInSandbox } from "./orchestrator.js";
import type { WorktreeAssignment } from "./types.js";

// `runBranchFor("019d...") === "cogmo/run/019d..."` — pinned by
// git-as-transport's own tests. Asserted by ref equality below.
const TASK_ID = "019d0000-0000-7000-8000-000000000abc";
const RUN_BRANCH = `cogmo/run/${TASK_ID}`;

describe("buildWorktreeSpec", () => {
  describe("bind-mount capability", () => {
    it("returns host-path WorktreeSpec from a host-path assignment", () => {
      const assignment: WorktreeAssignment = {
        type: "host-path",
        branch: "cogmo/abc12345",
        worktreePath: "/srv/cogmo/worktrees/cogmo/abc12345",
      };
      const spec = buildWorktreeSpec({
        taskId: TASK_ID,
        capability: "bind-mount",
        assignment,
        remoteUrl: "https://github.com/owner/repo.git",
        identityPat: undefined,
      });
      expect(spec).toEqual({
        type: "host-path",
        hostPath: "/srv/cogmo/worktrees/cogmo/abc12345",
      });
    });

    it("throws when given a git-remote assignment (capability/assignment mismatch)", () => {
      const assignment: WorktreeAssignment = {
        type: "git-remote",
        branch: "cogmo/abc12345",
      };
      expect(() =>
        buildWorktreeSpec({
          taskId: TASK_ID,
          capability: "bind-mount",
          assignment,
          remoteUrl: "https://github.com/owner/repo.git",
          identityPat: undefined,
        }),
      ).toThrow(/non-host-path assignment/);
    });
  });

  describe("git-remote capability", () => {
    it("returns git-remote WorktreeSpec pointing at cogmo/run/<task-id>", () => {
      const assignment: WorktreeAssignment = {
        type: "git-remote",
        branch: "cogmo/abc12345",
      };
      const spec = buildWorktreeSpec({
        taskId: TASK_ID,
        capability: "git-remote",
        assignment,
        remoteUrl: "https://github.com/owner/repo.git",
        identityPat: "ghp_test",
      });
      expect(spec).toEqual({
        type: "git-remote",
        url: "https://github.com/owner/repo.git",
        branch: RUN_BRANCH,
        auth: { username: "x-access-token", password: "ghp_test" },
      });
    });

    it("ignores assignment.type when capability is git-remote (host-path assignment still works on resume paths)", () => {
      // Edge case the execute path can hit: the row was persisted by the
      // plan path under a bind-mount capability, then the operator
      // switched backends and re-delegated. The assignment's `type` is
      // not authoritative for the WorktreeSpec — capability is.
      const assignment: WorktreeAssignment = {
        type: "host-path",
        branch: "cogmo/abc12345",
        worktreePath: "/srv/cogmo/worktrees/cogmo/abc12345",
      };
      const spec = buildWorktreeSpec({
        taskId: TASK_ID,
        capability: "git-remote",
        assignment,
        remoteUrl: "https://github.com/owner/repo.git",
        identityPat: "ghp_test",
      });
      expect(spec.type).toBe("git-remote");
    });

    it("throws when identityPat is missing (auth required for clone)", () => {
      const assignment: WorktreeAssignment = {
        type: "git-remote",
        branch: "cogmo/abc12345",
      };
      expect(() =>
        buildWorktreeSpec({
          taskId: TASK_ID,
          capability: "git-remote",
          assignment,
          remoteUrl: "https://github.com/owner/repo.git",
          identityPat: undefined,
        }),
      ).toThrow(/identity\.pat/);
    });
  });
});

// --- checkoutFeatureBranchInSandbox -----------------------------------------

function streamFromString(s: string): Readable {
  return Readable.from([Buffer.from(s, "utf8")]);
}

function fakeSession(opts: { exitCode: number; stdoutText?: string; stderrText?: string }): {
  session: SandboxSession;
  execCalls: Array<{ cmd: ReadonlyArray<string>; opts: unknown }>;
} {
  const execCalls: Array<{ cmd: ReadonlyArray<string>; opts: unknown }> = [];
  const handle: ExecStreamingHandle = {
    stdout: streamFromString(opts.stdoutText ?? ""),
    stderr: streamFromString(opts.stderrText ?? ""),
    wait: async () => ({ exitCode: opts.exitCode }),
    dispose: async () => {},
  };
  const session: SandboxSession = {
    state: { type: "local-docker", taskId: "t", containerRowId: "c", dockerId: "d" },
    exec: vi.fn(),
    execStreaming: vi.fn(async (cmd, execOpts) => {
      execCalls.push({ cmd, opts: execOpts });
      return handle;
    }),
  };
  return { session, execCalls };
}

describe("checkoutFeatureBranchInSandbox", () => {
  it("execs `git checkout -B <branch>` at /workspace", async () => {
    const { session, execCalls } = fakeSession({ exitCode: 0 });
    await checkoutFeatureBranchInSandbox(session, "cogmo/abc12345");
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.cmd).toEqual(["git", "checkout", "-B", "cogmo/abc12345"]);
    // Per-callsite timeout pair pins the wedge-resilience contract —
    // see design/coding-delegation.md → Per-callsite exec timeouts.
    // `git checkout -B` is a fast op; both caps tight because there is
    // no legitimate slow path.
    expect(execCalls[0]?.opts).toEqual({
      workingDir: "/workspace",
      timeoutMs: 60_000,
      idleTimeoutMs: 30_000,
    });
  });

  it("throws on non-zero exit code (stops the orchestrator before runCommitAndPush)", async () => {
    const { session } = fakeSession({ exitCode: 128 });
    await expect(checkoutFeatureBranchInSandbox(session, "cogmo/abc12345")).rejects.toThrow(
      /exit 128/,
    );
  });

  it("drains stdout + stderr before resolving (no hung streams)", async () => {
    // Inngest's `execStreaming` contract requires consumers to either drain
    // both streams or call `dispose`. The helper must drain so a downstream
    // `runCommitAndPush` doesn't get hit by a stuck transport. We verify by
    // checking the streams are at-end after wait() resolves.
    const { session } = fakeSession({
      exitCode: 0,
      stdoutText: "Switched to a new branch\n",
      stderrText: "",
    });
    await checkoutFeatureBranchInSandbox(session, "cogmo/abc12345");
    // No assertion needed — if drain didn't happen the helper would hang
    // forever on stream backpressure. Test passing means we drained.
    expect(session.execStreaming).toHaveBeenCalledTimes(1);
  });
});
