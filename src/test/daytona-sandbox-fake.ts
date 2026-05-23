/**
 * Host-side fake of `DaytonaSandboxClient` for integration tests.
 *
 * Implements the full `SandboxClient<DaytonaSessionState>` contract but
 * does no Daytona-side work — `create()` clones the requested git remote
 * into a host-side temp directory, askpass material is mirrored locally
 * with `helper` script paths rewritten to the real host paths, and
 * `execStreaming` runs commands on the host via `child_process.execFile`.
 *
 * What this fake DOES exercise:
 *   - The orchestrator's `git-remote` worktree branch (capability flag,
 *     `pushTaskBranchToRemote`, `WorktreeSpec.git-remote` construction,
 *     post-create `git checkout -B`, post-PR `fetchFeatureBranch`).
 *   - The full askpass-upload contract (`fs.uploadFiles` + path layout)
 *     because consumers see the same `/.cogmo-askpass/` path the real
 *     backend serves.
 *   - The cleanup-cron / cleanup-event-subscriber paths (because they
 *     run against `coding_tasks` rows + GitHub, the sandbox shape only
 *     matters for lifecycle events).
 *
 * What this fake DOES NOT exercise (the gap covered by the deferred
 * Phase 3c.6 self-hosted-Daytona conformance suite):
 *   - SDK payload shape drift across versions.
 *   - WebSocket framing / `getSessionCommandLogs` callbacks.
 *   - `getSessionCommand` exit-code race semantics.
 *   - Auto-stop / archive state-machine in `tryResumeByTaskId`.
 *   - `refreshActivity` keepalive contract.
 *   - Image-pull / snapshot-build error paths.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { logger } from "../logger.js";
import { CONTAINER_ASKPASS_DIR as ASKPASS_CONTAINER_DIR } from "../sandbox/askpass.js";
import { DisposedError } from "../sandbox/daytona/exec-streaming.js";
import {
  type DaytonaSessionState,
  DaytonaSessionStateSchema,
  type ExecOptions,
  type ExecResult,
  type ExecStreamingHandle,
  type SandboxCapabilities,
  type SandboxClient,
  type SandboxSession,
  type SessionSpec,
} from "../sandbox/index.js";
import { expectDefined } from "./assertions.js";

const execFileP = promisify(execFile);
const log = logger.child({ component: "sandbox.daytona.fake" });

/** Mirror DaytonaSandboxClient's capability shape so capability-aware code branches identically. */
const CAPABILITIES: SandboxCapabilities = {
  siblingContainers: "sandbox-internal",
  hostBindMount: false,
  customImage: true,
  volumes: "managed",
  workingTreeTransport: "git-remote",
};

/** Path the orchestrator + git-as-transport helpers expect inside the sandbox. */
const WORKTREE_PATH_IN_SANDBOX = "/workspace";

interface FakeSandboxRecord {
  sandboxId: string;
  taskId: string;
  /**
   * Root host path that stands in for the sandbox's filesystem. The
   * `/workspace` checkout lives at `<sandboxRoot>/workspace`; the
   * askpass dir at `<sandboxRoot>/.cogmo-askpass`.
   */
  sandboxRoot: string;
  askpass?: {
    /** Original host dir provisioned by `provisionAskpass` — read source. */
    sourceHostDir: string;
    /** Mirrored copy inside the sandbox root — the path the orchestrator threads in `GIT_ASKPASS`. */
    containerDir: string;
  };
}

export interface FakeDaytonaSandboxClientOptions {
  /**
   * Host root for fake sandbox checkouts. One subdirectory per `create()`
   * call. Caller owns lifecycle — typically `mkdtempSync` in `beforeAll`,
   * `rmSync` in `afterAll`.
   */
  baseDir: string;
  /** Used only for symmetry with the real client; not exercised by the fake. */
  instanceId: string;
}

/**
 * `SandboxClient<DaytonaSessionState>` implementation that runs everything
 * on the host filesystem. Use only in tests.
 */
export class FakeDaytonaSandboxClient implements SandboxClient<DaytonaSessionState> {
  readonly backendId = "daytona-fake";
  readonly capabilities = CAPABILITIES;

  #baseDir: string;
  #sandboxes = new Map<string, FakeSandboxRecord>();
  #createCallSpecs: SessionSpec[] = [];
  /** Monotonic counter used to mint deterministic-ish sandbox ids in tests. */
  #nextId = 1;

  private constructor(opts: FakeDaytonaSandboxClientOptions) {
    this.#baseDir = opts.baseDir;
  }

  static async create(opts: FakeDaytonaSandboxClientOptions): Promise<FakeDaytonaSandboxClient> {
    return new FakeDaytonaSandboxClient(opts);
  }

  /** Test helper: every `create()` spec the fake has seen, in order. */
  get createCalls(): ReadonlyArray<SessionSpec> {
    return this.#createCallSpecs;
  }

  /** Test helper: list the sandbox records currently alive. */
  get aliveSandboxIds(): ReadonlyArray<string> {
    return [...this.#sandboxes.keys()];
  }

  async healthCheck(): Promise<{ ok: true; runtime: string }> {
    return { ok: true, runtime: "daytona-fake" };
  }

  async reconcileCrashedInstances(_id: string): Promise<{ orphansReaped: number }> {
    return { orphansReaped: 0 };
  }

  async ensureImagePresent(_image: string): Promise<void> {}

  async create(spec: SessionSpec): Promise<SandboxSession<DaytonaSessionState>> {
    if (spec.worktree && spec.worktree.type !== "git-remote") {
      throw new Error(
        `FakeDaytonaSandboxClient.create: WorktreeSpec.type "${spec.worktree.type}" is not supported (capabilities advertise "git-remote")`,
      );
    }
    if (spec.homeVolume) {
      throw new Error(
        "FakeDaytonaSandboxClient.create: SessionSpec.homeVolume is unused — managed backends auto-persist FS",
      );
    }
    if (spec.allowPrivilegedRunc) {
      throw new Error(
        "FakeDaytonaSandboxClient.create: SessionSpec.allowPrivilegedRunc is Local-Docker-specific",
      );
    }

    this.#createCallSpecs.push(spec);
    const sandboxId = `sb-fake-${this.#nextId++}`;
    const sandboxRoot = join(this.#baseDir, sandboxId);
    mkdirSync(sandboxRoot, { recursive: true });
    log.info({ sandboxId, taskId: spec.taskId, sandboxRoot }, "creating fake daytona sandbox");

    let askpass: FakeSandboxRecord["askpass"] | undefined;

    try {
      // Order matches the real client: askpass first (cheap, fail-fast on
      // misconfig), clone second (long pole). On failure: rollback by
      // wiping the sandboxRoot so the next create on the same baseDir
      // doesn't see leaked state.
      if (spec.askpass) {
        askpass = await this.#mirrorAskpass(spec.askpass.hostDir, sandboxRoot);
      }
      if (spec.worktree?.type === "git-remote") {
        await this.#cloneGitRemote(spec.worktree, sandboxRoot);
      }
    } catch (err) {
      log.error(
        { err: (err as Error).message, sandboxId, taskId: spec.taskId },
        "fake daytona create: post-create provisioning failed — wiping sandboxRoot",
      );
      rmSync(sandboxRoot, { recursive: true, force: true });
      throw err;
    }

    const record: FakeSandboxRecord = askpass
      ? { sandboxId, taskId: spec.taskId, sandboxRoot, askpass }
      : { sandboxId, taskId: spec.taskId, sandboxRoot };
    this.#sandboxes.set(sandboxId, record);
    return this.#wrap(record);
  }

  async resume(state: DaytonaSessionState): Promise<SandboxSession<DaytonaSessionState>> {
    const record = this.#sandboxes.get(state.sandboxId);
    if (!record) {
      throw new Error(`FakeDaytonaSandboxClient.resume: sandbox ${state.sandboxId} not found`);
    }
    return this.#wrap(record);
  }

  async tryResumeByTaskId(taskId: string): Promise<SandboxSession<DaytonaSessionState> | null> {
    for (const record of this.#sandboxes.values()) {
      if (record.taskId === taskId) {
        return this.#wrap(record);
      }
    }
    return null;
  }

  async delete(session: SandboxSession<DaytonaSessionState>): Promise<void> {
    const record = this.#sandboxes.get(session.state.sandboxId);
    if (!record) return;
    this.#sandboxes.delete(record.sandboxId);
    rmSync(record.sandboxRoot, { recursive: true, force: true });
  }

  async deleteByTaskId(taskId: string): Promise<void> {
    for (const record of [...this.#sandboxes.values()]) {
      if (record.taskId === taskId) {
        this.#sandboxes.delete(record.sandboxId);
        rmSync(record.sandboxRoot, { recursive: true, force: true });
      }
    }
  }

  serializeState(state: DaytonaSessionState): Record<string, unknown> {
    return DaytonaSessionStateSchema.parse(state);
  }

  deserializeState(payload: Record<string, unknown>): DaytonaSessionState {
    return DaytonaSessionStateSchema.parse(payload);
  }

  async shutdown(): Promise<void> {
    for (const record of this.#sandboxes.values()) {
      rmSync(record.sandboxRoot, { recursive: true, force: true });
    }
    this.#sandboxes.clear();
  }

  // ── internals ───────────────────────────────────────────────────────

  /**
   * Clone the orchestrator-pushed run-branch (`cogmo/run/<task-id>`) into
   * the fake sandbox's `/workspace`. HTTPS basic auth credentials are
   * injected into the URL — same shape `DaytonaSandboxClient` passes
   * positionally to `sandbox.git.clone()`.
   */
  async #cloneGitRemote(
    worktree: { url: string; branch: string; auth: { username: string; password: string } },
    sandboxRoot: string,
  ): Promise<void> {
    const workspacePath = join(sandboxRoot, "workspace");
    const authedUrl = injectHttpsAuth(worktree.url, worktree.auth);
    await execFileP("git", ["clone", "--branch", worktree.branch, authedUrl, workspacePath]);
  }

  /**
   * Mirror the orchestrator-side askpass dir into the sandbox root so
   * host-side `git` running with `GIT_ASKPASS=<sandboxRoot>/.cogmo-askpass/helper`
   * sees the same file layout the real Daytona path produces. The helper
   * script's body bakes in a path under `containerDir` ; rewrite it to
   * point at the mirrored copy so `cat` finds the PAT file.
   */
  async #mirrorAskpass(
    sourceHostDir: string,
    sandboxRoot: string,
  ): Promise<FakeSandboxRecord["askpass"]> {
    const containerDir = join(sandboxRoot, ".cogmo-askpass");
    await mkdir(containerDir, { recursive: true });

    for (const name of ["helper", "pat", "signing-key", "signing-key.pub"]) {
      const src = join(sourceHostDir, name);
      const dst = join(containerDir, name);
      if (!existsSync(src)) continue;
      const body = readFileSync(src, "utf8");
      // The helper script embeds the container path. Rewrite it to the
      // mirrored host copy so host-side `git` can execute it directly.
      const rewritten =
        name === "helper" ? body.split(ASKPASS_CONTAINER_DIR).join(containerDir) : body;
      // Modes: `helper` 0o755, signing-key 0o600, others 0o644 (matches
      // the real askpass-upload step's modes).
      const mode = name === "helper" ? 0o755 : name === "signing-key" ? 0o600 : 0o644;
      writeFileSync(dst, rewritten, { mode });
    }
    return { sourceHostDir, containerDir };
  }

  #wrap(record: FakeSandboxRecord): SandboxSession<DaytonaSessionState> {
    const state: DaytonaSessionState = {
      type: "daytona",
      taskId: record.taskId,
      sandboxId: record.sandboxId,
    };
    return new FakeDaytonaSandboxSession(state, record);
  }
}

class FakeDaytonaSandboxSession implements SandboxSession<DaytonaSessionState> {
  readonly state: DaytonaSessionState;
  #record: FakeSandboxRecord;

  constructor(state: DaytonaSessionState, record: FakeSandboxRecord) {
    this.state = state;
    this.#record = record;
  }

  async exec(cmd: readonly string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd.length === 0) {
      throw new Error("exec: empty command");
    }
    const startedAt = Date.now();
    const prepared = this.#prepare(cmd, opts);
    type ExecError = NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    const result = await execFileP(prepared.argv[0] ?? "", prepared.argv.slice(1), {
      cwd: prepared.cwd,
      env: prepared.env,
    }).then(
      (r) => ({ stdout: r.stdout, stderr: r.stderr, exitCode: 0 }),
      (err: ExecError) => {
        // Numeric `code` = process exit code; surface it. String `code`
        // (e.g. "ENOENT" when the binary isn't on PATH) is a spawn-side
        // failure — masking it as `exitCode: 1` hides bugs that real
        // backends would error on. Rethrow so the caller sees the
        // original error instead of a fake exit code.
        if (typeof err.code === "number") {
          return {
            stdout: err.stdout ?? "",
            stderr: err.stderr ?? String(err),
            exitCode: err.code,
          };
        }
        throw err;
      },
    );
    return {
      ...result,
      wallTimeSeconds: (Date.now() - startedAt) / 1000,
      truncated: false,
    };
  }

  async execStreaming(cmd: readonly string[], opts?: ExecOptions): Promise<ExecStreamingHandle> {
    if (cmd.length === 0) {
      throw new Error("execStreaming: empty command");
    }
    const prepared = this.#prepare(cmd, opts);
    // True streaming: `spawn` returns immediately with live stdout /
    // stderr `Readable`s; the caller consumes (or `dispose`s) them
    // while the process runs. `wait()` resolves when the process
    // closes — `close` (not `exit`) so EOF on stdout/stderr has
    // already been delivered, matching the real ExecStreamingHandle
    // contract.
    const child = spawn(prepared.argv[0] ?? "", prepared.argv.slice(1), {
      cwd: prepared.cwd,
      env: prepared.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let resolveExit!: (value: { exitCode: number }) => void;
    let rejectExit!: (err: Error) => void;
    const exitPromise = new Promise<{ exitCode: number }>((resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    });
    // Pre-attach a silent catch so a caller that disposes without
    // observing `wait()` doesn't trip Node's unhandledRejection
    // detector — `wait()` returns the original promise, so callers
    // that DO observe still see the rejection.
    exitPromise.catch(() => {});
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      rejectExit(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolveExit({ exitCode: typeof code === "number" ? code : 1 });
    });

    // ChildProcess.stdout/stderr are `Readable | null`; with
    // `stdio: ["ignore", "pipe", "pipe"]` they're guaranteed non-null
    // but TS can't narrow that based on the stdio config. expectDefined
    // does the runtime narrowing without a cast.
    const stdout = expectDefined(child.stdout, "child.stdout");
    const stderr = expectDefined(child.stderr, "child.stderr");

    let disposed = false;
    return {
      stdout,
      stderr,
      wait: () => exitPromise,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        // Match the documented `ExecStreamingHandle` contract: after
        // dispose(), wait() rejects with `DisposedError`. The real
        // Daytona backend's exec-streaming wrapper rejects the same
        // way; the local-Docker dockerode adapter does too. Surface it
        // before SIGTERM so a caller racing dispose against natural
        // exit can rely on the rejection regardless of timing.
        if (!settled) {
          settled = true;
          rejectExit(new DisposedError());
        }
        try {
          child.kill("SIGTERM");
        } catch {
          // Already exited between the settled-check and the kill —
          // ignore. Idempotent.
        }
      },
    };
  }

  #prepare(
    cmd: readonly string[],
    opts: ExecOptions | undefined,
  ): { argv: string[]; cwd: string; env: Record<string, string> } {
    const cwd = resolveCwd(opts?.workingDir, this.#record);
    const env = composeEnv(opts?.env, this.#record);
    // The path-substitution mirror for askpass paths: the orchestrator
    // threads `GIT_ASKPASS=/.cogmo-askpass/helper` etc. The real backend
    // serves the askpass dir at that container path; the fake remaps to
    // `<sandboxRoot>/.cogmo-askpass/...` so host-side `git` can resolve.
    const askpassMirror = this.#record.askpass?.containerDir;
    const argv = askpassMirror ? cmd.map((a) => rewriteAskpass(a, askpassMirror)) : [...cmd];
    return { argv, cwd, env };
  }
}

function resolveCwd(workingDir: string | undefined, record: FakeSandboxRecord): string {
  const workspaceRoot = join(record.sandboxRoot, "workspace");
  if (workingDir === undefined || workingDir === WORKTREE_PATH_IN_SANDBOX) {
    return workspaceRoot;
  }
  // Subpaths of /workspace get remapped relative to the sandbox-root
  // workspace — a working_dir of `/workspace/src` resolves to
  // `<sandboxRoot>/workspace/src`. Without this, the literal path
  // would route to the host's `/workspace/src`, which doesn't exist.
  const prefix = `${WORKTREE_PATH_IN_SANDBOX}/`;
  if (workingDir.startsWith(prefix)) {
    return join(workspaceRoot, workingDir.slice(prefix.length));
  }
  return workingDir;
}

function composeEnv(
  override: Readonly<Record<string, string>> | undefined,
  record: FakeSandboxRecord,
): Record<string, string> {
  // Inherited `process.env` is NOT rewritten — only the orchestrator-
  // injected `override` values are. The orchestrator threads
  // `GIT_ASKPASS=/.cogmo-askpass/helper` exclusively via override; an
  // inherited env var that happens to contain the canonical path
  // would be host-side already and shouldn't be rewritten.
  const base: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  if (override) {
    for (const [k, v] of Object.entries(override)) {
      base[k] = record.askpass ? rewriteAskpass(v, record.askpass.containerDir) : v;
    }
  }
  return base;
}

/**
 * Rewrite any reference to the canonical container path
 * (`/.cogmo-askpass`) to the host-mirrored copy. Operates string-by-string
 * so paths embedded in env values, exec args, or signing-key paths all
 * resolve to the host filesystem.
 */
function rewriteAskpass(s: string, mirroredHostDir: string): string {
  return s.split(ASKPASS_CONTAINER_DIR).join(mirroredHostDir);
}

/**
 * Inject HTTPS basic auth credentials into a URL. Mirrors what
 * `sandbox.git.clone(url, ..., username, password)` does inside Daytona's
 * SDK — git's built-in `https://user:pass@host/...` form.
 */
function injectHttpsAuth(url: string, auth: { username: string; password: string }): string {
  const parsed = new URL(url);
  parsed.username = encodeURIComponent(auth.username);
  parsed.password = encodeURIComponent(auth.password);
  return parsed.toString();
}
