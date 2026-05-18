import {
  Daytona,
  DaytonaNotFoundError,
  type Sandbox as DaytonaSdkSandbox,
  SandboxState,
} from "@daytonaio/sdk";
import { logger } from "../../logger.js";
import {
  type DaytonaSessionState,
  DaytonaSessionStateSchema,
  type SandboxCapabilities,
  type SandboxClient,
  type SandboxSession,
  type SessionSpec,
} from "../index.js";
import { uploadAskpassToSandbox } from "./askpass-upload.js";
import { daytonaHealthProbe } from "./probe.js";
import { DaytonaSandboxSession } from "./session.js";

/**
 * Snapshot lifecycle states. The literal set comes from `@daytona/api-client`'s
 * `SnapshotState` enum, which `@daytonaio/sdk` exposes only via the `Snapshot`
 * type but doesn't re-export as a runtime value. Hardcoded here so we don't
 * have to depend on `@daytona/api-client` (transitive) directly. If the SDK
 * grows a state, the state-machine in `#ensureSnapshotActive` defaults to
 * delete-and-rebuild for unknown states.
 */
const SnapshotState = {
  BUILDING: "building",
  PENDING: "pending",
  PULLING: "pulling",
  ACTIVE: "active",
  INACTIVE: "inactive",
  ERROR: "error",
  BUILD_FAILED: "build_failed",
  REMOVING: "removing",
} as const;

/**
 * Where the cloned worktree lives inside the sandbox. Matches the
 * `/workspace` bind-mount target Local-Docker uses, so downstream code
 * (`runCommitAndPush`, the verify orchestrator) can use the same path
 * regardless of backend.
 */
const WORKTREE_PATH = "/workspace";

const log = logger.child({ component: "sandbox.daytona.client" });

/** Cogmo label keys on Daytona sandboxes — used for `tryResumeByTaskId` lookup. */
const LABEL_TASK = "cogmo.task";
const LABEL_ROLE = "cogmo.role";

/** Refresh the sandbox's auto-stop activity timer this often, while a session is live. */
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Poll cadence for `snapshot.get(...).state` while waiting for an
 * in-flight snapshot build to land on a terminal state. Matches the
 * SDK's own internal cadence (`Snapshot.js`).
 */
const SNAPSHOT_POLL_INTERVAL_MS = 1_000;

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
 * Daytona-backed sandbox client. Supports two consumer flows:
 *
 *   - Skills tier-2 (Phase 3a): worktree-less, ephemeral. `create()`
 *     omits both `worktree` and `askpass`; the sandbox is just an
 *     isolated process host.
 *   - Coding-delegation (Phase 3b): `WorktreeSpec` with
 *     `type: "git-remote"` triggers `sandbox.git.clone()` from the
 *     orchestrator-pushed `cogmo/run/<task-id>` ref. `SessionSpec.askpass`
 *     uploads the four-file bundle (`helper`, `pat`, `signing-key`,
 *     `signing-key.pub`) via `fs.uploadFiles` + `fs.setFilePermissions`
 *     so the in-container git operations see the same askpass layout
 *     as the Local-Docker backend's bind-mount.
 *
 * The capability flag advertises `workingTreeTransport: "git-remote"`;
 * orchestrators branch on it without backend awareness.
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
  /**
   * Per-image in-flight snapshot-warm promises. First call for a given
   * image kicks off `ensureSnapshot(...)`; concurrent calls await the
   * same promise. Resolved promises are kept so steady-state calls are
   * one Map lookup. Rejected promises are evicted in the `.catch` so the
   * next call retries fresh instead of inheriting the failure.
   */
  #warmPromises = new Map<string, Promise<void>>();
  /**
   * Per-image snapshot name once warmed successfully. `create()` checks
   * this map: a hit means it can dispatch `daytona.create({ snapshot })`
   * (fast path, sub-second on Daytona's runner cache); a miss means
   * `ensureImagePresent` hasn't been called or skipped warming for an
   * unversioned tag, so we fall back to `daytona.create({ image })`
   * which lazy-builds the snapshot on the provider side.
   */
  #snapshotByImage = new Map<string, string>();

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

  async ensureImagePresent(image: string): Promise<void> {
    // Pre-bake a named snapshot via `daytona.snapshot.create({ name, image })`
    // so subsequent `daytona.create({ snapshot: name })` calls hit Daytona's
    // runner cache and provision in ~1s instead of paying the multi-minute
    // image-pull-and-snapshot-build cost on first task. Daytona's own
    // `daytona.create({ image })` path lazy-builds the snapshot and the
    // SDK's hardcoded 60s `waitUntilStarted` cap fires before any
    // realistic image build completes; using the snapshot reference
    // splits the long-pole work into a dedicated `snapshot.create`
    // call that blocks until ACTIVE.
    //
    // Idempotent + memoised: concurrent callers share one warm cycle.
    // A failed warm clears the cache (`.catch` below) so the next caller
    // retries fresh instead of inheriting the failure.
    const name = snapshotNameFor(image);
    if (!name) {
      // Unversioned tag (`:latest`, no tag) — Daytona's `snapshot.create`
      // rejects these with "Images with tag ':latest' are not allowed",
      // so we let `create()` fall back to the lazy `{ image }` path. The
      // miss is documented; the path still works, just slow on first call.
      return;
    }
    let promise = this.#warmPromises.get(image);
    if (!promise) {
      promise = this.#ensureSnapshotActive(image, name).then(
        () => {
          this.#snapshotByImage.set(image, name);
        },
        (err: unknown) => {
          // Evict on rejection so the next call retries fresh.
          this.#warmPromises.delete(image);
          throw err;
        },
      );
      this.#warmPromises.set(image, promise);
    }
    await promise;
  }

  /**
   * Drive a snapshot to the `ACTIVE` state. Walks the state machine
   * exposed by Daytona's snapshot API:
   *
   *   - `ACTIVE` — return immediately.
   *   - `BUILDING` / `PENDING` / `PULLING` — server-side build is
   *     in-flight (e.g. another cogmo instance kicked it off, or a
   *     previous boot of this instance). Poll until terminal.
   *   - `ERROR` / `BUILD_FAILED` — prior attempt failed. Delete the
   *     stale snapshot so the create below isn't blocked by a name
   *     conflict, then rebuild.
   *   - `INACTIVE` / `REMOVING` — best effort: delete + recreate.
   *   - Not found (DaytonaNotFoundError) — first warm, fall through to
   *     `snapshot.create` directly.
   *
   * `snapshot.create()` itself blocks until terminal (per
   * `@daytonaio/sdk` `Snapshot.js`'s internal poll), so once we kick off
   * a build the wait happens inside the SDK call.
   */
  async #ensureSnapshotActive(image: string, name: string): Promise<void> {
    log.info({ image, snapshot: name }, "ensuring Daytona snapshot is active");
    try {
      const existing = await this.#daytona.snapshot.get(name);
      if (existing.state === SnapshotState.ACTIVE) {
        log.debug({ image, snapshot: name }, "snapshot already active");
        return;
      }
      if (
        existing.state === SnapshotState.BUILDING ||
        existing.state === SnapshotState.PENDING ||
        existing.state === SnapshotState.PULLING
      ) {
        log.info(
          { image, snapshot: name, state: existing.state },
          "snapshot build in flight — polling for terminal state",
        );
        const settled = await this.#pollSnapshotUntilTerminal(name);
        if (settled.state === SnapshotState.ACTIVE) return;
        // Build-in-flight resolved to a failure — drop the stale row and
        // fall through to create below for a fresh attempt.
        await this.#daytona.snapshot.delete(settled).catch((err: unknown) => {
          log.warn(
            { err, image, snapshot: name, state: settled.state },
            "failed to delete snapshot in failure state — create may 409 on name conflict",
          );
        });
      } else {
        // INACTIVE / ERROR / BUILD_FAILED / REMOVING. Daytona has no
        // documented `reactivate` flow we can rely on here; delete and
        // rebuild is the safe path. Idempotent: `.catch` swallows
        // already-deleted / racing-with-another-instance.
        log.info(
          { image, snapshot: name, state: existing.state },
          "snapshot present but not active — deleting before rebuild",
        );
        await this.#daytona.snapshot.delete(existing).catch((err: unknown) => {
          log.warn(
            { err, image, snapshot: name, state: existing.state },
            "snapshot delete before rebuild failed — create may 409",
          );
        });
      }
    } catch (err) {
      if (!(err instanceof DaytonaNotFoundError)) throw err;
      // 404 — snapshot doesn't exist yet, proceed to create.
      log.info({ image, snapshot: name }, "snapshot not found — building");
    }
    // Build. SDK's `snapshot.create()` polls internally until terminal
    // and throws on `ERROR` / `BUILD_FAILED`. Resources are omitted —
    // Daytona's platform default is reasonable for cogmo's workloads
    // (coding-delegation: 2 cpu / 2 GiB; skills tier-2: smaller, but
    // over-provisioning by a factor of 2 is acceptable at single-user
    // scale). `CreateSandboxFromSnapshotParams` has no `resources` field
    // anyway — resources bake at snapshot creation time, so picking one
    // shape per image keeps the operational story simple.
    await this.#daytona.snapshot.create({ name, image });
    log.info({ image, snapshot: name }, "snapshot active");
  }

  async #pollSnapshotUntilTerminal(
    name: string,
  ): Promise<Awaited<ReturnType<Daytona["snapshot"]["get"]>>> {
    // No outer wall-clock cap. Daytona's snapshot build can legitimately
    // take many minutes for fresh images; the in-flight `Promise` returned
    // by `ensureImagePresent` is the natural backpressure mechanism —
    // boot fires-and-forgets, the orchestrator's `create-container` step
    // awaits the same promise. If a build genuinely never terminates
    // (provider outage), Daytona's auto-stop reaper would eventually
    // clean it up server-side and our next call would 404 and rebuild.
    while (true) {
      const snap = await this.#daytona.snapshot.get(name);
      if (
        snap.state === SnapshotState.ACTIVE ||
        snap.state === SnapshotState.ERROR ||
        snap.state === SnapshotState.BUILD_FAILED
      ) {
        return snap;
      }
      await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_POLL_INTERVAL_MS));
    }
  }

  async create(spec: SessionSpec): Promise<SandboxSession<DaytonaSessionState>> {
    if (spec.worktree && spec.worktree.type !== "git-remote") {
      // Capability advertises `workingTreeTransport: "git-remote"`. The
      // host-path variant only makes sense on Local-Docker; the
      // orchestrator should have picked the right shape, so an arrival
      // here is a wiring bug.
      throw new Error(
        `DaytonaSandboxClient.create: WorktreeSpec.type "${spec.worktree.type}" is not supported (capabilities advertise "git-remote")`,
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
    const warmedSnapshot = this.#snapshotByImage.get(spec.image);
    log.info(
      {
        taskId: spec.taskId,
        image: spec.image,
        snapshot: warmedSnapshot ?? null,
        autoStopInterval,
      },
      "creating Daytona sandbox",
    );
    // Prefer the warm snapshot path when `ensureImagePresent` has primed
    // it — Daytona's `daytona.create({ snapshot })` resolves in ~1s
    // against a cached runner versus 60s+ of waitUntilStarted that the
    // `{ image }` path pays on a fresh image. Resources baked into the
    // snapshot at warm time supersede `spec.resourceLimits` for the
    // snapshot path (`CreateSandboxFromSnapshotParams` has no resources
    // field); the `{ image }` fallback still honours them.
    const labels: Record<string, string> = {
      [LABEL_TASK]: spec.taskId,
      [LABEL_ROLE]: "root",
      "cogmo.instance": this.#instanceId,
    };
    const envVars = spec.env && Object.keys(spec.env).length > 0 ? { ...spec.env } : undefined;
    const sdkSandbox = warmedSnapshot
      ? await this.#daytona.create({
          snapshot: warmedSnapshot,
          labels,
          autoStopInterval,
          ...(envVars && { envVars }),
        })
      : await this.#daytona.create({
          image: spec.image,
          labels,
          autoStopInterval,
          resources: resourcesFromLimits(spec.resourceLimits),
          ...(envVars && { envVars }),
        });

    // Post-create provisioning. If any step throws, tear down the freshly
    // created sandbox before rethrowing so we don't leak provider
    // resources — Daytona's per-sandbox billing makes orphaning expensive.
    //
    // Order: askpass upload runs before clone. The two are independent on
    // SDK 0.173.0 (clone takes auth via positional args, not via the
    // helper), but the upload is bytes-small and clone is the long pole;
    // failing fast on the cheap step avoids paying clone time when auth
    // is misconfigured.
    try {
      if (spec.askpass) {
        await uploadAskpassToSandbox({
          sandbox: sdkSandbox,
          hostDir: spec.askpass.hostDir,
          containerDir: spec.askpass.containerDir,
        });
      }
      if (spec.worktree?.type === "git-remote") {
        const wt = spec.worktree;
        await sdkSandbox.git.clone(
          wt.url,
          WORKTREE_PATH,
          wt.branch,
          undefined,
          wt.auth.username,
          wt.auth.password,
        );
      }
    } catch (err) {
      // log.error rather than warn — a billable sandbox is being torn
      // down, so this should surface in alerting.
      log.error(
        { err: (err as Error).message, sandboxId: sdkSandbox.id, taskId: spec.taskId },
        "post-create provisioning failed — tearing down sandbox",
      );
      await sdkSandbox.delete().catch((teardownErr: Error) => {
        // The original failure already pinned a billable resource;
        // failure to tear it down means it stays pinned.
        log.error(
          { err: teardownErr.message, sandboxId: sdkSandbox.id },
          "teardown after failed provisioning also failed — sandbox may be orphaned",
        );
      });
      throw err;
    }

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
 * Map Cogmo's `ResourceLimits` (cpus + memory_bytes + pids + optional
 * disk_bytes) onto Daytona's `Resources` shape. `pids` has no Daytona
 * equivalent and is silently dropped — documented in `design/sandbox.md`
 * → Daytona Backend. `disk_bytes` is forwarded only when set so a caller
 * that omits it accepts the platform default (3 GiB at the time of writing).
 */
const GIB = 1024 * 1024 * 1024;

// Round up so under-provisioning never happens when the caller passed bytes
// that don't align cleanly to a GiB boundary, then floor at 1 to honor
// Daytona's per-resource minimum.
function daytonaUnit(n: number): number {
  return Math.max(1, Math.ceil(n));
}

/**
 * Derive a Daytona snapshot name from a container image reference, or
 * `null` if the image isn't snapshot-warmable. Daytona's
 * `snapshot.create` rejects `:latest` and accepts only stable refs;
 * tagless and `:latest` images fall back to the lazy `{ image }` path.
 *
 * Strategy: take the last `/`-separated segment of the image (drops
 * registry + path prefix), replace the tag separator `:` with `-`, and
 * lowercase. Result is deterministic per image so the same image used
 * across cogmo deploys reuses one snapshot.
 *
 *   ghcr.io/iskhakovt/cogmo-devbase:1.66.0 → cogmo-cogmo-devbase-1.66.0
 *   python:3.14-slim                       → cogmo-python-3.14-slim
 *   foo:latest                             → null
 *   foo                                    → null
 */
export function snapshotNameFor(image: string): string | null {
  const lastSlash = image.lastIndexOf("/");
  const slug = lastSlash >= 0 ? image.slice(lastSlash + 1) : image;
  const colon = slug.lastIndexOf(":");
  if (colon < 0) return null;
  const tag = slug.slice(colon + 1);
  if (tag === "" || tag === "latest") return null;
  return `cogmo-${slug.replace(":", "-").toLowerCase()}`;
}

function resourcesFromLimits(limits: {
  cpus: number;
  memory_bytes: number;
  pids: number;
  disk_bytes?: number | undefined;
}): {
  cpu: number;
  memory: number;
  disk?: number;
} {
  const result: { cpu: number; memory: number; disk?: number } = {
    cpu: daytonaUnit(limits.cpus),
    memory: daytonaUnit(limits.memory_bytes / GIB),
  };
  if (limits.disk_bytes !== undefined) {
    result.disk = daytonaUnit(limits.disk_bytes / GIB);
  }
  return result;
}
