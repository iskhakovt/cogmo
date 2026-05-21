# Sandbox

Sandbox infrastructure. Any Cogmo feature needing isolated execution uses this module. Active consumers: coding-delegation tasks (worktree-bearing, long-lived, see [coding-delegation.md](coding-delegation.md)) and skills tier-2 (worktree-less, ephemeral Python subprocess workers, see [skills.md](skills.md)). Future consumers include untrusted MCP servers and one-off tool sandboxes.

## Purpose `[confirmed]`

Run arbitrary commands and downstream tooling in isolated environments. Two backend families share one abstraction:

- **Local-Docker** — task containers run directly against the host's Docker daemon, with a Cogmo proxy injecting policy at every container create. Userns boundary via sysbox. Suited to hosts that have Docker + sysbox installed.
- **Managed cloud** (Daytona) — task containers run in a third-party sandbox provider. Provider owns isolation and lifecycle; Cogmo drives via the provider's API.

Both paths offer:

- **Strong isolation by default** — userns on the local backend (sysbox), VM-class on managed backends.
- **One abstraction for downstream code** — the orchestrator, coding tool, and skills runner code against `SandboxClient` / `SandboxSession`, not against a specific provider.
- **Per-consumer images** — coding-delegation runs `cogmo/devbase` (with `claude-code` baked in); skills tier-2 runs `python:3.14-slim` (or a Cogmo-baked successor) by manifest. Image is per-session, not per-backend.

Compatibility with existing tooling — testcontainers, `docker compose`, `docker buildx` — is preserved. On the local backend they spawn host-visible siblings through the Cogmo proxy. On managed backends they spawn provider-internal siblings; the provider's sandbox boundary is the policy boundary.

A unified policy plane across both backend families is a non-goal. Policy lives where it can be enforced — Cogmo's Docker proxy on local, the provider's sandbox boundary on managed.

## Backend Architecture `[confirmed]`

### Two interfaces

`SandboxClient` is the factory — owns provider config, mints sessions, performs lifecycle operations. `SandboxSession` is the handle — owns one running task environment, exposes exec / file / git operations. The split mirrors the [OpenAI Agents SDK](https://github.com/openai/openai-agents-js/tree/main/packages/agents-core/src/sandbox) shape, which uses the same pattern to plug Daytona, E2B, Modal, Cloudflare Containers, etc. behind one abstraction.

```ts
interface SandboxClient<TState> {
  readonly backendId: string;
  readonly capabilities: SandboxCapabilities;

  /** Verify the backend is reachable + configured. Throws on misconfig. */
  healthCheck(): Promise<{ ok: true; runtime: string }>;

  /**
   * Boot-time reconciliation: kill any sessions tagged with a different
   * `cogmo.instance` than the current run. Runs once at startup; the
   * per-minute `reaper` keeps things tidy after that. No-op on managed
   * backends until they grow an orphan-reconcile pass of their own.
   */
  reconcileCrashedInstances(currentInstanceId: string): Promise<{ orphansReaped: number }>;

  /**
   * Ensure `image` is reachable from the backend (locally cached on
   * Local-Docker, registry-reachable on Daytona). Idempotent and cheap
   * when satisfied. Consumers call this before `create()` so the first
   * task doesn't pay an unbounded pull inside its own latency budget.
   */
  ensureImagePresent(image: string): Promise<void>;

  create(spec: SessionSpec): Promise<SandboxSession<TState>>;
  resume(state: TState): Promise<SandboxSession<TState>>;

  /**
   * Discover the live root session (depth-0 container created by the
   * orchestrator) for `taskId`, or null when none is currently alive.
   * Used in the orchestrator's get-or-create path after an idle TTL
   * where a prior session may or may not still exist.
   */
  tryResumeByTaskId(taskId: string): Promise<SandboxSession<TState> | null>;

  /** Tear down the session and its underlying sandbox (cascade). Idempotent. */
  delete(session: SandboxSession<TState>): Promise<void>;

  /**
   * Tear down every session whose state was created with the given
   * `taskId`, regardless of whether the orchestrator still holds a
   * handle. Used by failure cascades and the reaper. Idempotent.
   */
  deleteByTaskId(taskId: string): Promise<void>;

  serializeState(state: TState): Record<string, unknown>;
  deserializeState(payload: Record<string, unknown>): TState;

  /** Release backend-level resources (close docker connections, listeners). */
  shutdown(): Promise<void>;
}

interface SessionSpec {
  /** Logical task id — propagates to backend lineage tracking and labels. */
  taskId: string;
  /** Container image. The backend assumes `ensureImagePresent` has succeeded. */
  image: string;
  resourceLimits: ResourceLimits;
  /** When the session should be reaped if not torn down sooner. */
  expiresAt: Date;
  /**
   * Working-tree material to materialize at session start. Optional —
   * coding-delegation supplies it, skills tier-2 omits it because skill
   * workers don't run in a checkout. Backend resolves the field per its
   * `workingTreeTransport` capability (bind-mount on Local-Docker,
   * git-clone on Daytona).
   */
  worktree?: WorktreeSpec;
  /**
   * Persistent per-task scratch (Local-Docker named volume mounted at the
   * image's home dir). Optional — coding-delegation uses it to persist
   * the Claude Code CLI's session state across exec calls; skills tier-2
   * omits it because the `recycle` isolation contract forbids state
   * surviving the task. Daytona ignores this field — managed sandboxes
   * have provider-owned persistence.
   */
  homeVolume?: HomeVolumeSpec;
  askpass?: AskpassMaterial;
}

interface SandboxSession {
  readonly state: SandboxSessionState;

  exec(cmd: readonly string[], opts?: ExecOptions): Promise<ExecResult>;
  execStreaming(cmd: readonly string[], opts?: ExecOptions): Promise<ExecStreamingHandle>;

  read(path: string): Promise<ReadableStream<Uint8Array>>;
  write(path: string, data: ReadableStream<Uint8Array> | Uint8Array, opts?: WriteOptions): Promise<void>;

  cleanup(): Promise<void>;
}

/**
 * Buffered exec result. `stdout` / `stderr` are read fully into memory —
 * intended for short, bounded commands. Backends cap buffered output at
 * `SANDBOX_EXEC_BUFFER_LIMIT` (default 1 MiB per stream); when a command
 * exceeds the cap, `truncated` is set and the stream contents are clipped
 * to the cap. Consumers expecting larger output use `execStreaming`.
 */
type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  wallTimeSeconds: number;
  truncated: boolean;
};

/**
 * Streaming exec handle. `stdout` / `stderr` are demultiplexed Node
 * `Readable`s — backends produce them via the appropriate transport
 * (dockerode demux for Local-Docker, session-logs WS + manual demux for
 * Daytona). Awaiting `wait()` resolves with the exit code once the
 * backend reports the process finished.
 *
 * `dispose()` aborts the exec by tearing down the backend's transport
 * (Docker exec API has no direct kill — closing the hijacked socket
 * lets the daemon reap the process; Daytona's only kill primitive is
 * `deleteSession`). It does NOT send signals; backends that grow
 * signal support may upgrade the implementation but not the contract.
 * Idempotent. After `dispose()`, the streams emit EOF (no error on
 * `stdout` / `stderr`) and `wait()` rejects with `DisposedError` —
 * callers racing dispose against natural exit must check for that.
 *
 * `ExecOptions.timeoutMs` (total wall-clock) and
 * `ExecOptions.idleTimeoutMs` (no-byte-flow watchdog) cap `wait()` on
 * the caller's behalf. On expiry the backend runs the same cleanup
 * `dispose()` would (close socket / `deleteSession`) and rejects
 * `wait()` with `ExecTimeoutError`. `ExecTimeoutError` is a distinct
 * sentinel from `DisposedError` so consumers branching on outcome can
 * separate "we hit the cap" from "we cancelled." See "Wall-clock and
 * idle timeouts" below.
 *
 * Consumers wanting line semantics do their own line splitter
 * (`split2` etc.) on the `Readable`s — backends emit per-chunk, not
 * per-line.
 */
interface ExecStreamingHandle {
  stdin?: Writable;
  stdout: Readable;
  stderr: Readable;
  wait(): Promise<{ exitCode: number }>;
  dispose(): Promise<void>;
}
```

### Wall-clock and idle timeouts `[confirmed]`

Streaming-exec callers pass two independent timeouts on `ExecOptions`:

| Field | Triggers when |
|-|-|
| `timeoutMs` | total wall-clock since `execStreaming()` resolved |
| `idleTimeoutMs` | no stdout/stderr chunk has arrived for `idleTimeoutMs` |

Both default off (no cap). The interface accepts them on every backend; backend implementations clear both timers on natural exit (stream `end`/WS close) and dispose, reset the idle timer on every chunk, and on timer fire run the same teardown `dispose()` would (Local-Docker: `stream.destroy()`; Daytona: `deleteSession`) then reject `wait()` with `ExecTimeoutError`. Idempotent: a timer firing after a natural exit is a no-op.

Why two, not one. The Daytona wedge incident (4-day stuck task, run id `01KRM7A886F293XVTJPVB9CZ91`) was a transient WS hang on `getSessionCommandLogs`: the underlying WebSocket held open silently, the daemon never sent close, and `await handle.wait()` blocked forever. A single total-deadline cap would have caught it, but the cap that fits one workload (e.g. `git checkout` 60s) is wrong for another (`claude -p` streaming for tens of minutes). Splitting into total + idle lets `claude` opt into "stream as long as you want, but never go silent for >N minutes" while keeping `git` calls bounded by their natural wall-clock. This is the same shape e2b ships ([e2b-dev/E2B #1128](https://github.com/e2b-dev/E2B/issues/1128) — streaming calls only honored connect timeout, not read), Modal exposes ([`Sandbox.create(timeout=..., idle_timeout=...)`](https://modal.com/docs/guide/timeouts)), and WebSocket best practice recommends as the "75% rule" — ping at 0.75× the shortest proxy idle. Daytona's own [#2510](https://github.com/daytonaio/daytona/issues/2510) describes the stream-doesn't-close bug; [#2513](https://github.com/daytonaio/daytona/issues/2513) the missing async completion API. Both are upstream limitations the timeout pair routes around.

Per-callsite defaults are owned by the caller, not the backend — see [coding-delegation.md → Per-callsite exec timeouts](coding-delegation.md#per-callsite-exec-timeouts). Backends never inject a default; passing nothing means no cap (preserves the pre-timeout behaviour for skills tier-2 and any future caller that genuinely wants unbounded exec).

### Discriminated options and state

`SandboxClientOptions` and `SandboxSessionState` are discriminated unions keyed on `type: "local-docker" | "daytona" | …`. State is JSONB-storable per the project's `jsonbZod()` rule — a Daytona sandbox id or a Docker container id round-trips through Postgres so `resume(state)` can rejoin sessions that outlive the orchestrator process. `resume()` is the crash-recovery contract.

### Capability flags

```ts
interface SandboxCapabilities {
  siblingContainers: "host-proxy" | "sandbox-internal" | "unsupported";
  hostBindMount: boolean;
  customImage: boolean;
  volumes: "docker" | "managed" | "none";
  workingTreeTransport: "bind-mount" | "git-remote";
}
```

Hard transport differences (how working-tree material moves into the sandbox) live behind capability flags so the orchestrator can branch on transport without backend awareness. Soft policy differences (e.g. whether the Cogmo proxy logs every child container create) just don't fire on backends that lack them.

### Per-backend capability matrix

| Capability | Local-Docker | Daytona |
|-|-|-|
| `siblingContainers` | `host-proxy` | `sandbox-internal` |
| `hostBindMount` | `true` | `false` |
| `customImage` | local pull | registry pull |
| `volumes` | `docker` | `managed` |
| `workingTreeTransport` | `bind-mount` | `git-remote` |
| Userns isolation | sysbox (default) | provider-owned |
| Cogmo cgroup parent | yes | n/a |
| Cogmo Docker proxy | yes | n/a |
| `ensureImagePresent` | dockerode inspect + pull | `snapshot.get` + `snapshot.create` to ensure a named snapshot is ACTIVE; `create()` then references the snapshot |
| Buffered exec | dockerode | `executeCommand` |
| Streaming exec | dockerode demux | session-logs WebSocket + `stdbuf` |
| `resume(state)` | container-id inspect | sandbox-id rehydrate |
| Worktree-less sessions | yes (skills tier-2) | yes (skills tier-2) |

### Backend selection

Selected at deploy time via `SANDBOX_BACKEND` env var with values `local-docker` (default) or `daytona`. Switching backends is a config change; downstream code never references a backend by name. A single Cogmo deployment runs exactly one backend — selection is process-wide, not per-task.

## Local-Docker Backend

The local-Docker backend runs task containers as siblings on the host's Docker daemon, with a Cogmo-managed proxy injecting policy on every `POST /containers/create`. **Ubuntu 22.04 LTS or newer** is the supported deployment OS — sysbox ships first-class `.deb` packages for it and the kernel feature set is exercised widely there.

### Topology `[confirmed]`

Host daemon runs normally. Cogmo adds:

1. **Container supervisor** — creates task containers directly against the host daemon with `HostConfig.Runtime = "sysbox-runc"` by default.
2. **Docker API proxy** — per task container, Cogmo allocates a Unix socket at `/run/cogmo/sockets/<task-id>.sock`, mounted into the task container at `/var/run/docker.sock`.
3. **Sibling-container spawn model** — when the task container (or its tooling) calls the proxy to create a child, the child is a *sibling* on the host daemon, not a truly nested container. The parent relationship lives in Cogmo's DB and in Docker labels. Proxy injects `HostConfig.Runtime = "sysbox-runc"` on children by default so every container in the tree is userns-isolated.

Topology 2 — nested `dockerd` inside the task container — is deferred. Only added if a specific use case requires a private daemon (rare for personal scale).

### Runtime Selection `[confirmed]`

**Default:** `sysbox-runc`. Selected via `SANDBOX_RUNTIME` env var with values `sysbox` (default) or `runc`. No silent fallback — if `SANDBOX_RUNTIME=sysbox` and the runtime isn't registered on the host, Cogmo refuses to start a task. Explicit configuration over magic.

**Per-task escape hatch:** `coding_tasks.allow_privileged_runc = true` drops back to plain `runc` for that task. Reserved for workloads that break under sysbox (direct device access, certain kernel caps). Expected usage: rare.

**Reason this is the default:** userns isolation is cheap insurance for Cogmo-edits-Cogmo scenarios. One-time install cost, consistent policy across every container in the tree. See [decisions.md](decisions.md) for the full comparison against pure-runc.

#### Dev machine

No parity. Coding delegation is a prod/staging feature — local `pnpm dev` does not start the sandbox module and does not need sysbox installed. Developers working on sandbox code run it against a local VM or a dedicated Ubuntu host. Unit tests use plain Docker with no runtime injection.

### Data Model `[confirmed]`

Owned by `src/sandbox/store/`.

```sql
-- Enumerated types (Drizzle pgEnum in the store schema)
CREATE TYPE container_runtime AS ENUM ('sysbox-runc', 'runc');
CREATE TYPE container_status  AS ENUM ('starting', 'running', 'exited', 'reaped');

containers (
  id               UUID v7 PK,
  docker_id        TEXT NOT NULL UNIQUE,            -- Docker's container ID
  parent_id        UUID REFERENCES containers(id),  -- null = created by Cogmo directly
  root_task_id     UUID,                            -- denormalized, NO FK — not every container belongs to a coding task
  depth            INT NOT NULL,                    -- 0 = task container, 1+ = spawned by tooling
  image            TEXT NOT NULL,
  runtime          container_runtime NOT NULL,
  labels           JSONB NOT NULL,                  -- ContainerLabelsSchema = z.record(z.string(), z.string())
  resource_limits  JSONB NOT NULL,                  -- ResourceLimitsSchema = z.object({ cpus, memory_bytes, pids })
  status           container_status NOT NULL,
  exit_code        INT,
  ttl_expires_at   TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  exited_at        TIMESTAMPTZ,
  instance_id      UUID NOT NULL                    -- references cogmo_instances.id
)
```

Same pattern for `networks` and `volumes` tables — Docker objects Cogmo provisions or allows tooling to provision.

`parent_id` + `root_task_id` + `depth` computed at insert time from the parent row. No recursive CTE in the hot path.

```sql
cogmo_instances (
  id         UUID v7 PK,
  host       TEXT NOT NULL,
  pid        INT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stopped_at TIMESTAMPTZ                           -- null = current instance; set on graceful shutdown
)
```

Row inserted in bootstrap before any sandbox operations; `stopped_at` updated on graceful shutdown. Orphan detection joins `containers.instance_id → cogmo_instances.id` — any container tied to a row with non-null `stopped_at`, or a row that was never closed and whose pid no longer exists on the host, is an orphan.

The Daytona backend does not use these tables — its state lives in `SandboxSessionState` (provider sandbox id) and Daytona's own infrastructure.

### Label Schema `[confirmed]`

Every container Cogmo creates or proxies gets these Docker labels:

| Label | Value | Purpose |
|-|-|-|
| `cogmo.managed` | `"true"` | Identifies Cogmo-owned containers for orphan detection |
| `cogmo.instance` | `<run_id>` | Current Cogmo process's run id — on restart, anything with a different instance is an orphan |
| `cogmo.root_task` | `<task_id>` | Cascade scope — everything with the same value is reaped together when the task ends |
| `cogmo.parent` | `<docker_id>` | Parent container's Docker id (empty for root) |
| `cogmo.depth` | `<int>` | Depth in the tree |

Labels are the **mirror**; Cogmo DB is **authoritative**. Labels enable orphan detection via `docker ps --filter label=cogmo.managed=true` and survive Cogmo restarts for reconciliation.

### Proxy Design `[confirmed]`

Written in TS, lives in `src/sandbox/clients/local-docker/proxy/`. Single Node process. Listens on multiple Unix socket paths simultaneously — one per active task container. Socket path identifies the caller's parent.

#### Intercepted endpoints

| Endpoint | Interception | Action |
|-|-|-|
| `POST /containers/create` | Full | Validate `HostConfig`, inject labels + runtime, insert row, forward |
| `POST /containers/{id}/start` | Observe | Forward, update status + `started_at` |
| `POST /containers/{id}/stop`, `/kill`, `/restart` | Observe + authz | Check caller owns the target (label match); forward; update status |
| `DELETE /containers/{id}` | Observe + authz | Check ownership; forward; mark `reaped` |
| `POST /networks/create` | Full | Inject labels, insert row, forward |
| `DELETE /networks/{id}` | Authz | Ownership check; forward; mark reaped |
| `POST /volumes/create` | Full | Inject labels, insert row, forward |
| `DELETE /volumes/{name}` | Authz | Same |
| `POST /images/create` (pull) | Policy | Optional registry allowlist |
| Anything under `/swarm/*`, `/plugins/*`, `/nodes/*` | Deny | Wholesale block. Return 403. |
| Everything else (`/_ping`, `/version`, `/containers/json`, `/events`, exec, logs, attach, `/build`, `/session`) | Pass-through | Forward unchanged |

#### Policy at `POST /containers/create`

Defaults applied unless explicitly allowed per task:

- **Deny** `HostConfig.Privileged = true`
- **Deny** `HostConfig.NetworkMode = "host"`
- **Deny** `HostConfig.Binds` with host paths outside the task's allowed mount set (worktree, caches)
- **Deny** `HostConfig.CapAdd` containing `SYS_ADMIN`, `NET_ADMIN`, `SYS_PTRACE` (and friends)
- **Inject** `HostConfig.Runtime = "sysbox-runc"` unless task opts into `runc`
- **Inject** resource caps inherited from the task container (child can't ask for more CPU/memory than the task has)
- **Inject** Cogmo labels

#### Authentication

No tokens. The socket path *is* the identity. Mount access is controlled by filesystem perms — only the target task container can connect. Each task gets a private socket.

#### Implementation note

The proxy is a Unix socket server. Most Docker API calls are plain HTTP/1.1 and pass through via `http.request` to `/var/run/docker.sock`.

Endpoints that need more than HTTP req/resp — all handled by the same raw bidirectional pipe, not separate code paths:

- `/containers/{id}/attach`, `/exec/{id}/start`, `/events`, log follow — hijacked connections, plain bytes after the upgrade.
- `/build` — streaming tar upload with NDJSON progress stream back. HTTP/1.1, but long-lived; pipe both directions.
- `/session` (BuildKit / buildx) — HTTP/1.1 `Upgrade` to gRPC-over-HTTP/2. Node's `http` server surfaces the upgrade via the `upgrade` event. After the upgrade completes, it's just bytes on a socket — pipe them to the daemon socket in both directions and stay out of the way. We don't need to understand gRPC.

Node's `http` module exposes upgrades via the `upgrade` event; forward the raw socket with `stream.pipe()` in both directions. No buffering, no HTTP/2 implementation in Node.

**What this gets us.** Transparent buildx support — `docker buildx build`, the default `docker` driver (uses host BuildKit), and the `docker-container` driver (spawns a buildkitd sibling, which comes up through our `/containers/create` path with labels injected) all work. Testcontainers' image build path works. `docker compose build` works.

**What this does NOT get us.** Policy enforcement on build contents — things like "deny this `FROM` because it's from an unapproved registry" or "deny this `RUN` because it mounts host paths" — requires parsing the BuildKit gRPC session. That's the [moby/buildkit Go SDK](https://github.com/moby/buildkit) territory (or TS stubs autogenerated from the [`frontend/gateway/pb`](https://github.com/moby/buildkit/tree/master/frontend/gateway/pb) `.proto` files). Deferred; basic registry policy at `POST /images/create` covers the common case.

References: [buildkite/sockguard](https://github.com/buildkite/sockguard) (label model + endpoint selection), [CpuID/dockerd-ci-proxy](https://github.com/CpuID/dockerd-ci-proxy) (label injection on create), [Tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) (endpoint categories to block).

### Reaper `[confirmed]`

Inngest cron, runs every 30s. Three passes:

1. **TTL expired** — `WHERE ttl_expires_at < now() AND status IN ('starting','running')`. Kill post-order: children first (sort by `depth DESC`), then parent.
2. **Orphan detection** — `docker ps --filter label=cogmo.managed=true`. Anything present on the daemon but missing from the DB, or labelled with a dead `cogmo.instance`, gets killed.
3. **Stale DB rows** — containers in DB with `status != 'reaped'` but missing from `docker ps` get marked exited with no exit code.

Root-task cascade (not on cron — triggered by task completion/failure): `WHERE root_task_id = $t AND status != 'reaped' ORDER BY depth DESC` → stop + remove.

Networks and volumes reaped last, after all containers in the root task are gone.

### Lifecycle `[confirmed]`

Task startup:

1. Supervisor allocates a task id `T`.
2. Supervisor inserts placeholder row for the task container (depth 0, no `docker_id` yet).
3. Supervisor creates `/run/cogmo/sockets/T.sock`, registers `T.sock → {parent: null, root_task: T}` in the proxy's in-memory map. The task container's own docker id is written back once Docker returns it.
4. Supervisor creates the task container via host daemon: `HostConfig.Runtime = "sysbox-runc"`, mounts `/run/cogmo/sockets/T.sock` → `/var/run/docker.sock`, injects labels.
5. Supervisor starts the container.
6. Updates placeholder row with `docker_id`; updates proxy map entry with task container's `docker_id` for ownership checks on `DELETE` etc.

Task teardown:

1. Supervisor triggers root-task cascade.
2. Closes and removes the socket file.
3. Removes socket entry from proxy's map.

### Crash Recovery `[confirmed]`

At Cogmo boot:

1. Generate new `instance_id` for this run.
2. List containers matching `label=cogmo.managed=true` via Docker daemon.
3. For each found container:
   - If its `cogmo.instance` ≠ current instance → orphan from a previous run. Stop + remove. Mark any matching DB row `reaped`.
   - If a DB row exists and matches the current instance → crash during task execution. Mark status according to Docker's report; if still running, let the task resume (session_id in `coding_tasks` lets us rejoin).
4. Same pass for networks and volumes.

Proxy crash mid-task: in-memory socket map is lost. Supervisor rebuilds it from the `containers` table (query `depth=0 AND status='running' AND instance_id=<current>`) and re-creates the socket files. Tasks briefly see "Docker daemon unavailable" errors; retry on their end, or Cogmo marks the task failed if the gap is long.

### Networks, Volumes, Images `[confirmed]`

**Networks and volumes:** tracked identically to containers, with the same `root_task_id` cascade. Common case — docker compose brings up services + a network; all get reaped together when the task exits.

**Images:** shared across tasks, not reaped per-task. Separate GC job keyed on disk budget — prune dangling + untagged + LRU-with-max-age, enforced every N minutes or when disk > threshold. Pull policy: registry allowlist (empty by default = allow all).

#### Cache volume scoping

Package-manager caches are scoped by **integrity story**, not by a blanket per-repo rule. Three classes:

| Cache | Scope | Volume naming | Rationale |
|-|-|-|-|
| npm store (`~/.npm/_cacache`), cargo registry (`~/.cargo/registry`), go modules (`~/go/pkg/mod`), apt (`/var/cache/apt/archives`) | **Global** | `cogmo-cache-<kind>` | Ecosystem enforces integrity on read — SHA-512 from lockfile (npm), `go.sum` (go), `Cargo.lock` (cargo), GPG signature (apt). A forged artifact fails the check and is re-downloaded. Sharing recovers hundreds of MB and speeds cold starts with no added attack surface beyond the sandbox boundary itself. |
| pip wheels (`~/.cache/pip`) | **Per-repo** | `cogmo-cache-<repo-id>-pip` | `requirements.txt` rarely pins hashes by default; pip won't verify wheel content unless `--require-hashes` is used. A compromised task could plant a wheel that a later task installs without verification. Per-repo contains the blast radius. |
| Build caches — Go build (`~/.cache/go-build`), Rust `target/`, Bazel output | **Per-repo** | `cogmo-cache-<repo-id>-<kind>` | No ecosystem integrity — output is content-addressed on inputs but unsigned. Sandbox-escape-to-cache-poison is a live threat class (Bazel RBE and Nix treat it seriously). Also: cross-repo hit rate is near zero because hash keys encode project-specific inputs. Nothing to gain from sharing, real risk from sharing. |
| Installed trees — `node_modules`, `.venv`, Rust `target/debug/` | **Never cached cross-task** | — | Per-project by nature; live inside the worktree. |

Global caches get an additional GC pass in the same disk-budget job as images — LRU eviction when disk > threshold. Per-repo caches live for the lifetime of the `coding_repos` row; removed when the repo is deregistered.

The attack surface this leaves is: a sandbox escape that reaches a shared cache volume. The download caches with integrity checks harmlessly reject the forgery. The remaining exposure (pip, build caches) is kept per-repo so a compromised task on repo A can't affect repo B even if the sandbox falls.

### Resource Accounting `[proposed]`

Per root task: cumulative CPU-seconds, memory-seconds, disk bytes written, network bytes. Polled from Docker stats API, aggregated across all containers sharing a `root_task_id`, written to `coding_tasks.resource_usage`. Accounting is observational — the numbers exist for budget reporting and post-hoc analysis, not for live enforcement (the cgroup parent below does the enforcement).

#### Hierarchical enforcement via cgroup parent `[confirmed]` (slice naming + assignment) / `[proposed]` (aggregate-budget enforcement)

Siblings in our topology are separate cgroups under the host root by default, so "children sum ≤ parent" is not automatic the way it is in nested-dockerd setups. We fix this by attaching every container in a root task to a shared cgroup parent — the kernel then hierarchically enforces the task's total budget regardless of how many children spawn or what each one requests.

**In place:** the slice naming + assignment infrastructure. Every container in a task tree (depth-0 task container + every proxy-created child) lands in the same systemd slice (`cogmo-task-<dashless-uuid>.slice`). Docker creates the slice on demand the first time a container references it; systemd auto-cleans the empty slice once all containers in it are removed. Per-leaf limits via Docker's `NanoCpus` / `Memory` / `PidsLimit` already cap the task container directly.

**Deferred:** aggregate-budget enforcement at the slice level. Setting CPU/memory/pids limits at the slice itself requires either Cogmo running as root (security regression) or systemd `Delegate=yes` on Cogmo's own unit + writing to `/sys/fs/cgroup/.../cpu.max` directly. The slice name is plumbed end-to-end so wiring delegated-slice limits later is a small follow-up. Trigger: when the spawn-many-children case becomes routine and a single child can steal the whole task budget.

Outcome of the deferred enforcement: the task's total budget would be a hard ceiling enforced by the kernel. Individual child limits become advisory — a child asking for 4 CPU when the task has 4 still works, it just competes with siblings via normal fair-share scheduling. No policy code in the proxy, no sum-of-sibling bookkeeping, no admission race conditions.

Matches how Kubernetes pod-level cgroups enforce pod resource limits under the hood. Requires cgroupv2 on the host — Ubuntu 22.04+ default, consistent with our deployment OS choice.

**Deployment target:** Linux + systemd. Cgroupfs fallback for non-systemd hosts is out of scope; document linux-with-systemd as the supported config.

### Deployment Topology `[proposed]`

**Single image, two subcommands.** `cogmo serve` runs the main orchestrator; `cogmo sandbox-proxy` runs the socket proxy. Same binary, same codebase, no duplicate artifacts. Both subcommands apply only when the local-Docker backend is selected.

#### In-process proxy

Default shipping configuration. `cogmo serve` boots the proxy as a module on its own event loop — no IPC, no separate service. Crashes in either part bring down the other, acceptable at personal scale because Cogmo restarts are rare and Inngest's durable resume handles task-state recovery across the outage window.

#### Extracted sidecar

Two processes sharing the image:

- `cogmo serve` — main orchestrator. No docker daemon access.
- `cogmo sandbox-proxy` — socket proxy. Holds `docker` group membership. Owns `/run/cogmo/`.

Industry-standard separation (every reference proxy runs this way — see Reference Implementations below). Extracted when an in-process crash first disrupts a live task.

#### Control plane — tRPC

Main ↔ proxy communicate via a tRPC router in `src/sandbox/clients/local-docker/rpc/router.ts`. The router is the local-Docker supervisor projected over the wire — same shape, same domain schemas, just network-accessible. Zod procedures make it drift-proof via TS inference on both sides.

```ts
// abbreviated
export const sandboxRouter = t.router({
  createTaskContainer: t.procedure
    .input(TaskContainerSpecSchema)
    .output(TaskContainerHandleSchema)
    .mutation(({ input }) => supervisor.createTaskContainer(input)),
  stopTask: t.procedure
    .input(z.object({ taskId: z.string() }))
    .mutation(({ input }) => supervisor.stopTask(input.taskId)),
  listContainersForTask: t.procedure
    .input(z.object({ taskId: z.string() }))
    .output(z.array(ContainerRowSchema))
    .query(({ input }) => store.listContainersForTask(input.taskId)),
});
export type SandboxRouter = typeof sandboxRouter;
```

All `containers` / `networks` / `volumes` *state* continues to flow through PostgreSQL; the router is for lifecycle operations that need a synchronous ack.

#### Transport — deployer's choice

Configured via environment:

| `SANDBOX_PROXY_LISTEN` | Use case | Auth |
|-|-|-|
| `unix:///run/cogmo/sandbox.sock` | Single host, systemd or Compose with shared tmpfs (default) | Filesystem perms |
| `tcp://127.0.0.1:<port>` | Single host, no shared filesystem | Loopback-only, implicit trust |
| `tcp://<bind>:<port>` | Split hosts (proxy colocated with docker daemon, main elsewhere) | Deployer supplies mTLS or an authenticating reverse proxy; Cogmo does not mint credentials |

tRPC's HTTP client accepts a custom `fetch`, so the Unix-socket case is wired via undici's `Agent({ socketPath })`. No code difference between transports beyond the URL.

## Daytona Backend `[confirmed]`

The Daytona backend runs task sandboxes on Daytona's managed cloud (default) or self-hosted Daytona instance. Daytona owns sandbox isolation and lifecycle. Cogmo drives via the [Daytona TypeScript SDK](https://www.daytona.io/docs/typescript-sdk/daytona/).

**Two phases shipped:** Phase 3a (PR #173) lifted skills tier-2 onto Daytona — worktree-less, ephemeral, ephemeral askpass-less. Phase 3b (PRs #183 / #192 / #196) wired coding-delegation through the `git-remote` working-tree transport: orchestrator force-pushes a `cogmo/run/<task-id>` ref, the SDK's `git.clone` rehydrates it inside the sandbox, askpass material is uploaded via `fs.uploadFiles`. Both flows share the same `SandboxClient` interface; consumers branch on `capabilities.workingTreeTransport`.

Production-ready for skills tier-2 and the coding-delegation `git-remote` flow against a single user's traffic. Subsections that need real-traffic validation before they graduate to fully-trusted status carry their own `[proposed]` markers below — `Streaming exec` and `Keepalive` specifically.

### Authentication & deployment

API-key auth. The key is stored as `daytona_api_key` in the encrypted `secrets` table per [infrastructure.md](infrastructure.md) → Secrets — the same path LLM provider keys, channel tokens, and the GitHub PAT take. The setup wizard prompts for it on first run; non-interactive bootstrap accepts a `COGMO_DAYTONA_API_KEY` (with `_FILE` variant) which is migrated into the secrets table on first boot and not consulted thereafter.

Base URL is configuration, not credential — `DaytonaSandboxClientOptions.apiUrl` carries the value (`undefined` = Daytona Cloud), populated at startup. Override via `DAYTONA_API_URL` env. The choice is deployment-time; Cogmo doesn't switch between cloud and self-hosted at runtime.

`DaytonaSandboxClientOptions.organizationId` is similarly deployment-time — populated from `DAYTONA_ORGANIZATION_ID` env. Required when the API key has multi-org access; Daytona returns 403 on `list({}, 1, 1)` if the org isn't pinned.

#### Keepalive `[proposed]`

Daytona's default `autoStopInterval` reaps idle sandboxes after 15 minutes. Coding tasks stream model output for tens of minutes with arbitrary inter-token latency, which Daytona reads as "idle." The client starts a `refreshActivity()` ticker per live sandbox, firing every 5 minutes, to reset the auto-stop countdown. The ticker stops on `delete(session)` / `deleteByTaskId(taskId)` / `shutdown()`. `setInterval` handles are `unref()`'d so the Node process can exit cleanly when nothing else holds the loop open.

### Working-tree transport — git as transport

Applies only when `SessionSpec.worktree` is set — i.e. coding-delegation tasks. Skills tier-2 sessions omit `worktree` and skip the git ceremony entirely (`create()` → `exec()` → `delete()`).

Working-tree material moves between orchestrator and sandbox via an ephemeral branch on the repo's GitHub remote. This matches the published pattern of remote AI-agent-sandbox products that need to push state into a managed VM: Codex Cloud and Devin both clone task state into their sandbox via git, and Daytona ships `sandbox.git.clone()` and `sandbox.git.push()` as first-class SDK methods — signalling the same expected flow. Local-IDE products (Cursor edits a checkout in place; Codespaces clones for the user's IDE) operate on a different axis and aren't precedent for the orchestrator-pushes-state direction.

Per-task lifecycle (worktree-bearing sessions):

1. Orchestrator pushes the local worktree to `cogmo/run/<task-id>` on the repo's configured GitHub remote.
2. Sandbox `sandbox.git.clone(remoteUrl, /workspace, branch=cogmo/run/<task-id>, ...)` using the per-task PAT material slice 4 already provisions.
3. Claude Code commits inside the sandbox.
4. Sandbox `sandbox.git.push(...)` back to the same temp branch.
5. Orchestrator `git fetch`es the branch into its local mirror; downstream slice-4 verify+PR-open code consumes the result branch.
6. Cleanup: temp branch deleted on task teardown (success or failure).

Why git: native delta compression on push/fetch (matters for repos > 100MB), no inbound network requirement (managed sandboxes don't accept inbound ssh — rules out rsync), no bespoke tar/upload code, and slice 4 already pushes a result branch — the Daytona path adds the start-state push, nothing else.

#### Orphan branch cleanup `[confirmed]`

Cleanup follows the **hybrid event-driven primary + cron safety-net** pattern dominant across Renovate, Dependabot, GitHub-native, and the off-the-shelf stale-branch-action ecosystem. Two Inngest functions, both in `src/agent/coding/`:

1. **Event-driven primary** (`cleanup-run-branch.ts`). Subscribes to `coding/task/pr-opened` and `coding/task/failed` (idempotency keyed on `event.data.taskId` so simultaneous fires from both events for the same task collapse to one execution). Resolves the GitHub identity, derives `ref = heads/${runBranchFor(taskId)}`, calls `octokit.git.deleteRef`. Default Inngest retries (3) handle transient 5xx and secondary rate-limit; 404 + 422 are swallowed (already-deleted is idempotent success); 409 (protected branch) and other statuses propagate. Identity is loaded inline (NOT inside `step.run`) so the PAT + SSH private key never become a step return value — Inngest persists step returns into its state store, and we don't want credentials there. This catches 99% of cases immediately.

2. **Weekly cron safety-net** (`cleanup-orphan-run-branches.ts`). Cron `0 4 * * 0` — Sunday 04:00 UTC, `retries: 2` so a transient list-repos / sendEvent failure doesn't lose the entire week's sweep. Lists managed coding repos, fans out via `step.sendEvent` (one `coding/run-branch-sweep/repo` event per repo) to a per-repo handler with its own retry lane and `concurrency: { limit: 2 }` to bound GitHub-token pressure. The per-repo handler walks `cogmo/run/*` refs via `octokit.paginate(octokit.git.listMatchingRefs, ...)` (so >100-ref repos still get fully swept), batch-loads the matching `coding_tasks` rows via `getTasksByIds`, and force-deletes refs whose task is **(terminal AND >7 days old) OR has no row at all**. Non-terminal tasks are never swept regardless of age — stuck approvals belong to the user. Per-delete failures `continue` the loop with an `errors++` counter so one bad ref doesn't block the rest of the week's sweep.

The 7-day retention applies only to the cron's stale criterion. The event-driven path deletes immediately on terminal status. New events introduced for this design: `coding/task/failed` (emits from every failure path in plan + execute + verify), `coding/run-branch-sweep/repo` (cron fan-out).

The slice-4 PR namespace `cogmo/<idShort>` (different namespace from `cogmo/run/*`) stays untouched until the user merges/closes — GitHub's repo-level `delete_branch_on_merge` setting handles those for free. The cron's prefix filter `heads/cogmo/run/` matches only the run-branch namespace, so PR branches are out of scope by construction.

### Streaming exec `[confirmed]`

Two backends share the `ExecStreamingHandle` contract, selected per call by `opts.attachStdin`. Output-only execs (`attachStdin: false` or omitted) take the **session-logs WebSocket** path; execs that need real stdin (`attachStdin: true`) take the **PTY** path. Downstream code stays backend-agnostic — both paths expose the same `Readable`-stream + `wait()` + `dispose()` shape.

**Output-only (session-logs WS, `exec-streaming.ts`).** `executeSessionCommand({ runAsync: true })` returns a command id, then `getSessionCommandLogs(sessionId, commandId, onStdout, onStderr)` opens a WS with separated stdout/stderr callbacks. This is the right path for pure-output commands because (a) the WS provides demuxed streams, matching the local-Docker dockerode shape downstream code depends on, and (b) session commands are cheaper than PTY sessions.

**Stdin-attached (PTY, `exec-pty.ts`).** Daytona's session-command stdin (`sendSessionCommandInput` over HTTP) has no remote-EOF channel: for `runAsync: true` the daemon pins the FIFO open with a long-running `sleep`, so any caller that relies on stdin EOF as a shutdown signal (e.g. `claude --input-format stream-json`) wedges. `createPty()` exposes a real bidirectional WebSocket with `kill()` and `disconnect()` RPCs; the wrapper:

- Buffers caller writes on the returned `Writable`; on `.end()`, uploads the payload to a tmpfile under `/tmp/cogmo-pty-stdin-<uuid>.bin` via `fs.uploadFile` and creates the PTY session.
- Sends one shell line into the PTY: `exec <argv> < <stdinPath> 2> <stderrPath>`. The shell-level redirect gives the child a real pipe FD (not a TTY) on stdin, so EOF arrives naturally when the file is exhausted and the CLI's TTY-aware behaviour on stdin doesn't trigger. `exec` replaces the shell with the target binary so PTY exit = target binary exit, no marker parsing.
- Sets `NO_COLOR=1` in the PTY's env block to suppress ANSI escapes on stdout (PTY's stdout is still a TTY for the child).
- Redirects child stderr to `/tmp/cogmo-pty-stderr-<uuid>.log` so the PTY's combined onData channel carries clean stdout JSONL; the wrapper downloads + emits the stderr file via the stderr `Readable` after the PTY exits.
- Cleans up both tmpfiles via `fs.deleteFile` on settle (best-effort; sandbox teardown sweeps `/tmp` anyway).

WS reality the wrapper hides:

- **Callbacks are per-chunk, not per-line.** Consumers wanting lines do their own splitter (`split2` etc.) on the returned `Readable`.
- **Exit code arrives separately.** The WS closes when the command exits; the wrapper then fetches `getSessionCommand(sessionId, commandId)` to read the exit code.
- **No per-command kill.** `dispose()` calls `deleteSession(sessionId)`, which tears down everything in that session. To keep dispose semantics clean, the wrapper allocates **one Daytona session per `execStreaming()` call**.
- **No WS heartbeat.** The wrapper relies on the client's per-sandbox `refreshActivity()` ticker (see Authentication & deployment) to keep the sandbox alive across long execs.
- **Command completion fires on the session shell's exit.** Daytona detects "the command finished" by the session's bash process exiting; it doesn't poll the target binary directly. `buildShellCommand` therefore invokes the argv as a normal child of bash (`cd <wd> && env K=V <argv>`) — never via bash's `exec` builtin, which would replace the shell process and prevent the completion event from firing. Daytona [#2513](https://github.com/daytonaio/daytona/issues/2513) tracks the missing async-exit notification; running the target as a shell child gives the shell a clean exit to report.
- **WS close is the only completion signal, and it isn't reliable.** Daytona [#2513](https://github.com/daytonaio/daytona/issues/2513) calls this out explicitly — there is no promise-based exit notification today; the WS closing is what tells the wrapper the command finished. Daytona [#2510](https://github.com/daytonaio/daytona/issues/2510) shows the WS sometimes fails to close. Without an upper bound, `wait()` can block forever. The total + idle timeout pair on `ExecOptions` (see [Wall-clock and idle timeouts](#wall-clock-and-idle-timeouts-confirmed) above) is the upper bound. On timer fire the wrapper runs `cleanupSession()` (= `deleteSession`, the same teardown `dispose()` uses — Daytona [#2510](https://github.com/daytonaio/daytona/issues/2510)'s recommended explicit-cleanup path) and rejects `wait()` with `ExecTimeoutError`.

`claude` is wrapped by `stdbuf -oL -eL` inside the sandbox to defeat its block-buffering bug ([anthropics/claude-code#25670](https://github.com/anthropics/claude-code/issues/25670)). `stdbuf` is in coreutils on every reasonable base image. If a future image lacks it, fall back to `script -qfc 'claude …' /dev/null`.

Fallback if the WS proves flaky on a long task: HTTP-poll the same logs endpoint with a byte offset (~1s latency, AWS-SSM/CloudWatch pattern). Gated behind a feature flag, not a hot-swap.

### Custom image

The image declared in `SessionSpec.image` is referenced via Daytona's `Image.base("registry/path:tag")` — no Dockerfile rebuild on Daytona's side. Cogmo-owned images (`cogmo/devbase` for coding-delegation) are published to a registry Daytona can pull from (Docker Hub or GHCR); third-party images (e.g. `python:3.14-slim` for skills tier-2) come straight from their published location.

**Initially public-registry only.** The Daytona TS SDK does not expose a private-registry-credential API; private registries are added via the Daytona Dashboard → Registries panel before referencing the image. Cogmo-owned images publish to a public namespace (GHCR public) until that gap closes upstream or a deployer explicitly opts into the dashboard flow.

### Snapshot prewarm `[confirmed]`

Daytona's `daytona.create({ image })` lazy-pulls and snapshots the image on first use. The pull-and-build can take 5–15 minutes for a fresh cogmo-devbase tag, but the SDK's `waitUntilStarted` caps at a 60-second default — so the first coding-delegation task after any cogmo version bump times out before the snapshot is ready, and concurrent retries each kick off their own duplicate build server-side.

`DaytonaSandboxClient` pre-bakes a named snapshot via `daytona.snapshot.create({ name, image })` so subsequent `daytona.create({ snapshot: name })` calls hit Daytona's runner cache (~1 s provisioning). Mechanism:

- `ensureImagePresent(image)` derives a stable snapshot name from the image string (`ghcr.io/iskhakovt/cogmo-devbase:1.66.0` → `cogmo-cogmo-devbase-1.66.0`). `snapshot.get(name)` first; if `ACTIVE`, done. If `BUILDING`/`PENDING`/`PULLING` (race with another instance), poll until terminal. If `ERROR`/`BUILD_FAILED`/`INACTIVE`/`REMOVING`, fire-and-forget the stale row's delete and rebuild under a fresh `<base>-r-<hex>` name. If 404, build under the derived name. `snapshot.create()` blocks until terminal — the SDK polls server-side state internally; Cogmo wraps the call in a tight retry envelope that fires only on the Daytona-side internal-registry race signature (`repository … not found`), so persistent failures (Dockerfile errors, auth, validation) surface immediately.
- **Rebuild-under-fresh-name** sidesteps the async `REMOVING` race: Daytona's `snapshot.delete` returns 2xx immediately but the row drains in the background, and a follow-up `snapshot.create` against the same name 409s while the row is in `REMOVING`. The rebuild uses 32 bits of fresh entropy on the suffix, so the warm path doesn't wait for the stale row's cleanup. Daytona's own reaper eventually disposes of the orphan; if it doesn't, the per-version snapshot GC sweep (deferred, see below) backstops it.
- `ensureImagePresent` memoises one in-flight promise per image. Concurrent callers share the same warm cycle; failures evict the cache so the next call retries fresh. The cache holds the name that's actually `ACTIVE` after `#ensureSnapshotActive` resolves — `create()` always dispatches against a verified-live snapshot.
- `ensureImagePresent` returns `void` and skips warming for unversioned tags (`:latest`, no tag) — `snapshot.create` rejects `:latest` with `Images with tag ":latest" are not allowed`. In that case `daytona.create()` falls back to the lazy `{ image }` path.
- `create(spec)` checks whether the image has a successful warm in the in-process map. If yes, dispatches `daytona.create({ snapshot, labels, autoStopInterval, envVars })`. If no, falls back to the lazy `daytona.create({ image, resources, ... })`. `CreateSandboxFromSnapshotParams` has no `resources` field — resources bake into the snapshot at `snapshot.create` time and the snapshot path inherits whatever was baked. The lazy `{ image }` path still receives `spec.resourceLimits` directly.
- `ensureImagePresent(image, resourceLimits)` forwards `resourceLimits` to `snapshot.create({ name, image, resources })` so the consumer's intent is baked into the snapshot at warm time. Without this, every snapshot-path session would silently inherit Daytona's platform default (1 cpu / 1 GiB RAM / 3 GiB disk) and erase consumer-specific choices — notably skills tier-2's 1 GiB disk floor and coding-delegation's 2 cpu / 2 GiB RAM defaults. Boot pairs each image with its consumer's limits explicitly; the per-task `step.run("ensure-image-present")` passes `spec.resourceLimits` so a task-time first warm bakes the right values too.

Boot fires `scheduleSandboxImageWarm` (devbase + skills image, each paired with its consumer's resource limits) non-blocking so the orchestrator's `cogmo serve` doesn't wait. The helper retries `ensureImagePresent` per image with 5s → 10s → 20s → 40s → 60s backoff (capped, ~20 attempts ≈ 20 min total) so a transient provider blip doesn't leave the image cold until the first task pays the cold start — the per-task `coding-task-start` Inngest function pins `retries: 0` because plan-mode CLI sessions aren't replay-safe, so the boot path owns the retry. After exhaustion the helper logs and gives up; the coding orchestrator's `step.run("ensure-image-present")` awaits the same memoised promise and triggers a fresh warm cycle on first task arrival (a failed prior warm has evicted the cache).

The snapshot name encodes the image tag, so a cogmo bump that changes the devbase tag triggers a fresh snapshot. Old snapshots accumulate on Daytona's account across releases; manual GC via the dashboard or a deferred snapshot-sweep cron handles that — single-user scale doesn't yet justify automated cleanup.

### Secret material

Per-task askpass material (PAT + SSH signing key) is uploaded via `fs.uploadFiles()` (the bulk endpoint — never serial `uploadFile`, see [daytonaio/daytona issue tracker](https://github.com/daytonaio/daytona/issues) and the [hermes-agent perf report](https://github.com/NousResearch/hermes-agent/issues/7362) showing 5 min → < 2 s for typical worktrees). Permissions are set in a follow-up `fs.setFilePermissions()` call (the upload endpoint takes no mode), targeting `0600` on the PAT + signing key, `0700` on the parent directory. Sandbox destruction wipes them — no separate cleanup step. Same path layout (`/.cogmo-askpass/`) as the Local-Docker bind-mount so the in-container helper script is identical across backends.

### Git auth

The Daytona TS SDK's `sandbox.git.clone() / push()` convenience methods accept **HTTPS + username/password only** — the GitHub PAT goes in the `password` slot. SSH is not exposed at the SDK layer.

The slice-4 askpass design works as-is on Daytona because the two auth concerns split cleanly:

- **Push auth (HTTPS + PAT)** — `sandbox.git.push()` directly.
- **Commit signing (SSH key)** — already shells out via `git -c gpg.format=ssh -c user.signingkey=<path> commit -S` regardless of backend, so the SDK-level limitation never bites.

Any future SSH-clone path (private repo without a PAT, mirror over `git@`) shells out via `process.executeCommand` with `GIT_SSH_COMMAND` set — same workaround the local-Docker backend uses internally for `git push`.

### Out of scope for this backend

The Daytona backend does not run the Cogmo Docker socket proxy, the systemd cgroup parent, or the host-side reaper. Daytona owns sandbox isolation and lifecycle. Sibling containers spawned from inside the sandbox (testcontainers, `docker compose`) are visible only to Daytona, not to Cogmo's audit log — capability flag `siblingContainers: 'sandbox-internal'` advertises this. The Local-Docker backend's `containers` / `networks` / `volumes` / `cogmo_instances` tables are not used by the Daytona backend.

`ResourceLimits.pids` is silently ignored — Daytona's `Resources` shape has only `cpu` / `gpu` / `memory` / `disk` fields, no per-sandbox process-count cap. If pid-cap is load-bearing for a workload (fork-bomb defence inside the sandbox), set up cgroup limits via `process.executeCommand` after `create()` instead.

`ResourceLimits.disk_bytes` is optional and forwarded to Daytona's `disk` field (rounded up to GiB, floored at 1 GiB to honour the platform minimum). Omit to accept Daytona's platform default — currently 3 GiB. Skills tier-2 sets `disk_bytes: 1 GiB` in `DEFAULT_RESOURCE_LIMITS` (the image plus typical scratch fits in <500 MB; the 1 GiB floor is 3× over-provisioned and frees up two thirds of the per-sandbox storage charge versus the platform default). Local-Docker silently ignores `disk_bytes` — runc HostConfig has no native disk quota and the supervisor doesn't set one.

### Crash recovery

`SandboxSessionState` for the Daytona backend stores `{ type: "daytona", taskId, sandboxId }`. On orchestrator restart mid-task, `client.resume(state)` re-attaches to the existing sandbox via the Daytona API. If the sandbox was reaped (TTL exceeded, manual delete, provider-side eviction), `resume()` fails fast and the orchestrator marks the task failed.

### Deferred / Phase 3c

- **Real-Daytona integration test** (gated on `DAYTONA_API_KEY`), mirroring `runner.sysbox.integration.test.ts`. Exercises one full skills tier-2 invocation + one coding-delegation `git-remote` flow against a live Daytona Cloud sandbox so the SDK mocks can't lie about WS demuxing or session-cleanup behaviour.
- **Bootstrap-level integration coverage** for the Daytona path through `bootstrap()` — typecheck-only validation today.
- **Edge-case unit gaps:** `buildShellCommand` with empty `env: {}`, `getSessionCommand` failure post-WS-resolve, concurrent `tryResumeByTaskId` for the same taskId.
- **Daytona reaper / orphan reconcile.** `reconcileCrashedInstances` is a no-op today (Daytona auto-persists/auto-archives are the provider's job); a Cogmo-side audit pass that lists sandboxes labelled `cogmo.instance != current` and either resumes or deletes them would catch stale state from crashed retries.
- **Cost dashboarding.** Wire Daytona usage stats into `coding_tasks.resource_usage` JSONB so post-hoc spend analysis works on managed runs the same as local.
- **Cogmo-baked Daytona base image.** Bake `stdbuf` (`claude` block-buffering defeat) and other Cogmo-side deps. Cold-pull latency for `cogmo/devbase` was measured at ~28 s in May 2026 (snapshot route) and ~19 s on the lazy `{ image }` path; subsequent creates against the same image are ~1 s once Daytona's runner cache warms.
- **Snapshot GC.** Snapshots accumulate per-version on Daytona's account across cogmo releases. A periodic sweep that lists snapshots whose name doesn't match the currently-deployed image set and deletes them would bound the cost. Manual via the Daytona dashboard for now.
- **Daytona-side orphan sandbox sweep.** Pairs with the snapshot path: a `create` that throws mid-flight (e.g. SDK timeout while build is still running server-side) can leave a labelled sandbox alive. The orchestrator's `deleteByTaskId(taskId)` in the failure catch reaps the common case via the `cogmo.task` label index; a periodic cron that lists all `cogmo.task`-labelled sandboxes and reaps those whose `coding_tasks` row is in a terminal state would cover the gap where the in-catch delete races a `building_snapshot` state transition (Daytona refuses delete while transitioning).

## Module Structure `[confirmed]`

```text
src/sandbox/
  index.ts                     — public API: SandboxClient, SandboxSession, capabilities
  options.ts                   — discriminated SandboxClientOptions (Zod)
  state.ts                     — discriminated SandboxSessionState (Zod)
  factory.ts                   — selects backend from SANDBOX_BACKEND env
  clients/
    local-docker/
      client.ts                — LocalDockerSandboxClient
      session.ts               — LocalDockerSandboxSession
      supervisor.ts            — container lifecycle, socket allocation
      proxy/
        index.ts, policy.ts, router.ts
      reaper.ts                — TTL + orphan + cascade logic
      runtime.ts               — sysbox detection + runtime selection
      askpass.ts
      cgroup-parent.ts
      rpc/router.ts            — tRPC control plane (extracted-sidecar mode)
    daytona/
      client.ts                — DaytonaSandboxClient
      session.ts               — DaytonaSandboxSession (exec, fs, git)
      streaming.ts             — session-logs WS wrapper, polling fallback
      git-transport.ts         — ephemeral-branch push/fetch helper
  store/
    schema.ts                  — containers, networks, volumes (Local-Docker only)
    index.ts                   — SandboxStore interface + Drizzle impl
```

The Daytona backend in-tree alongside Local-Docker. If the provider list grows, individual backends extract to separate packages — the abstraction is designed for it (matches the OpenAI Agents SDK's in-tree-Docker + out-of-tree-everything-else pattern).

## Reference Implementations

### Abstraction `[proposed]`

| Project | Read for |
|-|-|
| [openai/openai-agents-python](https://github.com/openai/openai-agents-python/tree/main/src/agents/sandbox) | Canonical `BaseSandboxClient` / `BaseSandboxSession` shape, discriminated options + state, `resume()` contract, in-tree Docker + UnixLocal reference impls. |
| [openai/openai-agents-js](https://github.com/openai/openai-agents-js/tree/main/packages/agents-core/src/sandbox) | TypeScript projection of the same shape — closest match for our types. |

### Local-Docker Backend `[confirmed]`

| Project | Read for |
|-|-|
| [buildkite/sockguard](https://github.com/buildkite/sockguard) | Ownership-label mechanics, endpoints to intercept/block, authz check pattern. Archived but the closest conceptual match. |
| [CpuID/dockerd-ci-proxy](https://github.com/CpuID/dockerd-ci-proxy) | Label injection on create, self-identification pattern. Archived, tiny. |
| [Tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) | Endpoint category allowlist defaults. |
| [wollomatic/socket-proxy](https://github.com/wollomatic/socket-proxy) | Regex-based policy config as user-facing surface. |
| [nestybox/sysbox](https://github.com/nestybox/sysbox) | Runtime itself — installation, limitations, compatibility notes. |

### Daytona Backend `[proposed]`

| Project | Read for |
|-|-|
| [daytonaio/daytona TS SDK](https://github.com/daytonaio/daytona) | First-party SDK source — `sandbox.fs.uploadFiles`, `sandbox.git.clone/push`, `process.executeSessionCommand`, `getSessionCommandLogs`. |
| [Daytona TS SDK docs](https://www.daytona.io/docs/typescript-sdk/daytona/) | API reference. |

## Open Questions

- **Whether to support topology 2** for the Local-Docker backend (nested `dockerd` inside sysbox task container). Use case not yet concrete; keep as future escalation.
- **Whether to add a third backend** (E2B, Modal, Cloudflare Containers) before the Daytona path proves out under real workload. The abstraction is designed to absorb it; not justified by a current need.
