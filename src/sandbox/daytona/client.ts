import { Daytona, type Sandbox as DaytonaSdkSandbox, SandboxState } from "@daytonaio/sdk";
import { logger } from "../../logger.js";
import {
  type DaytonaSessionState,
  DaytonaSessionStateSchema,
  type SandboxCapabilities,
  type SandboxClient,
  type SandboxSession,
  type SessionSpec,
} from "../index.js";
import { daytonaHealthProbe } from "./probe.js";
import { DaytonaSandboxSession } from "./session.js";

const log = logger.child({ component: "sandbox.daytona.client" });

/** Cogmo label keys on Daytona sandboxes — used for `tryResumeByTaskId` lookup. */
const LABEL_TASK = "cogmo.task";
const LABEL_ROLE = "cogmo.role";

/** Refresh the sandbox's auto-stop activity timer this often, while a session is live. */
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;

const CAPABILITIES: SandboxCapabilities = {
  // Code inside the sandbox can spawn child containers, but they're
  // visible only to Daytona — Cogmo's host-proxy doesn't observe them.
  siblingContainers: "sandbox-internal",
  hostBindMount: false,
  customImage: true,
  volumes: "managed",
  workingTreeTransport: "git-remote",
};

export interface DaytonaSandboxClientOptions {
  /** Daytona API key. Read from the encrypted `secrets` table at bootstrap. */
  apiKey: string;
  /** Defaults to Daytona Cloud (`https://app.daytona.io/api`). Set for self-hosted. */
  apiUrl?: string;
  /** Optional org id when the API key is scoped to multiple orgs. */
  organizationId?: string;
}

interface CreateOptions extends DaytonaSandboxClientOptions {
  /**
   * Cogmo instance id — stamped on every sandbox label so a future
   * reconcile pass can identify orphans from a crashed prior run. Not
   * used as a label-filter key today (we filter by taskId instead) but
   * preserved for symmetry with the Local-Docker backend's
   * `cogmo.instance` label.
   */
  instanceId: string;
}

/**
 * Phase 3a: worktree-less only. Skills tier-2 works end-to-end on this
 * backend; coding-delegation calls (which set `spec.worktree`) throw a
 * deliberate "not yet supported" error until Phase 3b lands the
 * git-as-transport flow. The capability flag advertises `git-remote`
 * already so consumers can branch correctly when 3b ships.
 */
export class DaytonaSandboxClient implements SandboxClient<DaytonaSessionState> {
  readonly backendId = "daytona";
  readonly capabilities = CAPABILITIES;

  #daytona: Daytona;
  #instanceId: string;
  /**
   * Per-sandbox keepalive timers. `refreshActivity()` resets the
   * sandbox's auto-stop countdown so multi-minute coding tasks don't
   * get reaped mid-flight by Daytona's default 15-min idle policy.
   * The timer self-stops once `Date.now()` passes the session's
   * `expiresAt` so the auto-stop reaper can do its job; the entry
   * also gets cleared on `delete` / `deleteByTaskId` / `shutdown`.
   */
  #keepalives = new Map<string, NodeJS.Timeout>();

  private constructor(opts: CreateOptions) {
    const config: ConstructorParameters<typeof Daytona>[0] = {
      apiKey: opts.apiKey,
    };
    if (opts.apiUrl) config.apiUrl = opts.apiUrl;
    if (opts.organizationId) config.organizationId = opts.organizationId;
    this.#daytona = new Daytona(config);
    this.#instanceId = opts.instanceId;
  }

  static async create(opts: CreateOptions): Promise<DaytonaSandboxClient> {
    return new DaytonaSandboxClient(opts);
  }

  async healthCheck(): Promise<{ ok: true; runtime: string }> {
    await daytonaHealthProbe(this.#daytona);
    return { ok: true, runtime: "daytona" };
  }

  async reconcileCrashedInstances(_currentInstanceId: string): Promise<{ orphansReaped: number }> {
    // Daytona auto-persists across stop and auto-archives after the
    // configured interval; orphan cleanup is the provider's job. We
    // never reap on Cogmo restart for this backend.
    return { orphansReaped: 0 };
  }

  async ensureImagePresent(_image: string): Promise<void> {
    // Daytona's builder pulls the image (and synthesises a snapshot) on
    // first `create()`; subsequent creates reuse the snapshot. There's
    // no separate "is this image reachable" probe in the SDK, and
    // forcing a probe via a throwaway sandbox would actually pay the
    // build cost. No-op: the first real `create()` carries the latency.
  }

  async create(spec: SessionSpec): Promise<SandboxSession<DaytonaSessionState>> {
    if (spec.worktree) {
      // Phase 3b will accept `worktree: { type: "git-remote", ... }` and
      // run `sandbox.git.clone()` inside `create()`. Until then, the
      // orchestrator's host-path worktree path is rejected outright so
      // a misconfiguration (`SANDBOX_BACKEND=daytona` with the coding
      // pipeline) fails fast with a clear message.
      throw new Error(
        "DaytonaSandboxClient.create: SessionSpec.worktree is not supported in Phase 3a (coding-on-Daytona arrives in Phase 3b)",
      );
    }
    if (spec.askpass) {
      throw new Error(
        "DaytonaSandboxClient.create: SessionSpec.askpass is not supported in Phase 3a",
      );
    }
    if (spec.homeVolume) {
      throw new Error(
        "DaytonaSandboxClient.create: SessionSpec.homeVolume is unused — Daytona auto-persists sandbox FS across stop/start cycles. Drop the field.",
      );
    }
    if (spec.allowPrivilegedRunc) {
      throw new Error(
        "DaytonaSandboxClient.create: SessionSpec.allowPrivilegedRunc is Local-Docker-specific — Daytona uses the provider's runtime",
      );
    }

    const autoStopInterval = computeAutoStopInterval(spec.expiresAt);
    log.info(
      { taskId: spec.taskId, image: spec.image, autoStopInterval },
      "creating Daytona sandbox",
    );
    const sdkSandbox = await this.#daytona.create({
      image: spec.image,
      labels: {
        [LABEL_TASK]: spec.taskId,
        [LABEL_ROLE]: "root",
        "cogmo.instance": this.#instanceId,
      },
      autoStopInterval,
      resources: resourcesFromLimits(spec.resourceLimits),
      // Empty / absent env must NOT clobber the image's defaults; only
      // spread `envVars` when populated.
      ...(spec.env && Object.keys(spec.env).length > 0 && { envVars: { ...spec.env } }),
    });

    return this.#wrap(sdkSandbox, spec.taskId, spec.expiresAt);
  }

  async resume(state: DaytonaSessionState): Promise<SandboxSession<DaytonaSessionState>> {
    const sdkSandbox = await this.#daytona.get(state.sandboxId);
    // Daytona auto-persists across stops; restart if needed so the next
    // exec doesn't 4xx with "sandbox not running".
    if (sdkSandbox.state === SandboxState.STOPPED || sdkSandbox.state === SandboxState.ARCHIVED) {
      log.info({ sandboxId: state.sandboxId, prior: sdkSandbox.state }, "resuming Daytona sandbox");
      await sdkSandbox.start();
    } else if (
      sdkSandbox.state === SandboxState.DESTROYED ||
      sdkSandbox.state === SandboxState.ERROR ||
      sdkSandbox.state === SandboxState.BUILD_FAILED
    ) {
      throw new Error(
        `Daytona sandbox ${state.sandboxId} is terminal (state=${sdkSandbox.state}); cannot resume`,
      );
    }
    return this.#wrap(sdkSandbox, state.taskId);
  }

  async tryResumeByTaskId(taskId: string): Promise<SandboxSession<DaytonaSessionState> | null> {
    const result = await this.#daytona.list({ [LABEL_TASK]: taskId, [LABEL_ROLE]: "root" });
    for (const sdkSandbox of result.items) {
      if (
        sdkSandbox.state === SandboxState.DESTROYED ||
        sdkSandbox.state === SandboxState.ERROR ||
        sdkSandbox.state === SandboxState.BUILD_FAILED
      ) {
        continue;
      }
      // STOPPED / ARCHIVED auto-persist across the call — restart on
      // next `resume()`. Returning the current SDK handle here is fine;
      // execStreaming will fail until the caller calls `resume(state)`,
      // which is the canonical re-attach path.
      if (sdkSandbox.state === SandboxState.STOPPED || sdkSandbox.state === SandboxState.ARCHIVED) {
        await sdkSandbox.start();
      }
      return this.#wrap(sdkSandbox, taskId);
    }
    return null;
  }

  async delete(session: SandboxSession<DaytonaSessionState>): Promise<void> {
    // Stop the keepalive by sandboxId BEFORE the cascade list call, so
    // that a missing-on-provider sandbox (already auto-stopped + reaped
    // before we got here) still has its in-process timer torn down.
    // `deleteByTaskId` also calls `#stopKeepalive` per item it finds —
    // the duplicate is a no-op via the `if (handle)` guard.
    this.#stopKeepalive(session.state.sandboxId);
    await this.deleteByTaskId(session.state.taskId);
  }

  async deleteByTaskId(taskId: string): Promise<void> {
    // Find by `cogmo.task` only — NOT also `cogmo.role: "root"` like
    // `tryResumeByTaskId` does. Today every sandbox we create stamps
    // `cogmo.role: "root"`, so the filter is functionally identical;
    // the role-less query is forward-compat for if Phase 3b grows
    // child / sibling sandboxes per task. Catching every sandbox
    // tagged with the taskId at delete time guarantees a single
    // deleteByTaskId call cascades the whole tree, not just the root.
    const result = await this.#daytona.list({ [LABEL_TASK]: taskId });
    for (const sdkSandbox of result.items) {
      this.#stopKeepalive(sdkSandbox.id);
      try {
        await sdkSandbox.delete();
      } catch (err) {
        // Already gone, daemon error, etc. — log and continue.
        log.warn(
          { err: (err as Error).message, sandboxId: sdkSandbox.id, taskId },
          "deleteByTaskId: sandbox.delete failed",
        );
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
    // Stop every keepalive ticker; sandboxes themselves persist in
    // Daytona Cloud across our process restart by design.
    for (const sandboxId of this.#keepalives.keys()) {
      this.#stopKeepalive(sandboxId);
    }
  }

  // ── internals ───────────────────────────────────────────────────────

  #wrap(
    sdkSandbox: DaytonaSdkSandbox,
    taskId: string,
    expiresAt?: Date,
  ): SandboxSession<DaytonaSessionState> {
    this.#startKeepalive(sdkSandbox, expiresAt);
    return new DaytonaSandboxSession({
      state: { type: "daytona", taskId, sandboxId: sdkSandbox.id },
      sdkSandbox,
    });
  }

  /**
   * Start a per-sandbox keepalive ticker. When `expiresAt` is provided
   * (the create() path), the ticker self-stops once the deadline
   * passes — at that point we WANT Daytona's auto-stop reaper to take
   * over, so calling `refreshActivity()` past the deadline would
   * defeat the explicit task budget. When `expiresAt` is omitted (the
   * resume() / tryResumeByTaskId() paths — operator brought the
   * sandbox back, intent is unclear), the ticker fires unconditionally
   * and only stops on `delete` / `shutdown`.
   */
  #startKeepalive(sdkSandbox: DaytonaSdkSandbox, expiresAt?: Date): void {
    if (this.#keepalives.has(sdkSandbox.id)) return;
    const expiresAtMs = expiresAt?.getTime();
    const sandboxId = sdkSandbox.id;
    const handle = setInterval(() => {
      // Use `>=` so a tick at the exact deadline stops cleanly rather
      // than firing one last refresh; the sandbox's own
      // `autoStopInterval` (set at create-time from the same
      // `expiresAt`) takes over from here.
      if (expiresAtMs !== undefined && Date.now() >= expiresAtMs) {
        this.#stopKeepalive(sandboxId);
        return;
      }
      sdkSandbox.refreshActivity().catch((err: unknown) => {
        log.warn({ err: (err as Error).message, sandboxId }, "refreshActivity failed");
      });
    }, KEEPALIVE_INTERVAL_MS);
    // setInterval keeps the event loop alive; unref so the process can
    // exit cleanly when the keepalive is the only remaining handle.
    handle.unref();
    this.#keepalives.set(sandboxId, handle);
  }

  #stopKeepalive(sandboxId: string): void {
    const handle = this.#keepalives.get(sandboxId);
    if (handle) {
      clearInterval(handle);
      this.#keepalives.delete(sandboxId);
    }
  }
}

/**
 * Round up the sandbox's auto-stop interval to the nearest minute, with
 * a 1-minute floor. Daytona expects minutes; we get a `Date`. The
 * floor avoids "zero minutes = disable auto-stop", which would never
 * reap the sandbox if our explicit `delete` never fires.
 */
function computeAutoStopInterval(expiresAt: Date): number {
  const ms = expiresAt.getTime() - Date.now();
  return Math.max(1, Math.ceil(ms / 60_000));
}

/**
 * Map Cogmo's `ResourceLimits` (cpus + memory_bytes + pids) onto
 * Daytona's `Resources` shape. `pids` has no Daytona equivalent and is
 * silently dropped — documented in `design/sandbox.md` → Daytona Backend.
 */
function resourcesFromLimits(limits: { cpus: number; memory_bytes: number; pids: number }): {
  cpu: number;
  memory: number;
} {
  return {
    cpu: Math.max(1, Math.ceil(limits.cpus)),
    // Daytona's `memory` is GiB. Round up so under-provisioning never
    // happens when the caller passed bytes that don't align cleanly.
    memory: Math.max(1, Math.ceil(limits.memory_bytes / (1024 * 1024 * 1024))),
  };
}
