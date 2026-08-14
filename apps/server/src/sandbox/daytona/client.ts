import { createHash, randomBytes } from "node:crypto";
import {
  Daytona,
  DaytonaConflictError,
  DaytonaConnectionError,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  type Sandbox as DaytonaSdkSandbox,
  SandboxState,
} from "@daytona/sdk";
import { logger } from "../../logger.js";
import { withRetry } from "../../util/with-retry.js";
import {
  type DaytonaSessionState,
  DaytonaSessionStateSchema,
  type ResourceLimits,
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
 * `SnapshotState` enum, which `@daytona/sdk` exposes only via the `Snapshot`
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

/**
 * After this much wall-clock spent waiting for a single snapshot build,
 * log a warning every interval so a stuck Daytona-side build doesn't
 * silently wedge an in-flight `ensureImagePresent` promise. Pure
 * observability — does NOT terminate the poll.
 */
const SLOW_POLL_LOG_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Retry budget for `snapshot.create` against Daytona-side transient
 * pipeline failures (see `isTransientSnapshotCreateError`). 3 retries
 * + initial attempt = 4 calls total over ~1-2-4s backoff. Persistent
 * failures (broken Dockerfile, auth, etc.) are filtered out by the
 * predicate so they fail fast.
 */
const SNAPSHOT_CREATE_RETRIES = 3;
const SNAPSHOT_CREATE_MIN_BACKOFF_MS = 1_000;
const SNAPSHOT_CREATE_MAX_BACKOFF_MS = 8_000;

const CAPABILITIES: SandboxCapabilities = {
  // Code inside the sandbox can spawn child containers, but they're
  // visible only to Daytona — Cogmo's host-proxy doesn't observe them.
  siblingContainers: "sandbox-internal",
  hostBindMount: false,
  customImage: true,
  volumes: "managed",
  workingTreeTransport: "git-remote",
  // Daytona Volumes are mountpoint-s3 FUSE: no hardlinks, no general
  // rename(2), no O_RDWR on existing files. uv's content-addressed
  // cache and the populate script's `mv -T` atomic publish both
  // require those ops. Skills tier-2 falls back to container-local
  // ephemeral `/skill-venvs` instead — the wiring layer (see
  // SkillRunnerImpl + createSkillDepsReaper) gates on this flag and
  // omits SessionSpec.depsCacheVolume.
  depsCacheSharing: "per-sandbox",
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
  /**
   * Conformance-tests-only override for per-call session-id
   * randomness, threaded into every `DaytonaSandboxSession` this
   * client mints. Tests pin a deterministic value so record/replay's
   * `(method, path)` FIFO matching stays stable.
   *
   * **MUST return values with collision-resistance comparable to
   * `randomUUID`'s 128-bit space.** A weak source (`() => "x"`)
   * would silently collide across concurrent sessions in the same
   * client and let `dispose()` on one exec tear down a sibling's
   * Daytona session. Off the public `DaytonaSandboxClientOptions`
   * type so production wiring can't reach it by accident.
   */
  random?: () => string;
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
  /**
   * Per-image resource limits baked into the cached snapshot, used to
   * detect drift: a later caller asking for different limits on the
   * same image silently gets the first caller's bake (the snapshot's
   * resources are baked at create time and not editable in-place).
   * Logged at warn-level so configuration drift surfaces operationally.
   */
  #resourcesByImage = new Map<string, ResourceLimits>();
  #random: (() => string) | undefined;

  private constructor(opts: CreateOptions) {
    const config: ConstructorParameters<typeof Daytona>[0] = {
      apiKey: opts.apiKey,
    };
    if (opts.apiUrl) config.apiUrl = opts.apiUrl;
    if (opts.organizationId) config.organizationId = opts.organizationId;
    this.#daytona = new Daytona(config);
    this.#instanceId = opts.instanceId;
    this.#random = opts.random;
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

  async ensureImagePresent(image: string, resourceLimits?: ResourceLimits): Promise<void> {
    // Bake a named snapshot so `daytona.create({ snapshot })` hits the
    // runner cache (~1s) instead of paying the SDK's 60s waitUntilStarted
    // cap on the lazy `{ image }` path — image builds routinely exceed
    // that cap. Memoised per image; rejected promises evict.
    const name = snapshotNameFor(image);
    if (!name) {
      // Daytona rejects `snapshot.create` for `:latest` and untagged
      // images. Fall through silently; `create()` uses the lazy path.
      return;
    }
    let promise = this.#warmPromises.get(image);
    if (promise) {
      // Snapshot resources are immutable post-create. A second caller
      // with different limits silently gets the first caller's bake —
      // warn so the drift is visible in logs.
      if (resourceLimits !== undefined) {
        const cached = this.#resourcesByImage.get(image);
        if (cached !== undefined && !resourceLimitsEqual(cached, resourceLimits)) {
          log.warn(
            { image, cached, requested: resourceLimits },
            "ensureImagePresent: resourceLimits differ from prior warm — snapshot is already baked, request ignored",
          );
        }
      }
    } else {
      // The resolved name may differ from `name` (rebuild path uses a
      // fresh suffix); cache the actual ACTIVE name.
      promise = this.#ensureSnapshotActive(image, name, resourceLimits).then(
        (activeName) => {
          this.#snapshotByImage.set(image, activeName);
          if (resourceLimits !== undefined) {
            this.#resourcesByImage.set(image, resourceLimits);
          }
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
   * Drive a snapshot to `ACTIVE` and return the live name. States:
   *
   *   - `ACTIVE` → return as-is.
   *   - `BUILDING` / `PENDING` / `PULLING` → poll until terminal.
   *   - `ERROR` / `BUILD_FAILED` / `INACTIVE` / `REMOVING` → fire-and-
   *     forget delete + rebuild under `<name>-r-<hex>`. Same-name
   *     recreate against an in-`REMOVING` row 409s — Daytona's delete
   *     is 2xx immediately but drains in the background.
   *   - Not found → build under the derived name.
   *
   * `snapshot.create()` blocks until terminal (SDK polls internally);
   * `withRetry` covers transient pipeline flakes.
   */
  async #ensureSnapshotActive(
    image: string,
    name: string,
    resourceLimits: ResourceLimits | undefined,
  ): Promise<string> {
    log.info({ image, snapshot: name }, "ensuring Daytona snapshot is active");
    try {
      const existing = await this.#daytona.snapshot.get(name);
      if (existing.state === SnapshotState.ACTIVE) {
        log.debug({ image, snapshot: name }, "snapshot already active");
        return name;
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
        if (settled.state === SnapshotState.ACTIVE) return name;
        // Build-in-flight resolved to a failure — drop the stale row
        // and rebuild under a fresh name below.
        this.#fireAndForgetDelete(settled, image);
      } else {
        // INACTIVE / ERROR / BUILD_FAILED / REMOVING. Rebuild under a
        // fresh name; never wait for the stale row's delete to drain.
        log.info(
          { image, snapshot: name, state: existing.state },
          "snapshot present but not active — rebuilding under fresh name",
        );
        this.#fireAndForgetDelete(existing, image);
      }
      return await this.#buildWithConflictRecovery(
        image,
        rebuildSnapshotName(name),
        resourceLimits,
      );
    } catch (err) {
      if (!(err instanceof DaytonaNotFoundError)) throw err;
      log.info({ image, snapshot: name }, "snapshot not found — building");
      return await this.#buildWithConflictRecovery(image, name, resourceLimits);
    }
  }

  /**
   * `#buildSnapshot` wrapped with one-shot 409-conflict recovery.
   * Daytona occasionally leaks a stub row when `snapshot.create`
   * retries internally — attempt 0 fails transient, attempt 1 409s on
   * the same name. The wrapper rebuilds once under `<name>-r-<hex>`.
   * Concurrent-warmer race (two callers both pass initial `get`
   * NotFound) lands here too — the loser pays a duplicate build;
   * benign at single-user scale.
   */
  async #buildWithConflictRecovery(
    image: string,
    name: string,
    resourceLimits: ResourceLimits | undefined,
  ): Promise<string> {
    try {
      return await this.#buildSnapshot(image, name, resourceLimits);
    } catch (err) {
      if (!(err instanceof DaytonaConflictError)) throw err;
      const rebuildName = rebuildSnapshotName(name);
      log.info(
        { image, originalName: name, rebuildName },
        "snapshot.create returned 409 — name taken (stale stub from a retried-create cycle); rebuilding under fresh name",
      );
      return await this.#buildSnapshot(image, rebuildName, resourceLimits);
    }
  }

  /**
   * `resourceLimits` bake into the snapshot — `daytona.create({
   * snapshot })` has no per-session resources override, so warm time
   * is the only chance to set them. Omitting falls back to Daytona's
   * platform default (1 cpu / 1 GiB / 3 GiB at the time of writing).
   */
  async #buildSnapshot(
    image: string,
    name: string,
    resourceLimits: ResourceLimits | undefined,
  ): Promise<string> {
    const resources = resourceLimits ? resourcesFromLimits(resourceLimits) : undefined;
    await withRetry(
      () =>
        this.#daytona.snapshot.create({
          name,
          image,
          ...(resources && { resources }),
        }),
      {
        retries: SNAPSHOT_CREATE_RETRIES,
        minTimeoutMs: SNAPSHOT_CREATE_MIN_BACKOFF_MS,
        maxTimeoutMs: SNAPSHOT_CREATE_MAX_BACKOFF_MS,
        context: `daytona.snapshot.create ${name}`,
        shouldRetry: isTransientSnapshotCreateError,
      },
    );
    log.info({ image, snapshot: name, resources }, "snapshot active");
    return name;
  }

  /** Rebuild uses a fresh name, so we never need to await the delete drain. */
  #fireAndForgetDelete(
    snapshot: Awaited<ReturnType<Daytona["snapshot"]["get"]>>,
    image: string,
  ): void {
    void this.#daytona.snapshot.delete(snapshot).catch((err: unknown) => {
      log.warn(
        { err, image, snapshot: snapshot.name, staleState: snapshot.state },
        "background delete of stale snapshot failed — Daytona reaper will retry",
      );
    });
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
    //
    // Exit condition is "treat unknown as terminal": continue only on
    // the documented in-flight set (BUILDING / PENDING / PULLING). Any
    // other observed state — ACTIVE (done), ERROR / BUILD_FAILED
    // (settled failure), INACTIVE / REMOVING (someone deactivated /
    // started deleting the row out from under us), or a future SDK
    // state we don't know about — returns and lets
    // `#ensureSnapshotActive` decide (return on ACTIVE, delete +
    // rebuild on anything else). Bounds the loop so a stuck state
    // can't wedge the warm-up forever.
    //
    // Observability: long polls log every `SLOW_POLL_LOG_INTERVAL_MS`
    // so a provider hang surfaces in the host log instead of
    // disappearing into a silent in-flight promise. No wall-clock cap;
    // the goal is visibility, not termination.
    const startedAt = Date.now();
    let lastSlowLogAt = startedAt;
    while (true) {
      const snap = await this.#daytona.snapshot.get(name);
      if (
        snap.state !== SnapshotState.BUILDING &&
        snap.state !== SnapshotState.PENDING &&
        snap.state !== SnapshotState.PULLING
      ) {
        return snap;
      }
      const now = Date.now();
      if (now - lastSlowLogAt >= SLOW_POLL_LOG_INTERVAL_MS) {
        log.warn(
          { snapshot: name, state: snap.state, elapsedMs: now - startedAt },
          "snapshot build still in flight after extended wait",
        );
        lastSlowLogAt = now;
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
    if (spec.depsCacheVolume) {
      // Daytona Volumes are mountpoint-s3 FUSE — no hardlinks, no
      // general rename(2), no O_RDWR on existing files. uv's cache
      // and the populate script's atomic publish require those ops,
      // so mounting the volume would wedge skill registration with
      // EPERM. `capabilities.depsCacheSharing === "per-sandbox"`
      // advertises this; the skill runner / reaper omit the field.
      throw new Error(
        "DaytonaSandboxClient.create: SessionSpec.depsCacheVolume is unsupported — capability advertises depsCacheSharing: 'per-sandbox'. Each sandbox uses container-local /skill-venvs instead.",
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
    const createFromImage = (): Promise<DaytonaSdkSandbox> =>
      this.#daytona.create({
        image: spec.image,
        labels,
        autoStopInterval,
        resources: resourcesFromLimits(spec.resourceLimits),
        ...(envVars && { envVars }),
      });
    let sdkSandbox: DaytonaSdkSandbox;
    if (warmedSnapshot) {
      try {
        sdkSandbox = await this.#daytona.create({
          snapshot: warmedSnapshot,
          labels,
          autoStopInterval,
          ...(envVars && { envVars }),
        });
      } catch (err) {
        // The cache holds the snapshot name from the last successful
        // warm; if the snapshot has since been deleted server-side
        // (dashboard cleanup, snapshot-GC cron, manual operator
        // intervention) Daytona returns NotFound. Evict the stale
        // cache entry, fire a non-blocking re-warm so the next task
        // hits the fast path, and fall back to the lazy `{ image }`
        // path for this call. Other error classes (auth, rate-limit,
        // connection) re-throw — masking them would hide real outages.
        if (err instanceof DaytonaNotFoundError) {
          log.warn(
            { image: spec.image, snapshot: warmedSnapshot },
            "snapshot reference returned NotFound — evicting cache + falling back to image",
          );
          this.#snapshotByImage.delete(spec.image);
          this.#warmPromises.delete(spec.image);
          // Forward limits so the re-baked snapshot carries the
          // consumer's intent, not Daytona's platform default.
          void this.ensureImagePresent(spec.image, spec.resourceLimits).catch(
            (rewarmErr: unknown) => {
              log.warn(
                { err: rewarmErr, image: spec.image },
                "background re-warm after NotFound failed — next task will fall back again",
              );
            },
          );
          sdkSandbox = await createFromImage();
        } else {
          throw err;
        }
      }
    } else {
      sdkSandbox = await createFromImage();
    }

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
    const matches = this.#daytona.list({ labels: { [LABEL_TASK]: taskId, [LABEL_ROLE]: "root" } });
    for await (const sdkSandbox of matches) {
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
    const matches = this.#daytona.list({ labels: { [LABEL_TASK]: taskId } });
    for await (const sdkSandbox of matches) {
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
      ...(this.#random && { random: this.#random }),
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
 * `null` if the image isn't snapshot-warmable. Tagless, `:latest`, and
 * digest-pinned images fall back to the lazy `{ image }` path.
 *
 * Composition: a human-readable slug from the final path segment for
 * dashboard greppability, plus an 8-hex-char content hash of the full
 * image string for collision resistance. The hash distinguishes
 * `a/cogmo-devbase:1.66.0` from `b/cogmo-devbase:1.66.0` — without it
 * two repos sharing a final segment would silently share one snapshot.
 *
 *   ghcr.io/iskhakovt/cogmo-devbase:1.66.0 → cogmo-cogmo-devbase-1.66.0-<hash>
 *   python:3.14-slim                       → cogmo-python-3.14-slim-<hash>
 *   foo:latest                             → null
 *   foo                                    → null
 *   foo@sha256:abcdef…                     → null  (digest pin)
 *
 * Digest pins are out of scope today because cogmo's devbase tags are
 * version-pinned, not digest-pinned. The naive lastIndexOf(":") split
 * would treat the digest's own `:` as a tag separator, producing a
 * malformed name. Cheaper to refuse the format than to special-case it.
 */
export function snapshotNameFor(image: string): string | null {
  if (image.includes("@")) return null;
  const lastSlash = image.lastIndexOf("/");
  const slug = lastSlash >= 0 ? image.slice(lastSlash + 1) : image;
  const colon = slug.lastIndexOf(":");
  if (colon < 0) return null;
  const tag = slug.slice(colon + 1);
  if (tag === "" || tag === "latest") return null;
  const slugSanitized = slug.replace(":", "-").toLowerCase();
  // 8 hex chars = 32 bits. ~1-in-4-billion collision rate is overkill
  // for single-user scale; cheap defence against same-final-segment
  // images from different registries.
  const hash = createHash("sha256").update(image).digest("hex").slice(0, 8);
  return `cogmo-${slugSanitized}-${hash}`;
}

/**
 * Suffix a base snapshot name with 32 bits of fresh entropy so a
 * rebuild can't collide with the in-`REMOVING` original. The
 * collision space (2^32) is large enough that a runaway rebuild loop
 * on the same image would have to fire ~65k times before a 50% birthday
 * collision — orders of magnitude past the bounded boot retry budget.
 */
function rebuildSnapshotName(base: string): string {
  return `${base}-r-${randomBytes(4).toString("hex")}`;
}

/**
 * Retries: rate-limit (429), connection errors, and the Daytona
 * internal-registry race (`repository … not found` from the builder
 * — daytonaio/daytona#3582). The SDK doesn't retry any of these
 * internally. Everything else — auth, validation, conflict, timeout,
 * Dockerfile errors — doesn't clear on retry and surfaces immediately.
 *
 * Exported for the matrix test in `client.test.ts`.
 */
export function isTransientSnapshotCreateError(err: unknown): boolean {
  if (err instanceof DaytonaRateLimitError) return true;
  if (err instanceof DaytonaConnectionError) return true;
  if (!(err instanceof Error)) return false;
  return /repository .* not found/i.test(err.message);
}

function resourceLimitsEqual(a: ResourceLimits, b: ResourceLimits): boolean {
  return (
    a.cpus === b.cpus &&
    a.memory_bytes === b.memory_bytes &&
    a.pids === b.pids &&
    a.disk_bytes === b.disk_bytes
  );
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
