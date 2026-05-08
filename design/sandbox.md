# Sandbox

Sandbox infrastructure. Any Cogmo feature needing isolated execution uses this module. Active consumers: coding-delegation tasks (worktree-bearing, long-lived, see [coding-delegation.md](coding-delegation.md)) and skills tier-2 (worktree-less, ephemeral Python subprocess workers, see [skills.md](skills.md)). Future consumers include untrusted MCP servers and one-off tool sandboxes.

## Purpose `[proposed]`

Run arbitrary commands and downstream tooling in isolated environments. Two backend families share one abstraction:

- **Local-Docker** — task containers run directly against the host's Docker daemon, with a Cogmo proxy injecting policy at every container create. Userns boundary via sysbox. Suited to hosts that have Docker + sysbox installed.
- **Managed cloud** (Daytona) — task containers run in a third-party sandbox provider. Provider owns isolation and lifecycle; Cogmo drives via the provider's API.

Both paths offer:

- **Strong isolation by default** — userns on the local backend (sysbox), VM-class on managed backends.
- **One abstraction for downstream code** — the orchestrator, coding tool, and skills runner code against `SandboxClient` / `SandboxSession`, not against a specific provider.
- **Per-consumer images** — coding-delegation runs `cogmo/devbase` (with `claude-code` baked in); skills tier-2 runs `python:3.14-slim` (or a Cogmo-baked successor) by manifest. Image is per-session, not per-backend.

Compatibility with existing tooling — testcontainers, `docker compose`, `docker buildx` — is preserved. On the local backend they spawn host-visible siblings through the Cogmo proxy. On managed backends they spawn provider-internal siblings; the provider's sandbox boundary is the policy boundary.

A unified policy plane across both backend families is a non-goal. Policy lives where it can be enforced — Cogmo's Docker proxy on local, the provider's sandbox boundary on managed.

## Backend Architecture `[proposed]`

### Two interfaces

`SandboxClient` is the factory — owns provider config, mints sessions, performs lifecycle operations. `SandboxSession` is the handle — owns one running task environment, exposes exec / file / git operations. The split mirrors the [OpenAI Agents SDK](https://github.com/openai/openai-agents-js/tree/main/packages/agents-core/src/sandbox) shape, which uses the same pattern to plug Daytona, E2B, Modal, Cloudflare Containers, etc. behind one abstraction.

```ts
interface SandboxClient<TState> {
  readonly backendId: string;
  readonly capabilities: SandboxCapabilities;

  /**
   * Ensure `image` is reachable from the backend (locally cached on
   * Local-Docker, registry-reachable on Daytona). Idempotent and cheap
   * when satisfied. Consumers call this before `create()` so the first
   * task doesn't pay an unbounded pull inside its own latency budget.
   */
  ensureImagePresent(image: string): Promise<void>;

  create(spec: SessionSpec): Promise<SandboxSession>;
  resume(state: TState): Promise<SandboxSession>;
  delete(session: SandboxSession): Promise<void>;
  serializeState(state: TState): Record<string, unknown>;
  deserializeState(payload: Record<string, unknown>): TState;
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
| `ensureImagePresent` | dockerode inspect + pull | no-op (Daytona builds + snapshots on first `create()`; no separate probe in the SDK) |
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

## Daytona Backend `[proposed]`

The Daytona backend runs task sandboxes on Daytona's managed cloud (default) or self-hosted Daytona instance. Daytona owns sandbox isolation and lifecycle. Cogmo drives via the [Daytona TypeScript SDK](https://www.daytona.io/docs/typescript-sdk/daytona/).

**Status:** Designed against the SDK docs; **not yet exercised at Cogmo's expected concurrency or log volume.** The streaming-exec WebSocket path in particular (`getSessionCommandLogs`) is the load-bearing piece that needs real-traffic validation before this section moves to `[confirmed]`. Specific unknowns: WS keepalive behaviour over multi-minute idle stretches, log-buffer behaviour during transient disconnect, and whether `executeSessionCommand({ runAsync: true })` honours per-command timeouts the way buffered `executeCommand` does.

### Authentication & deployment

API-key auth. The key is stored as `daytona_api_key` in the encrypted `secrets` table per [infrastructure.md](infrastructure.md) → Secrets — the same path LLM provider keys, channel tokens, and the GitHub PAT take. The setup wizard prompts for it on first run; non-interactive bootstrap accepts a `COGMO_DAYTONA_API_KEY` (with `_FILE` variant) which is migrated into the secrets table on first boot and not consulted thereafter.

Base URL is configuration, not credential — `DaytonaSandboxClientOptions.apiUrl` carries the value (`undefined` = Daytona Cloud), populated at startup. Override via `DAYTONA_API_URL` env. The choice is deployment-time; Cogmo doesn't switch between cloud and self-hosted at runtime.

#### Keepalive

Daytona's default `autoStopInterval` reaps idle sandboxes after 15 minutes. Coding tasks stream model output for tens of minutes with arbitrary inter-token latency, which Daytona reads as "idle." The client starts a `refreshActivity()` ticker per live sandbox, firing every 5 minutes, to reset the auto-stop countdown. The ticker stops on `delete(session)` / `deleteByTaskId(taskId)` / `shutdown()`. `setInterval` handles are `unref()`'d so the Node process can exit cleanly when nothing else holds the loop open.

### Working-tree transport — git as transport

Applies only when `SessionSpec.worktree` is set — i.e. coding-delegation tasks. Skills tier-2 sessions omit `worktree` and skip the git ceremony entirely (`create()` → `exec()` → `delete()`).

Working-tree material moves between orchestrator and sandbox via an ephemeral branch on the repo's GitHub remote. This matches the published industry pattern across Codex, Cursor, Devin, Codespaces, and Replit — every major AI coding agent uses git-as-transport rather than bind-mount or rsync. Daytona ships `sandbox.git.clone()` and `sandbox.git.push()` as first-class SDK methods.

Per-task lifecycle (worktree-bearing sessions):

1. Orchestrator pushes the local worktree to `cogmo/run/<task-id>` on the repo's configured GitHub remote.
2. Sandbox `sandbox.git.clone(remoteUrl, /workspace, branch=cogmo/run/<task-id>, ...)` using the per-task PAT material slice 4 already provisions.
3. Claude Code commits inside the sandbox.
4. Sandbox `sandbox.git.push(...)` back to the same temp branch.
5. Orchestrator `git fetch`es the branch into its local mirror; downstream slice-4 verify+PR-open code consumes the result branch.
6. Cleanup: temp branch deleted on task teardown (success or failure).

Why git: native delta compression on push/fetch (matters for repos > 100MB), no inbound network requirement (managed sandboxes don't accept inbound ssh — rules out rsync), no bespoke tar/upload code, and slice 4 already pushes a result branch — the Daytona path adds the start-state push, nothing else.

#### Orphan branch cleanup

An orchestrator crash between step 1 (push) and step 6 (delete) leaves an orphan `cogmo/run/<task-id>` branch on the remote. Acceptable failure mode for personal scale, but it accumulates if nothing prunes. Reconcile pattern: weekly cron iterates `cogmo/run/*` refs and deletes any whose corresponding `coding_tasks` row is terminal (`pr_open`, `failed`, `cancelled`) and older than 7 days. Mirrors the `refs/cogmo-wip/<task-id>` retention pattern in [coding-delegation.md](coding-delegation.md) → Worktree persistence — same ref namespace discipline, same cron job. Per-PR webhook for minute-level cleanup is a P3 follow-up.

### Streaming exec

The Daytona PTY path is wrong for `claude` — TTY mode triggers the CLI's interactive output (color codes, spinners) per claude-code's `isatty(stdout)` check, corrupting NDJSON parsing, and PTY collapses stdout/stderr into a single channel.

The fitting path is the non-PTY session-logs WebSocket: `executeSessionCommand({ runAsync: true })` returns a command id, then `getSessionCommandLogs(sessionId, commandId, onStdout, onStderr)` opens a WS with separated stdout/stderr callbacks. The streaming wrapper exposes the same `Readable`-stream shape the Local-Docker backend produces via dockerode demux — downstream code is backend-agnostic.

WS reality the wrapper hides:

- **Callbacks are per-chunk, not per-line.** Consumers wanting lines do their own splitter (`split2` etc.) on the returned `Readable`.
- **Exit code arrives separately.** The WS closes when the command exits; the wrapper then fetches `getSessionCommand(sessionId, commandId)` to read the exit code.
- **No per-command kill.** `dispose()` calls `deleteSession(sessionId)`, which tears down everything in that session. To keep dispose semantics clean, the wrapper allocates **one Daytona session per `execStreaming()` call**.
- **No WS heartbeat.** The wrapper relies on the client's per-sandbox `refreshActivity()` ticker (see Authentication & deployment) to keep the sandbox alive across long execs.

`claude` is wrapped by `stdbuf -oL -eL` inside the sandbox to defeat its block-buffering bug ([anthropics/claude-code#25670](https://github.com/anthropics/claude-code/issues/25670)). `stdbuf` is in coreutils on every reasonable base image. If a future image lacks it, fall back to `script -qfc 'claude …' /dev/null`.

Fallback if the WS proves flaky on a long task: HTTP-poll the same logs endpoint with a byte offset (~1s latency, AWS-SSM/CloudWatch pattern). Gated behind a feature flag, not a hot-swap.

### Custom image

The image declared in `SessionSpec.image` is referenced via Daytona's `Image.base("registry/path:tag")` — no Dockerfile rebuild on Daytona's side. Cogmo-owned images (`cogmo/devbase` for coding-delegation) are published to a registry Daytona can pull from (Docker Hub or GHCR); third-party images (e.g. `python:3.14-slim` for skills tier-2) come straight from their published location.

**Initially public-registry only.** The Daytona TS SDK does not expose a private-registry-credential API; private registries are added via the Daytona Dashboard → Registries panel before referencing the image. Cogmo-owned images publish to a public namespace (GHCR public) until that gap closes upstream or a deployer explicitly opts into the dashboard flow.

`ensureImagePresent` is a no-op on this backend — Daytona's builder pulls + snapshots the image on first `create()`, and there is no "is this image reachable" probe in the SDK that doesn't pay the build cost itself. First-task latency on a fresh image is 2–5 minutes; subsequent tasks reuse the cached snapshot.

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

### Crash recovery

`SandboxSessionState` for the Daytona backend stores `{ type: "daytona", sandboxId, sessionId }`. On orchestrator restart mid-task, `client.resume(state)` re-attaches to the existing sandbox via the Daytona API. If the sandbox was reaped (TTL exceeded, manual delete, provider-side eviction), `resume()` fails fast and the orchestrator marks the task failed.

## Module Structure `[proposed]`

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
