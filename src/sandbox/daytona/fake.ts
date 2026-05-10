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

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { logger } from "../../logger.js";
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
} from "../index.js";

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

/** Container path the askpass helper resolves to. Mirrors `provisionAskpass`'s host layout. */
const ASKPASS_CONTAINER_DIR = "/.cogmo-askpass";

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
    const startedAt = Date.now();
    const { stdout, stderr, exitCode } = await this.#runOnHost(cmd, opts);
    return {
      stdout,
      stderr,
      exitCode,
      wallTimeSeconds: (Date.now() - startedAt) / 1000,
      truncated: false,
    };
  }

  async execStreaming(cmd: readonly string[], opts?: ExecOptions): Promise<ExecStreamingHandle> {
    const { stdout, stderr, exitCode } = await this.#runOnHost(cmd, opts);
    return {
      stdout: streamFromBuffer(Buffer.from(stdout)),
      stderr: streamFromBuffer(Buffer.from(stderr)),
      wait: async () => ({ exitCode }),
      dispose: async () => {},
    };
  }

  async #runOnHost(
    cmd: readonly string[],
    opts?: ExecOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (cmd.length === 0) {
      return { stdout: "", stderr: "exec: empty command", exitCode: 1 };
    }
    const cwd = resolveCwd(opts?.workingDir, this.#record);
    const env = composeEnv(opts?.env, this.#record);
    // The path-substitution mirror for askpass paths: the orchestrator
    // threads `GIT_ASKPASS=/.cogmo-askpass/helper` etc. The real backend
    // serves the askpass dir at that container path; the fake remaps to
    // `<sandboxRoot>/.cogmo-askpass/...` so host-side `git` can resolve.
    const askpassMirror = this.#record.askpass?.containerDir;
    const args = askpassMirror ? cmd.map((a) => rewriteAskpass(a, askpassMirror)) : [...cmd];

    return execFileP(args[0] ?? "", args.slice(1), { cwd, env }).then(
      (r) => ({ stdout: r.stdout, stderr: r.stderr, exitCode: 0 }),
      (err: NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string }) => ({
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? String(err),
        exitCode: typeof err.code === "number" ? err.code : 1,
      }),
    );
  }
}

function resolveCwd(workingDir: string | undefined, record: FakeSandboxRecord): string {
  if (workingDir === undefined) {
    return join(record.sandboxRoot, "workspace");
  }
  if (workingDir === WORKTREE_PATH_IN_SANDBOX) {
    return join(record.sandboxRoot, "workspace");
  }
  return workingDir;
}

function composeEnv(
  override: Readonly<Record<string, string>> | undefined,
  record: FakeSandboxRecord,
): Record<string, string> {
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

function streamFromBuffer(buf: Buffer): Readable {
  return new Readable({
    read() {
      this.push(buf);
      this.push(null);
    },
  });
}
