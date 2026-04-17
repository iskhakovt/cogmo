# Sandbox

Container sandbox infrastructure. Any Cogmo feature needing isolated execution (coding tasks, untrusted MCP servers, ephemeral tool runs) uses this module. Not coding-specific — coding delegation is one consumer, documented in [coding-delegation.md](coding-delegation.md).

## Purpose `[proposed]`

Run arbitrary commands and downstream tooling (test runners, compose stacks, buildx) in containers with:

- **Strong isolation** by default — userns via sysbox, so root-in-container ≠ root-on-host.
- **Full lineage tracking** — every spawned container/network/volume recorded with parent, root task, depth, TTL.
- **Policy at the Docker API level** — deny host binds, privileged mode, host networking, unapproved registries at create time.
- **Compatibility with existing tooling** — testcontainers, `docker compose`, `docker` CLI all work unmodified. They see what looks like a normal Docker daemon.

Non-goal in P1: running tasks across multiple hosts. The `Sandbox` interface leaves room for a remote impl later.

## Topology `[proposed]`

Host daemon runs normally. Cogmo adds:

1. **Container supervisor** — creates task containers directly against the host daemon with `HostConfig.Runtime = "sysbox-runc"` by default.
2. **Docker API proxy** — per task container, Cogmo allocates a Unix socket at `/run/cogmo/sockets/<task-id>.sock`, mounted into the task container at `/var/run/docker.sock`.
3. **Sibling-container spawn model** — when the task container (or its tooling) calls the proxy to create a child, the child is a *sibling* on the host daemon, not a truly nested container. The parent relationship lives in Cogmo's DB and in Docker labels. Proxy injects `HostConfig.Runtime = "sysbox-runc"` on children by default so every container in the tree is userns-isolated.

Topology 2 — nested `dockerd` inside the task container — is deferred. Only add it if a specific use case requires a private daemon (rare for personal scale).

## Runtime Selection `[proposed]`

**Default:** `sysbox-runc`. Selected via `SANDBOX_RUNTIME` env var with values `sysbox` (default) or `runc`. No silent fallback — if `SANDBOX_RUNTIME=sysbox` and the runtime isn't registered on the host, Cogmo refuses to start a task. Explicit configuration over magic.

**Per-task escape hatch:** `coding_tasks.allow_privileged_runc = true` drops back to plain `runc` for that task. Reserved for workloads that break under sysbox (direct device access, certain kernel caps). Expected usage: rare.

**Reason this is the default:** userns isolation is cheap insurance for Cogmo-edits-Cogmo scenarios. One-time install cost, consistent policy across every container in the tree. See [decisions.md](decisions.md) for the full comparison against pure-runc.

### Deployment OS

**Ubuntu 22.04 LTS or newer** is the supported deployment target. Sysbox ships first-class `.deb` packages and the kernel feature set they rely on is exercised widely on Ubuntu. Other distros may work but are not on the test matrix.

### Dev machine

No parity. Coding delegation is a prod/staging feature — local `pnpm dev` does not start the sandbox module and does not need sysbox installed. Developers working on sandbox code run it against a local VM or a dedicated Ubuntu host. Unit tests use plain Docker with no runtime injection.

## Data Model `[proposed]`

Owned by `src/sandbox/store/`.

```sql
-- Enumerated types (Drizzle pgEnum in the store schema)
CREATE TYPE container_runtime AS ENUM ('sysbox-runc', 'runc');
CREATE TYPE container_status  AS ENUM ('starting', 'running', 'exited', 'reaped');

containers (
  id               UUID v7 PK,
  docker_id        TEXT NOT NULL UNIQUE,            -- Docker's container ID
  parent_id        UUID REFERENCES containers(id),  -- null = created by Cogmo directly
  root_task_id     UUID,                            -- denormalized, NO FK — not every container belongs to a coding task (keep it that way; don't add a FK later)
  depth            INT NOT NULL,                    -- 0 = task container, 1+ = spawned by tooling
  image            TEXT NOT NULL,
  runtime          container_runtime NOT NULL,
  labels           JSONB NOT NULL,                  -- ContainerLabelsSchema = z.record(z.string(), z.string())
  resource_limits  JSONB NOT NULL,                  -- ResourceLimitsSchema = z.object({ cpus: z.number(), memory_bytes: z.number().int(), pids: z.number().int() })
  status           container_status NOT NULL,
  exit_code        INT,
  ttl_expires_at   TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  exited_at        TIMESTAMPTZ,
  instance_id      UUID NOT NULL                    -- Cogmo process run id, for crash recovery (references cogmo_instances.id)
)
```

Same pattern for `networks` and `volumes` tables — Docker objects Cogmo provisions or allows tooling to provision.

`parent_id` + `root_task_id` + `depth` computed at insert time from the parent row. No recursive CTE in the hot path.

```sql
cogmo_instances (
  id         UUID v7 PK,                           -- referenced as containers.instance_id
  host       TEXT NOT NULL,                        -- hostname or pod id
  pid        INT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stopped_at TIMESTAMPTZ                           -- null = current instance; set on graceful shutdown
)
```

Row inserted in bootstrap before any sandbox operations; `stopped_at` updated on graceful shutdown. Orphan detection joins `containers.instance_id → cogmo_instances.id` — any container tied to a row with non-null `stopped_at`, or a row that was never closed and whose pid no longer exists on the host, is an orphan. Gives an audit trail ("this run started at X, managed N tasks, stopped at Y") and a foundation for multi-host later.

## Label Schema `[proposed]`

Every container Cogmo creates or proxies gets these Docker labels:

| Label | Value | Purpose |
|-|-|-|
| `cogmo.managed` | `"true"` | Identifies Cogmo-owned containers for orphan detection |
| `cogmo.instance` | `<run_id>` | Current Cogmo process's run id — on restart, anything with a different instance is an orphan |
| `cogmo.root_task` | `<task_id>` | Cascade scope — everything with the same value is reaped together when the task ends |
| `cogmo.parent` | `<docker_id>` | Parent container's Docker id (empty for root) |
| `cogmo.depth` | `<int>` | Depth in the tree |

Labels are the **mirror**; Cogmo DB is **authoritative**. Labels enable orphan detection via `docker ps --filter label=cogmo.managed=true` and survive Cogmo restarts for reconciliation.

## Proxy Design `[proposed]`

Written in TS, lives in `src/sandbox/proxy.ts`. Single Node process. Listens on multiple Unix socket paths simultaneously — one per active task container. Socket path identifies the caller's parent.

### Intercepted endpoints

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

### Policy at `POST /containers/create`

Defaults applied unless explicitly allowed per task:

- **Deny** `HostConfig.Privileged = true`
- **Deny** `HostConfig.NetworkMode = "host"`
- **Deny** `HostConfig.Binds` with host paths outside the task's allowed mount set (worktree, caches)
- **Deny** `HostConfig.CapAdd` containing `SYS_ADMIN`, `NET_ADMIN`, `SYS_PTRACE` (and friends)
- **Inject** `HostConfig.Runtime = "sysbox-runc"` unless task opts into `runc`
- **Inject** resource caps inherited from the task container (child can't ask for more CPU/memory than the task has)
- **Inject** Cogmo labels

### Authentication

No tokens. The socket path *is* the identity. Mount access is controlled by filesystem perms — only the target task container can connect. Each task gets a private socket.

### Implementation note

The proxy is a Unix socket server. Most Docker API calls are plain HTTP/1.1 and pass through via `http.request` to `/var/run/docker.sock`.

Endpoints that need more than HTTP req/resp — all handled by the same raw bidirectional pipe, not separate code paths:

- `/containers/{id}/attach`, `/exec/{id}/start`, `/events`, log follow — hijacked connections, plain bytes after the upgrade.
- `/build` — streaming tar upload with NDJSON progress stream back. HTTP/1.1, but long-lived; pipe both directions.
- `/session` (BuildKit / buildx) — HTTP/1.1 `Upgrade` to gRPC-over-HTTP/2. Node's `http` server surfaces the upgrade via the `upgrade` event. After the upgrade completes, it's just bytes on a socket — pipe them to the daemon socket in both directions and stay out of the way. We don't need to understand gRPC.

Node's `http` module exposes upgrades via the `upgrade` event; forward the raw socket with `stream.pipe()` in both directions. No buffering, no HTTP/2 implementation in Node.

**What this gets us in P1.** Transparent buildx support — `docker buildx build`, the default `docker` driver (uses host BuildKit), and the `docker-container` driver (spawns a buildkitd sibling, which comes up through our `/containers/create` path with labels injected) all work. Testcontainers' image build path works. `docker compose build` works.

**What this does NOT get us in P1.** Policy enforcement on build contents — things like "deny this `FROM` because it's from an unapproved registry" or "deny this `RUN` because it mounts host paths" — requires parsing the BuildKit gRPC session. That's the [moby/buildkit Go SDK](https://github.com/moby/buildkit) territory (or TS stubs autogenerated from the [`frontend/gateway/pb`](https://github.com/moby/buildkit/tree/master/frontend/gateway/pb) `.proto` files). Deferred; basic registry policy at `POST /images/create` covers the common case.

References: [buildkite/sockguard](https://github.com/buildkite/sockguard) (label model + endpoint selection), [CpuID/dockerd-ci-proxy](https://github.com/CpuID/dockerd-ci-proxy) (label injection on create), [Tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) (endpoint categories to block).

## Reaper `[proposed]`

Inngest cron, runs every 30s. Three passes:

1. **TTL expired** — `WHERE ttl_expires_at < now() AND status IN ('starting','running')`. Kill post-order: children first (sort by `depth DESC`), then parent.
2. **Orphan detection** — `docker ps --filter label=cogmo.managed=true`. Anything present on the daemon but missing from the DB, or labelled with a dead `cogmo.instance`, gets killed.
3. **Stale DB rows** — containers in DB with `status != 'reaped'` but missing from `docker ps` get marked exited with no exit code.

Root-task cascade (not on cron — triggered by task completion/failure): `WHERE root_task_id = $t AND status != 'reaped' ORDER BY depth DESC` → stop + remove.

Networks and volumes reaped last, after all containers in the root task are gone.

## Lifecycle `[proposed]`

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

## Crash Recovery `[proposed]`

At Cogmo boot:

1. Generate new `instance_id` for this run.
2. List containers matching `label=cogmo.managed=true` via Docker daemon.
3. For each found container:
   - If its `cogmo.instance` ≠ current instance → orphan from a previous run. Stop + remove. Mark any matching DB row `reaped`.
   - If a DB row exists and matches the current instance → crash during task execution. Mark status according to Docker's report; if still running, let the task resume (session_id in `coding_tasks` lets us rejoin).
4. Same pass for networks and volumes.

Proxy crash mid-task: in-memory socket map is lost. Supervisor rebuilds it from the `containers` table (query `depth=0 AND status='running' AND instance_id=<current>`) and re-creates the socket files. Tasks briefly see "Docker daemon unavailable" errors; retry on their end, or Cogmo marks the task failed if the gap is long.

## Networks, Volumes, Images `[proposed]`

**Networks and volumes:** tracked identically to containers, with the same `root_task_id` cascade. Common case — docker compose brings up services + a network; all get reaped together when the task exits.

**Images:** shared across tasks, not reaped per-task. Separate GC job keyed on disk budget — prune dangling + untagged + LRU-with-max-age, enforced every N minutes or when disk > threshold. Pull policy: registry allowlist (empty by default = allow all).

### Cache volume scoping

Package-manager caches are scoped by **integrity story**, not by a blanket per-repo rule. Three classes:

| Cache | Scope | Volume naming | Rationale |
|-|-|-|-|
| npm store (`~/.npm/_cacache`), cargo registry (`~/.cargo/registry`), go modules (`~/go/pkg/mod`), apt (`/var/cache/apt/archives`) | **Global** | `cogmo-cache-<kind>` | Ecosystem enforces integrity on read — SHA-512 from lockfile (npm), `go.sum` (go), `Cargo.lock` (cargo), GPG signature (apt). A forged artifact fails the check and is re-downloaded. Sharing recovers hundreds of MB and speeds cold starts with no added attack surface beyond the sandbox boundary itself. |
| pip wheels (`~/.cache/pip`) | **Per-repo** | `cogmo-cache-<repo-id>-pip` | `requirements.txt` rarely pins hashes by default; pip won't verify wheel content unless `--require-hashes` is used. A compromised task could plant a wheel that a later task installs without verification. Per-repo contains the blast radius. |
| Build caches — Go build (`~/.cache/go-build`), Rust `target/`, Bazel output | **Per-repo** | `cogmo-cache-<repo-id>-<kind>` | No ecosystem integrity — output is content-addressed on inputs but unsigned. Sandbox-escape-to-cache-poison is a live threat class (Bazel RBE and Nix treat it seriously). Also: cross-repo hit rate is near zero because hash keys encode project-specific inputs. Nothing to gain from sharing, real risk from sharing. |
| Installed trees — `node_modules`, `.venv`, Rust `target/debug/` | **Never cached cross-task** | — | Per-project by nature; live inside the worktree. |

Global caches get an additional GC pass in the same disk-budget job as images — LRU eviction when disk > threshold. Per-repo caches live for the lifetime of the `coding_repos` row; removed when the repo is deregistered.

The attack surface this leaves is: a sandbox escape that reaches a shared cache volume. The download caches with integrity checks harmlessly reject the forgery. The remaining exposure (pip, build caches) is kept per-repo so a compromised task on repo A can't affect repo B even if the sandbox falls.

## Resource Accounting `[proposed]`

Per root task: cumulative CPU-seconds, memory-seconds, disk bytes written, network bytes. Polled from Docker stats API, aggregated across all containers sharing a `root_task_id`, written to `coding_tasks.resource_usage`. Accounting is observational — the numbers exist for budget reporting and post-hoc analysis, not for live enforcement (the cgroup parent below does the enforcement).

### Hierarchical enforcement via cgroup parent

Siblings in our topology are separate cgroups under the host root by default, so "children sum ≤ parent" is not automatic the way it is in nested-dockerd setups. We fix this by attaching every container in a root task to a shared cgroup parent — the kernel then hierarchically enforces the task's total budget regardless of how many children spawn or what each one requests.

Mechanism:

1. On `sandbox.createTaskContainer`, supervisor creates a systemd slice (or direct cgroupfs node on hosts without systemd) at `cogmo-task-<task-id>.slice`. CPU, memory, and pid limits set to the task's total budget.
2. Task container is created with `HostConfig.CgroupParent = "cogmo-task-<task-id>.slice"`.
3. Proxy injects the same `CgroupParent` on every `POST /containers/create` from within the task's socket. Every sibling is now a child cgroup under the task's slice.
4. On root-task teardown, after all containers are reaped, supervisor removes the slice.

Outcome: the task's total budget is a hard ceiling enforced by the kernel. Individual child limits become advisory — a child asking for 4 CPU when the task has 4 still works, it just competes with siblings via normal fair-share scheduling. No policy code in the proxy, no sum-of-sibling bookkeeping, no admission race conditions.

Matches how Kubernetes pod-level cgroups enforce pod resource limits under the hood. Requires cgroupv2 on the host — Ubuntu 22.04+ default, consistent with our deployment OS choice.

## Deployment Topology `[proposed]`

**Single image, two subcommands.** `cogmo serve` runs the main orchestrator; `cogmo sandbox-proxy` runs the socket proxy. Same binary, same codebase, no duplicate artifacts.

### P1 — in-process

Default shipping configuration. `cogmo serve` boots the proxy as a module on its own event loop — no IPC, no separate service. Crashes in either part bring down the other, acceptable at personal scale because Cogmo restarts are rare and Inngest's durable resume handles task-state recovery across the outage window.

### P2 — extracted sidecar

Two processes sharing the image:

- `cogmo serve` — main orchestrator. No docker daemon access.
- `cogmo sandbox-proxy` — socket proxy. Holds `docker` group membership. Owns `/run/cogmo/`.

This is the target topology. Industry-standard separation (every reference proxy runs this way — see Reference Implementations table). Extracted when an in-process crash first disrupts a live task.

### Control plane — tRPC

Main ↔ proxy communicate via a tRPC router in `src/sandbox/rpc/router.ts`. The router is the `Sandbox` interface projected over the wire — same shape, same domain schemas (`TaskContainerSpec`, `ContainerRow`, etc.), just network-accessible. Zod procedures make it drift-proof via TS inference on both sides.

```ts
// abbreviated — mirrors the Sandbox interface
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

### Transport — deployer's choice

Configured via environment:

| `SANDBOX_PROXY_LISTEN` | Use case | Auth |
|-|-|-|
| `unix:///run/cogmo/sandbox.sock` | Single host, systemd or Compose with shared tmpfs (default) | Filesystem perms |
| `tcp://127.0.0.1:<port>` | Single host, no shared filesystem | Loopback-only, implicit trust |
| `tcp://<bind>:<port>` | Split hosts (proxy colocated with docker daemon, main elsewhere) | Deployer supplies mTLS or an authenticating reverse proxy; Cogmo does not mint credentials |

tRPC's HTTP client accepts a custom `fetch`, so the Unix-socket case is wired via undici's `Agent({ socketPath })`. No code difference between transports beyond the URL.

### P1 → P2 migration

Swap at the `Sandbox` interface boundary. P1 `LocalInProcessSandbox` calls the supervisor module directly; P2 `LocalSidecarSandbox` calls the tRPC client. Consumers (`src/agent/coding/` etc.) see the same `Sandbox` contract — no upstream changes. No data migration: all state lives in PostgreSQL already.

## Module Structure `[proposed]`

```text
src/sandbox/
  index.ts           — public API (Sandbox interface, factory)
  supervisor.ts      — container lifecycle, socket allocation
  proxy.ts           — HTTP proxy server, policy, label injection
  reaper.ts          — TTL + orphan + cascade logic
  runtime.ts         — sysbox detection + runtime selection
  store/
    schema.ts        — containers, networks, volumes tables
    index.ts         — SandboxStore interface + Drizzle impl
```

Exposed via a `Sandbox` interface:

```typescript
interface Sandbox {
  createTaskContainer(spec: TaskContainerSpec): Promise<TaskContainerHandle>;
  stopTask(taskId: string): Promise<void>;
  listContainersForTask(taskId: string): Promise<readonly ContainerRow[]>;
  // …
}
```

`LocalInProcessSandbox` is the P1 implementation (proxy as a module inside `cogmo serve`). `LocalSidecarSandbox` replaces it in P2 — same interface, calls the tRPC client from *Deployment Topology → Control plane* instead of the supervisor directly. Future `RemoteSshSandbox` or `FlyMachineSandbox` slot behind the same interface.

## Reference Implementations `[confirmed]`

Worth reading before implementation:

| Project | Read for |
|-|-|
| [buildkite/sockguard](https://github.com/buildkite/sockguard) | Ownership-label mechanics, endpoints to intercept/block, authz check pattern. Archived but the closest conceptual match. |
| [CpuID/dockerd-ci-proxy](https://github.com/CpuID/dockerd-ci-proxy) | Label injection on create, self-identification pattern. Archived, tiny. |
| [Tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) | Endpoint category allowlist defaults. |
| [wollomatic/socket-proxy](https://github.com/wollomatic/socket-proxy) | Regex-based policy config as user-facing surface. |
| [nestybox/sysbox](https://github.com/nestybox/sysbox) | Runtime itself — installation, limitations, compatibility notes. |

## Open Questions

- **Whether to support topology 2** (nested `dockerd` inside sysbox task container). Use case not yet concrete; keep as future escalation.
