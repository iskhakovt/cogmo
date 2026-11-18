/**
 * Inngest replay tests for the verify → push → PR orchestrator
 * (`coding-task-verify`).
 *
 * Driven through `@inngest/test`, whose engine re-invokes the whole function
 * body once per step boundary with earlier steps served from cache — the
 * shape of a clean production run, not a retry simulation.
 *
 * Pinned here: the test suite runs once per task, `git push` once, and
 * `pulls.create` once (a second POST returns 422 `validation_failed`, which
 * this function reads as a failure, so a re-POST would have the run that
 * just opened the PR mark its own task `failed`); the run doesn't
 * short-circuit on the `verifying` its own step wrote; a duplicate event
 * skips before reaching the failure machinery; and the `finally` fires once,
 * at the end.
 *
 * See .agents/rules/inngest.md and design/crash-recovery.md.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { InngestTestEngine, mockCtx } from "@inngest/test";
import type { Octokit } from "@octokit/rest";
import { StepError } from "inngest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { z } from "zod";
import { inngest } from "../../inngest/client.js";
import {
  type GitHubIdentity,
  gitHubIdentitySecretName,
  serializeGitHubIdentity,
} from "../../secrets/github.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import {
  codingRepoRow,
  codingTaskRow,
  type FakeCodingSandbox,
  FIXTURE_TASK_ID,
  fakeCodingSandbox,
  fakeExecHandle,
  idlePresubmitDeps,
  type StatefulCodingStore,
  statefulCodingStore,
} from "../../test/coding-fixtures.js";
import {
  directStep,
  emittedEventNames,
  fakeRunInTx,
  invokeInngestFn,
  spyOnInngestSend,
} from "../../test/factories.js";
import type { PresubmitDeps } from "./presubmit-stage.js";
import type { CodingRepoRow, CodingTaskRow } from "./store/index.js";
import {
  createCodingVerifyOrchestrator,
  type VerifyOrchestratorDeps,
} from "./verify-orchestrator.js";

const HEAD_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const IDENTITY: GitHubIdentity = {
  pat: "ghp_dummy_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nABC\n-----END OPENSSH PRIVATE KEY-----",
  sshPublicKey: "ssh-ed25519 AAAA cogmo-bot",
  login: "cogmo-bot",
  id: "12345",
};

let sendSpy: ReturnType<typeof spyOnInngestSend>;

beforeEach(() => {
  // The engine drives `inngest._send` for `step.sendEvent`; without a stub
  // each emit waits out an ECONNREFUSED retry against a dev server that
  // isn't running.
  sendSpy = spyOnInngestSend(inngest);
  sendSpy.mockResolvedValue({ ids: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A task that has finished execute and is waiting to be verified. */
function verifiableTask(overrides: Partial<CodingTaskRow> = {}): CodingTaskRow {
  return codingTaskRow({
    goal: "fix the thing",
    worktreeAssignment: {
      type: "host-path",
      branch: "cogmo/abc12345",
      worktreePath: "/tmp/worktrees/abc12345",
    },
    sessionId: "sess-AAA",
    plan: "1. step\n2. step",
    planApprovedAt: new Date("2026-08-20T00:01:00Z"),
    status: "pending_verify",
    ...overrides,
  });
}

interface ExecLog {
  verify: number;
  push: number;
  revParse: number;
}

/** Scripts the container's git + verify commands and counts each kind. */
function countingExec(log: ExecLog, headSha: string) {
  return async (cmd: ReadonlyArray<string>) => {
    if (cmd[0] === "bash") {
      log.verify++;
      return fakeExecHandle({ stdout: "PASS\n", exitCode: 0 });
    }
    const sub = cmd.slice(1).find((a) => !a.startsWith("-c") && !a.includes("="));
    if (sub === "push") log.push++;
    if (sub === "rev-parse") {
      log.revParse++;
      return fakeExecHandle({ stdout: `${headSha}\n`, exitCode: 0 });
    }
    if (sub === "status") return fakeExecHandle({ stdout: "M src/foo.ts\n", exitCode: 0 });
    return fakeExecHandle({ exitCode: 0 });
  };
}

function fakeSecrets(): SecretsStore {
  const values = new Map<string, string>([
    [gitHubIdentitySecretName("default"), serializeGitHubIdentity(IDENTITY)],
    ["claude_code_oauth_token", "sk-test-claude-code-oauth-token"],
  ]);
  const store = mock<SecretsStore>();
  store.getSecret.mockImplementation(async (_tx, name: string) => values.get(name));
  return store;
}

interface Harness {
  deps: VerifyOrchestratorDeps;
  store: StatefulCodingStore;
  sandbox: FakeCodingSandbox;
  log: ExecLog;
  create: ReturnType<typeof vi.fn>;
}

function setup(
  task: CodingTaskRow,
  skills: { repo: CodingRepoRow; headSha: string; presubmit: PresubmitDeps } | null,
): Harness {
  const headSha = skills?.headSha ?? HEAD_SHA;
  const log: ExecLog = { verify: 0, push: 0, revParse: 0 };
  const store = statefulCodingStore(task, skills?.repo);
  const sandbox = fakeCodingSandbox(countingExec(log, headSha));
  const create = vi.fn(async () => ({
    data: {
      html_url: "https://github.com/user/cogmo/pull/7",
      number: 7,
      head: { sha: headSha },
      created_at: "2026-08-20T00:02:00Z",
    },
  }));
  return {
    log,
    store,
    sandbox,
    create,
    deps: {
      runInTx: fakeRunInTx,
      store: store.store,
      sandbox: sandbox.sandbox,
      secretsStore: fakeSecrets(),
      askpassBaseDir: "/tmp/cogmo-replay-askpass",
      devbaseImage: "alpine",
      defaultResourceLimits: { cpus: 1, memory_bytes: 1 << 30, pids: 64 },
      taskTtlMs: 60_000,
      presubmit: skills?.presubmit ?? idlePresubmitDeps(),
      octokitFactory: () => ({ pulls: { create } }) as unknown as Octokit,
    },
  };
}

const cliDoneEvent = {
  name: "coding/task/cli-done",
  data: { taskId: FIXTURE_TASK_ID },
} as const;

/** The run's id. Inngest keeps one per run; the test engine mints one per invocation unless pinned. */
const RUN_ID = "verify-run-1";
const pinRunId: NonNullable<InngestTestEngine.Options["transformCtx"]> = (ctx) => ({
  ...mockCtx(ctx),
  runId: RUN_ID,
});

const EmittedSchema = z.object({
  payload: z.union([z.array(z.unknown()), z.unknown()]),
});
const EventSchema = z.object({ name: z.string(), data: z.unknown(), id: z.string().optional() });

/** Every event the spy saw: name, data and dedup id. */
function emittedEvents(spy: ReturnType<typeof spyOnInngestSend>) {
  return spy.mock.calls.flatMap(([arg]) => {
    const { payload } = EmittedSchema.parse(arg);
    return (Array.isArray(payload) ? payload : [payload]).map((event) => EventSchema.parse(event));
  });
}

describe("coding-task-verify — Inngest replay", () => {
  it("verifies, pushes, and opens the PR exactly once across the run's boundaries", async () => {
    const h = setup(verifiableTask(), null);
    const fn = createCodingVerifyOrchestrator(h.deps, inngest);

    const engine = new InngestTestEngine({ function: fn, events: [cliDoneEvent] });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    // `set-status-verifying` flips the row to `verifying` on the first
    // invocation, and every later re-invocation re-reads it at the top of
    // the body. A bare-body `status !== "pending_verify"` guard returns
    // `skipped` there — the task never reaches `pr_open` and sits in
    // `verifying` forever.
    expect(result).toEqual({
      status: "pr_open",
      prUrl: "https://github.com/user/cogmo/pull/7",
      prNumber: 7,
    });
    expect(h.store.current().status).toBe("pr_open");

    // One test-suite run, one push, one PR — not one per remaining boundary.
    expect(h.log.verify).toBe(1);
    expect(h.log.push).toBe(1);
    expect(h.create).toHaveBeenCalledTimes(1);

    // Cleanup runs once, at the end. A step that has been planned but not
    // yet executed hands the body a promise the SDK never settles, so the
    // invocation ends with the function abandoned mid-`await` and the
    // `finally` does not fire on a boundary unwind. The design leans on
    // that: were it otherwise, this run would tear down its own sandbox
    // between `create-container` and the verify that needs it.
    expect(h.sandbox.teardownCalls()).toBe(1);

    // `openedAt` is stamped by `runOpenPr` at call time — now inside the
    // memoized step, so it is pinned to the one invocation that opened the
    // PR instead of drifting with each re-invocation.
    expect(h.store.current().prMetadata).toEqual({
      url: "https://github.com/user/cogmo/pull/7",
      number: 7,
      branchSha: HEAD_SHA,
      openedAt: expect.any(String),
    });
  });

  it("serves a cached verify verdict without re-running the suite", async () => {
    const h = setup(verifiableTask(), null);
    const fn = createCodingVerifyOrchestrator(h.deps, inngest);

    const engine = new InngestTestEngine({
      function: fn,
      events: [cliDoneEvent],
      // Simulate: a prior attempt already ran the suite and Inngest is
      // re-invoking with that result in state.
      steps: [
        {
          id: "run-verify",
          handler: () => ({
            ok: true,
            exitCode: 0,
            output: "[cached PASS]",
            durationMs: 42,
            timedOut: false,
          }),
        },
      ],
    });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ status: "pr_open" });
    expect(h.log.verify).toBe(0);
    // The cached output is what reaches the PR body — proof the memoized
    // value flows through rather than being silently recomputed.
    expect(h.create).toHaveBeenCalledTimes(1);
    const body = h.create.mock.calls[0]?.[0] as { body: string } | undefined;
    expect(body?.body).toContain("[cached PASS]");
  });

  it("a run in flight across the deploy that replaced `set-status-pushed` carries on from `pushed`", async () => {
    // The superseded step wrote `pushed` and memoized `void`; the run's state
    // holds its claim, the suite's verdict and the push. `transition-pushed`
    // is new to this run, so it executes, finds the row `stale` at its own
    // target, and the run goes on to open the PR rather than re-pushing or
    // stopping.
    const h = setup(verifiableTask({ status: "pushed" }), null);
    const fn = createCodingVerifyOrchestrator(h.deps, inngest);

    const engine = new InngestTestEngine({
      function: fn,
      events: [cliDoneEvent],
      steps: [
        { id: "set-status-verifying", handler: () => ({ kind: "transitioned" }) },
        {
          id: "run-verify",
          handler: () => ({
            ok: true,
            exitCode: 0,
            output: "PASS",
            durationMs: 1,
            timedOut: false,
          }),
        },
        { id: "emit-verify-complete", handler: () => null },
        {
          id: "commit-and-push",
          handler: () => ({ kind: "pushed", commitSha: HEAD_SHA, output: "" }),
        },
        { id: "emit-pushed", handler: () => null },
      ],
    });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ status: "pr_open", prNumber: 7 });
    expect(h.store.current().status).toBe("pr_open");
    expect(h.log.push).toBe(0);
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it("a run in flight across the deploy that replaced `set-status-pr-open` still sends pr-opened", async () => {
    // The superseded step wrote `pr_open` and memoized `void`; everything up
    // to `set-pr-metadata` is in state and `emit-pr-opened` is not. Neither
    // new step is memoized: `transition-pushed` executes first, reads `stale`
    // at `pr_open` — settled by this run's own retired step — and carries
    // on; `transition-pr-open` reads `stale` at its own target; the run then
    // sends the `pr-opened` it owes, without a second `pulls.create`.
    const h = setup(verifiableTask({ status: "pr_open" }), null);
    const fn = createCodingVerifyOrchestrator(h.deps, inngest);

    const engine = new InngestTestEngine({
      function: fn,
      events: [cliDoneEvent],
      steps: [
        { id: "set-status-verifying", handler: () => ({ kind: "transitioned" }) },
        {
          id: "run-verify",
          handler: () => ({
            ok: true,
            exitCode: 0,
            output: "PASS",
            durationMs: 1,
            timedOut: false,
          }),
        },
        { id: "emit-verify-complete", handler: () => null },
        {
          id: "commit-and-push",
          handler: () => ({ kind: "pushed", commitSha: HEAD_SHA, output: "" }),
        },
        { id: "emit-pushed", handler: () => null },
        {
          id: "open-pr",
          handler: () => ({
            kind: "opened",
            url: "https://github.com/user/cogmo/pull/7",
            number: 7,
            branchSha: HEAD_SHA,
            openedAt: "2026-08-20T00:02:00Z",
          }),
        },
        { id: "set-pr-metadata", handler: () => null },
      ],
    });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    expect(result).toEqual({
      status: "pr_open",
      prUrl: "https://github.com/user/cogmo/pull/7",
      prNumber: 7,
    });
    expect(h.store.current().status).toBe("pr_open");
    expect(h.log.push).toBe(0);
    expect(h.create).not.toHaveBeenCalled();
    expect(emittedEventNames(sendSpy)).toEqual(["coding/task/pr-opened"]);
  });

  it("skips a duplicate event before reaching the failure machinery", async () => {
    // A duplicate `cli-done` for a task that already finished. The
    // conditional UPDATE matches no row, so the run must return `skipped`
    // without running identity resolution — whose failure would otherwise
    // flip an already-terminal task to `failed`.
    const h = setup(verifiableTask({ status: "pr_open" }), null);
    const fn = createCodingVerifyOrchestrator(h.deps, inngest);

    const engine = new InngestTestEngine({ function: fn, events: [cliDoneEvent] });
    const { result, error } = await engine.execute();

    expect(error).toBeUndefined();
    expect(result).toEqual({ status: "skipped" });
    expect(h.store.current().status).toBe("pr_open");
    expect(h.log.verify).toBe(0);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.deps.store.failTaskIfNonTerminal).not.toHaveBeenCalled();
    // Returning ahead of the try block means the loser doesn't sweep the
    // sandbox either — relevant the day per-task concurrency is relaxed.
    expect(h.sandbox.teardownCalls()).toBe(0);
  });

  describe("the skills repo's pre-submit", () => {
    const git = async (...args: string[]) => (await promisify(execFile)("git", args)).stdout.trim();
    const REMOTE = "https://github.com/user/skills.git";
    let root: string;
    let bare: string;
    let tip: string;

    beforeEach(async () => {
      // The branch verify pushed, on a local "remote" the bare repo reaches
      // under the GitHub URL the task's repo row names.
      root = await mkdtemp(join(tmpdir(), "cogmo-presubmit-replay-"));
      const upstream = join(root, "upstream");
      bare = join(root, "skills.git");
      await git("init", "-q", "-b", "cogmo/abc12345", upstream);
      await git(
        "-C",
        upstream,
        "-c",
        "user.email=t@cogmo",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "skill",
      );
      tip = await git("-C", upstream, "rev-parse", "HEAD");
      await git("init", "-q", "--bare", bare);
      await git("-C", bare, "config", `url.${upstream}.insteadOf`, REMOTE);
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const FINDING = "ruff: skills/echo/skill.py:1:1: E501 Line too long";
    const MAIN_SHA = "e".repeat(40);

    function skillsSetup(task: CodingTaskRow) {
      const skillRunner = mock<PresubmitDeps["skillRunner"]>();
      skillRunner.checkRegister.mockResolvedValue({
        kind: "refused",
        sha: tip,
        findings: [FINDING],
      });
      const repo = codingRepoRow({ name: "skills", remoteUrl: REMOTE });
      const presubmit = { skillRunner, skillsRepoPath: bare, releaseVersion: "dev" };
      const h = setup(task, { repo, headSha: tip, presubmit });
      const askpassBaseDir = join(root, "askpass");
      return {
        ...h,
        deps: { ...h.deps, askpassBaseDir },
        askpassDir: join(askpassBaseDir, FIXTURE_TASK_ID),
        skillRunner,
      };
    }

    /** Pass `fixPass`'s `cli-done`, and a task that pass's execute run handed off. */
    const passEvent = (fixPass: number) => ({
      name: "coding/task/cli-done",
      data: { taskId: FIXTURE_TASK_ID, fixPass },
    });
    const atPass = (fixPass: number, overrides: Partial<CodingTaskRow> = {}) =>
      verifiableTask({
        presubmitFixPasses: fixPass,
        ...(fixPass > 0 && {
          presubmitVerdict: {
            kind: "refused",
            sha: "f".repeat(40),
            findings: [FINDING],
            runId: "verify-run-0",
            fixPass: fixPass - 1,
            checkedAt: "2026-08-20T00:01:00.000Z",
            releaseVersion: "dev",
          },
        }),
        ...overrides,
      });

    /** The fix pass's execute run provisioning the same askpass path once the emit is out. */
    function provisionOnEmit(askpassDir: string): void {
      sendSpy.mockImplementation(async (arg) => {
        const { payload } = EmittedSchema.parse(arg);
        const events = (Array.isArray(payload) ? payload : [payload]).map((e) =>
          EventSchema.parse(e),
        );
        if (events.some((e) => e.name === "coding/task/presubmit-refused")) {
          mkdirSync(askpassDir, { recursive: true });
        }
        return { ids: [] };
      });
    }

    /** The steps a run memoized up to its pre-submit, which judged the pushed tip refused. */
    function refusedThroughPresubmit() {
      return [
        { id: "set-status-verifying", handler: () => ({ kind: "transitioned" }) },
        {
          id: "run-verify",
          handler: () => ({
            ok: true,
            exitCode: 0,
            output: "PASS",
            durationMs: 1,
            timedOut: false,
          }),
        },
        { id: "emit-verify-complete", handler: () => null },
        {
          id: "commit-and-push",
          handler: () => ({ kind: "pushed", commitSha: tip, output: "" }),
        },
        {
          id: "presubmit",
          handler: () => ({
            verdict: {
              kind: "refused",
              sha: tip,
              findings: [FINDING],
              runId: "verify-run-1",
              fixPass: 0,
              checkedAt: "2026-08-20T00:01:30.000Z",
              releaseVersion: "dev",
            },
          }),
        },
      ];
    }

    it.each([0, 1])(
      "a refusal at pass %i hands the task back to the next pass, reaping before the emit, and opens no PR",
      async (fixPass) => {
        const h = skillsSetup(atPass(fixPass));
        provisionOnEmit(h.askpassDir);
        const fn = createCodingVerifyOrchestrator(h.deps, inngest);

        const { result, error } = await new InngestTestEngine({
          function: fn,
          events: [fixPass === 0 ? cliDoneEvent : passEvent(fixPass)],
          transformCtx: pinRunId,
        }).execute();

        expect(error).toBeUndefined();
        expect(result).toEqual({ status: "pending_fix" });
        expect(h.store.current()).toMatchObject({
          status: "pending_fix",
          presubmitFixPasses: fixPass + 1,
          failureReason: null,
          presubmitVerdict: { kind: "refused", sha: tip, runId: RUN_ID, fixPass },
        });
        expect(h.skillRunner.checkRegister).toHaveBeenCalledTimes(1);
        expect(h.log.push).toBe(1);
        expect(h.create).not.toHaveBeenCalled();
        const suffix = fixPass === 0 ? "" : `-f${fixPass}`;
        expect(emittedEvents(sendSpy)).toEqual([
          expect.objectContaining({
            name: "coding/task/verify-complete",
            id: `verify-complete-${FIXTURE_TASK_ID}${suffix}`,
          }),
          {
            name: "coding/task/presubmit-refused",
            data: { taskId: FIXTURE_TASK_ID, fixPass: fixPass + 1 },
            id: `presubmit-refused-${FIXTURE_TASK_ID}-f${fixPass + 1}`,
          },
        ]);
        // `teardown-before-fix` reaped once; the `finally` neither swept again
        // nor released the path the fix pass has provisioned since.
        expect(h.sandbox.teardownCalls()).toBe(1);
        expect(existsSync(h.askpassDir)).toBe(true);
        expect(await git("-C", bare, "for-each-ref", "refs/cogmo-presubmit/")).toBe("");
      },
    );

    it("a refusal with no pass left fails the task presubmit_refused with its findings", async () => {
      const h = skillsSetup(atPass(2));
      const fn = createCodingVerifyOrchestrator(h.deps, inngest);

      const { result, error } = await new InngestTestEngine({
        function: fn,
        events: [passEvent(2)],
        transformCtx: pinRunId,
      }).execute();

      expect(error).toBeUndefined();
      const failure = { reason: "presubmit_refused", detail: FINDING };
      expect(result).toEqual({ status: "failed", failure });
      expect(h.store.current()).toMatchObject({
        status: "failed",
        failureReason: "presubmit_refused",
        failureDetail: FINDING,
        presubmitFixPasses: 2,
        presubmitVerdict: { kind: "refused", sha: tip, fixPass: 2 },
      });
      expect(h.create).not.toHaveBeenCalled();
      expect(emittedEventNames(sendSpy)).toEqual([
        "coding/task/verify-complete",
        "coding/task/failed",
      ]);
      expect(h.sandbox.teardownCalls()).toBe(1);
      expect(existsSync(h.askpassDir)).toBe(false);
    });

    it("a repeated refusal, the tip and release an earlier pass refused, fails the task with no dry run", async () => {
      const h = skillsSetup(
        atPass(1, {
          presubmitVerdict: {
            kind: "refused",
            sha: tip,
            findings: [FINDING],
            runId: "verify-run-0",
            fixPass: 0,
            checkedAt: "2026-08-20T00:01:00.000Z",
            releaseVersion: "dev",
          },
        }),
      );
      const fn = createCodingVerifyOrchestrator(h.deps, inngest);

      const { result, error } = await new InngestTestEngine({
        function: fn,
        events: [passEvent(1)],
        transformCtx: pinRunId,
      }).execute();

      expect(error).toBeUndefined();
      expect(result).toEqual({
        status: "failed",
        failure: { reason: "presubmit_refused", detail: FINDING },
      });
      expect(h.skillRunner.checkRegister).not.toHaveBeenCalled();
      expect(h.store.current()).toMatchObject({
        status: "failed",
        presubmitFixPasses: 1,
        presubmitVerdict: { runId: "verify-run-0", fixPass: 0 },
      });
      expect(emittedEventNames(sendSpy)).toEqual([
        "coding/task/verify-complete",
        "coding/task/failed",
      ]);
    });

    it("a trigger from an earlier pass loses its claim before any failure machinery", async () => {
      // Pass 0's `cli-done`, redelivered while pass 1's execute run holds the task.
      const h = skillsSetup(atPass(1));
      const fn = createCodingVerifyOrchestrator(h.deps, inngest);

      const { result, error } = await new InngestTestEngine({
        function: fn,
        events: [cliDoneEvent],
        transformCtx: pinRunId,
      }).execute();

      expect(error).toBeUndefined();
      expect(result).toEqual({ status: "skipped" });
      expect(h.store.current()).toMatchObject({ status: "pending_verify", claimedByRunId: null });
      expect(h.log.verify).toBe(0);
      expect(h.deps.store.failTaskIfNonTerminal).not.toHaveBeenCalled();
      expect(h.sandbox.teardownCalls()).toBe(0);
    });

    it("`stale` at `pending_fix` with the next count is `transition-pending-fix`'s own commit: it reaps and emits", async () => {
      const h = skillsSetup(atPass(0, { status: "pending_fix", presubmitFixPasses: 1 }));
      const fn = createCodingVerifyOrchestrator(h.deps, inngest);

      const { result, error } = await new InngestTestEngine({
        function: fn,
        events: [cliDoneEvent],
        transformCtx: pinRunId,
        steps: refusedThroughPresubmit(),
      }).execute();

      expect(error).toBeUndefined();
      expect(result).toEqual({ status: "pending_fix" });
      expect(h.skillRunner.checkRegister).not.toHaveBeenCalled();
      expect(emittedEventNames(sendSpy)).toEqual(["coding/task/presubmit-refused"]);
      expect(h.sandbox.teardownCalls()).toBe(1);
    });

    it("`transition-pending-fix` finding the run's own `verifying` at another count throws in the step", async () => {
      const h = skillsSetup(
        atPass(0, {
          status: "verifying",
          presubmitFixPasses: 1,
          presubmitVerdict: {
            kind: "refused",
            sha: tip,
            findings: [FINDING],
            runId: RUN_ID,
            fixPass: 0,
            checkedAt: "2026-08-20T00:01:30.000Z",
            releaseVersion: "dev",
          },
        }),
      );
      const fn = createCodingVerifyOrchestrator(h.deps, inngest);

      const { error } = await new InngestTestEngine({
        function: fn,
        events: [cliDoneEvent],
        transformCtx: pinRunId,
        steps: refusedThroughPresubmit(),
      }).execute();

      expect(String(JSON.stringify(error))).toContain("not this run's refusal at pass 0");
      expect(h.store.current()).toMatchObject({ status: "verifying", presubmitFixPasses: 1 });
      expect(emittedEventNames(sendSpy)).not.toContain("coding/task/presubmit-refused");
    });

    /**
     * Drives the run's handler with a step whose `failing` id has exhausted
     * its retries, as the SDK hands that back: `InngestTestEngine` resolves a
     * throwing mock as `undefined` instead (see `directStep`).
     */
    async function runWithFailedStep(
      h: ReturnType<typeof skillsSetup>,
      failing: { run: string | null; sendEvent?: string; onSend?: () => void },
    ) {
      const step = directStep({}, failing.run);
      step.sendEvent.mockImplementation(async (id: string) => {
        if (id !== failing.sendEvent) return { ids: [] };
        failing.onSend?.();
        throw new StepError(id, new Error(`step "${id}" failed after retries`));
      });
      const fn = createCodingVerifyOrchestrator(h.deps, inngest);
      return invokeInngestFn(fn, { event: cliDoneEvent, step, runId: RUN_ID });
    }

    it("an `emit-presubmit-refused` that fails fails the task, and the `finally` skips its sweep and release", async () => {
      const h = skillsSetup(atPass(0));

      const result = await runWithFailedStep(h, {
        run: null,
        sendEvent: "emit-presubmit-refused",
        // The send reached the bus: the fix pass provisions the same path.
        onSend: () => mkdirSync(h.askpassDir, { recursive: true }),
      });

      expect(result).toMatchObject({ status: "failed", failure: { reason: "unexpected_error" } });
      expect(h.store.current()).toMatchObject({
        status: "failed",
        failureReason: "unexpected_error",
        presubmitFixPasses: 1,
      });
      // `teardown-before-fix`'s reap alone.
      expect(h.sandbox.teardownCalls()).toBe(1);
      expect(existsSync(h.askpassDir)).toBe(true);
    });

    it("a run whose `teardown-before-fix` never returned sweeps and releases in its `finally`", async () => {
      const h = skillsSetup(atPass(0));

      const result = await runWithFailedStep(h, { run: "teardown-before-fix" });

      expect(result).toMatchObject({ status: "failed", failure: { reason: "unexpected_error" } });
      expect(h.store.current()).toMatchObject({ status: "failed", presubmitFixPasses: 1 });
      expect(h.sandbox.teardownCalls()).toBe(1);
      expect(existsSync(h.askpassDir)).toBe(false);
    });

    it("a run that memoized slice 2's `transition-presubmit-failed` takes the failure as its own across this deploy", async () => {
      // Its trigger has no `fixPass`, its pre-submit memo is pass 0's, and the
      // task reads `failed` with the refusal: `transition-pending-fix` is new to
      // it, reads that as the run's own failure, and the run announces it.
      const h = skillsSetup(
        verifiableTask({
          status: "failed",
          failureReason: "presubmit_refused",
          failureDetail: FINDING,
        }),
      );
      mkdirSync(h.askpassDir, { recursive: true });
      const fn = createCodingVerifyOrchestrator(h.deps, inngest);

      const { result, error } = await new InngestTestEngine({
        function: fn,
        events: [cliDoneEvent],
        transformCtx: pinRunId,
        steps: [
          ...refusedThroughPresubmit(),
          { id: "transition-presubmit-failed", handler: () => ({ kind: "failed" }) },
        ],
      }).execute();

      expect(error).toBeUndefined();
      expect(result).toEqual({
        status: "failed",
        failure: { reason: "presubmit_refused", detail: FINDING },
      });
      expect(h.store.current()).toMatchObject({ status: "failed", presubmitFixPasses: 0 });
      expect(emittedEventNames(sendSpy)).toEqual(["coding/task/failed"]);
      expect(h.sandbox.teardownCalls()).toBe(1);
      expect(existsSync(h.askpassDir)).toBe(false);
    });

    it("a stale base fails the task presubmit_stale_base naming both shas", async () => {
      const h = skillsSetup(verifiableTask());
      h.skillRunner.checkRegister.mockResolvedValue({
        kind: "stale_base",
        sha: tip,
        mainSha: MAIN_SHA,
      });
      const fn = createCodingVerifyOrchestrator(h.deps, inngest);

      const { result, error } = await new InngestTestEngine({
        function: fn,
        events: [cliDoneEvent],
        transformCtx: pinRunId,
      }).execute();

      expect(error).toBeUndefined();
      expect(result).toMatchObject({
        status: "failed",
        failure: { reason: "presubmit_stale_base" },
      });
      const { failureReason, failureDetail } = h.store.current();
      expect(failureReason).toBe("presubmit_stale_base");
      expect(failureDetail).toContain(tip);
      expect(failureDetail).toContain(MAIN_SHA);
      expect(h.create).not.toHaveBeenCalled();
      expect(emittedEventNames(sendSpy)).toEqual([
        "coding/task/verify-complete",
        "coding/task/failed",
      ]);
    });

    it.each([
      { name: "passed", judged: () => ({ kind: "passed", sha: tip, riskTier: "notify" }) as const },
      {
        name: "unavailable",
        judged: () =>
          ({
            kind: "unavailable",
            sha: tip,
            cause: "registrar_unavailable",
            detail: "no sandbox backend",
          }) as const,
      },
    ])("a $name verdict proceeds to the PR", async ({ judged }) => {
      const h = skillsSetup(verifiableTask());
      h.skillRunner.checkRegister.mockResolvedValue(judged());
      const fn = createCodingVerifyOrchestrator(h.deps, inngest);

      const { result, error } = await new InngestTestEngine({
        function: fn,
        events: [cliDoneEvent],
        transformCtx: pinRunId,
      }).execute();

      expect(error).toBeUndefined();
      expect(result).toMatchObject({ status: "pr_open", prNumber: 7 });
      expect(h.store.current().presubmitVerdict).toMatchObject({ kind: judged().kind });
      expect(h.create).toHaveBeenCalledTimes(1);
      expect(emittedEventNames(sendSpy)).toEqual([
        "coding/task/verify-complete",
        "coding/task/pushed",
        "coding/task/pr-opened",
      ]);
    });

    it("a run that memoized a refusal past `transition-pushed` reads `stale` at `pushed` as passed and opens the PR", async () => {
      // A slice-1 run across the deploy: its pre-submit proceeded on a
      // refusal. `transition-presubmit-failed` is new to it, finds the row at
      // `pushed`, which only the run's own `transition-pushed` writes, and the
      // run carries on through its memoized steps.
      const h = skillsSetup(verifiableTask({ status: "pushed" }));
      const fn = createCodingVerifyOrchestrator(h.deps, inngest);

      const { result, error } = await new InngestTestEngine({
        function: fn,
        events: [cliDoneEvent],
        transformCtx: pinRunId,
        steps: [
          ...refusedThroughPresubmit(),
          { id: "transition-pushed", handler: () => ({ kind: "transitioned" }) },
          { id: "emit-pushed", handler: () => null },
        ],
      }).execute();

      expect(error).toBeUndefined();
      expect(result).toMatchObject({ status: "pr_open", prNumber: 7 });
      expect(h.store.current().status).toBe("pr_open");
      expect(h.skillRunner.checkRegister).not.toHaveBeenCalled();
      expect(h.create).toHaveBeenCalledTimes(1);
      expect(emittedEventNames(sendSpy)).toEqual(["coding/task/pr-opened"]);
    });

    it("a run that memoized a refusal past `transition-pr-open` reads `stale` at `pr_open` as passed", async () => {
      const h = skillsSetup(verifiableTask({ status: "pr_open" }));
      const fn = createCodingVerifyOrchestrator(h.deps, inngest);

      const { result, error } = await new InngestTestEngine({
        function: fn,
        events: [cliDoneEvent],
        transformCtx: pinRunId,
        steps: [
          ...refusedThroughPresubmit(),
          { id: "transition-pushed", handler: () => ({ kind: "transitioned" }) },
          { id: "emit-pushed", handler: () => null },
          {
            id: "open-pr",
            handler: () => ({
              kind: "opened",
              url: "https://github.com/user/cogmo/pull/7",
              number: 7,
              branchSha: tip,
              openedAt: "2026-08-20T00:02:00Z",
            }),
          },
          { id: "set-pr-metadata", handler: () => null },
          { id: "transition-pr-open", handler: () => ({ kind: "transitioned" }) },
          { id: "emit-pr-opened", handler: () => null },
        ],
      }).execute();

      expect(error).toBeUndefined();
      expect(result).toMatchObject({ status: "pr_open", prNumber: 7 });
      expect(h.store.current().status).toBe("pr_open");
      expect(h.create).not.toHaveBeenCalled();
      expect(emittedEventNames(sendSpy)).toEqual([]);
    });

    it("`stale` at `failed` with the refusal's reason is the run's own commit: it announces the failure", async () => {
      // `transition-presubmit-failed` committed, then Inngest lost its result.
      const h = skillsSetup(
        verifiableTask({
          status: "failed",
          failureReason: "presubmit_refused",
          failureDetail: FINDING,
        }),
      );
      const fn = createCodingVerifyOrchestrator(h.deps, inngest);

      const { result, error } = await new InngestTestEngine({
        function: fn,
        events: [cliDoneEvent],
        transformCtx: pinRunId,
        steps: refusedThroughPresubmit(),
      }).execute();

      expect(error).toBeUndefined();
      expect(result).toEqual({
        status: "failed",
        failure: { reason: "presubmit_refused", detail: FINDING },
      });
      expect(h.create).not.toHaveBeenCalled();
      expect(emittedEventNames(sendSpy)).toEqual(["coding/task/failed"]);
    });

    it.each([
      { status: "cancelled", failureReason: "user_cancelled", failureDetail: null },
      { status: "failed", failureReason: "run_terminated", failureDetail: "worker died" },
    ] as const)(
      "a task another writer ended at $status ($failureReason) is left as it is, unannounced",
      async (ended) => {
        const h = skillsSetup(verifiableTask(ended));
        const fn = createCodingVerifyOrchestrator(h.deps, inngest);

        const { result, error } = await new InngestTestEngine({
          function: fn,
          events: [cliDoneEvent],
          transformCtx: pinRunId,
          steps: refusedThroughPresubmit(),
        }).execute();

        expect(error).toBeUndefined();
        expect(result).toEqual({ status: "skipped" });
        expect(h.store.current()).toMatchObject(ended);
        expect(h.create).not.toHaveBeenCalled();
        expect(emittedEventNames(sendSpy)).toEqual([]);
      },
    );

    it("a run in flight across the deploy that added the step, past `transition-pushed`, runs it and carries on", async () => {
      // The step is new, so it runs where the run is: the dry run's sessions
      // are spent, and the verdict is not written on a row past `verifying`.
      const h = skillsSetup(verifiableTask({ status: "pushed" }));
      const fn = createCodingVerifyOrchestrator(h.deps, inngest);

      const { result, error } = await new InngestTestEngine({
        function: fn,
        events: [cliDoneEvent],
        transformCtx: pinRunId,
        steps: [
          { id: "set-status-verifying", handler: () => ({ kind: "transitioned" }) },
          {
            id: "run-verify",
            handler: () => ({
              ok: true,
              exitCode: 0,
              output: "PASS",
              durationMs: 1,
              timedOut: false,
            }),
          },
          { id: "emit-verify-complete", handler: () => null },
          {
            id: "commit-and-push",
            handler: () => ({ kind: "pushed", commitSha: tip, output: "" }),
          },
          { id: "transition-pushed", handler: () => ({ kind: "transitioned" }) },
          { id: "emit-pushed", handler: () => null },
        ],
      }).execute();

      expect(error).toBeUndefined();
      expect(result).toMatchObject({ status: "pr_open", prNumber: 7 });
      expect(h.skillRunner.checkRegister).toHaveBeenCalledTimes(1);
      expect(h.store.current().presubmitVerdict).toBeNull();
      expect(h.log.push).toBe(0);
      expect(h.create).toHaveBeenCalledTimes(1);
    });
  });
});
