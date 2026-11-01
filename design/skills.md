# Skills `[proposed]`

Execution runtime, storage, and invocation for agent-authored skills — small Python programs the agent writes to accomplish recurring tasks.

## Scope

**In:**

- How skills are stored (git repo layout)
- How skills execute (runtime tiers, warm pool)
- How skills are invoked (Inngest events, cron)
- State handling between invocations
- How a skill is authored, checked and deployed without a human reading its code ([Authoring pipeline](#authoring-pipeline-proposed))
- Where skill network traffic may go ([Egress proxy](#egress-proxy-proposed))

**Out (covered elsewhere):**

- The coding tasks that write a skill — see [coding-delegation.md](coding-delegation.md)
- Skill discovery / retrieval — see [integrations.md](integrations.md) (Voyager pattern, SKILL.md standard, description embedding)
- General sandbox infrastructure — see [sandbox.md](sandbox.md)

## Background

Once the agent can evolve (evolution stage 2+), it writes small programs for recurring tasks ("fetch calendar and summarize", "post a reminder to Slack"): *skills*, persisted code it invokes through a tool or a schedule. This doc specifies the runtime that executes them, and how they are stored, authored and deployed.

## Language: Python `[confirmed]`

Skills are Python: models write it better than TypeScript for script-shaped tasks, and the data libraries, vendor SDKs and agent tooling a skill reaches for are Python-first. TypeScript is revisited when a concrete driver appears (host-registered typed tools, V8-isolate density).

## Execution: two tiers `[confirmed]`

Skills execute in one of two sandboxes, chosen by skill metadata. No middle ground (no bare subprocess tier), no third tier unless a concrete need appears.

### Tier 1 — WASM (Pyodide)

**Used for:** skills that only need HTTP through `ctx`, stdlib, and pre-built / pure-Python packages.

**Why:** glue code without a container boot. What isolates it today, and the hardening that makes it a boundary: [Tier-1 boundary](#tier-1-boundary-proposed).

**Constraints:**

- No `subprocess`, no shell-outs, no native binaries
- Packages limited to Pyodide's [pre-built list](https://pyodide.org/en/stable/usage/packages-in-pyodide.html) (~200+ including numpy, pandas, cryptography, sqlalchemy) plus pure-Python wheels installable via `micropip`
- The full CPython standard library is importable directly — `ssl`, `sqlite3`, `lzma`, `hashlib` and the rest ship inside `python_stdlib.zip` rather than as separately-loadable `cpython_module` entries, so a skill imports them with no `loadPackage` call and no manifest declaration
- No sockets. The stdlib imports fine (previous bullet), but the modules that open a connection — `urllib.request`, `http.client`, `ftplib`, `smtplib` — have nothing underneath them, so HTTP goes through `await ctx.http.get(url)`, performed by the host. `wasm-lint` rejects those specific modules at deploy time, turning what would be an error on first invocation into a clear rejection. Network-free parts of the same packages (`urllib.parse`, `urllib.error`) are unaffected
- No `os.fork`, limited threading

**Typical coverage:** REST calls through `ctx.http`, data transforms, JSON/CSV manipulation, plotting. Roughly the "glue code + data" slice of skills. Vendor SDKs (Anthropic, OpenAI, Slack, Google) belong in tier 2: they reach for `httpx`/`requests` internally, which need the sockets this tier does not have, and cannot be redirected through `ctx`.

### Tier 2 — Sysbox container

**Used for:** skills that need `subprocess`, native binaries, arbitrary pip wheels with C extensions, or full-OS isolation.

**Why:** full Python + OS ecosystem, hardened namespaces (user namespaces = root-in-container ≠ root-on-host), consistent with the runtime already chosen for coding delegation. Full [sandbox.md](sandbox.md) infrastructure reused. The `cogmo-skills:<version>` runtime image carries `uv` so register-time compile and first-invoke populate run the same resolver inside the sandbox ([Lockfile](#lockfile), [Populate](#populate)).

**Constraints:**

- Higher resource overhead (~100–300 MB per worker for Python + imports)
- 1–2s cold start if not warm — addressed by the warm pool
- First task using a new lockfile hash pays a one-time populate cost (single-digit seconds for typical dep sets); shared across all subsequent tasks and skills with the same lockfile

### Alternatives for tier 2

Sysbox over plain `runc`: skills need no Docker-in-Docker, but the sysbox daemons already run for coding delegation (~50 MB fixed), a container costs ~5–10 MB more than under `runc`, and user namespaces keep root in the container unprivileged on the host, so one runtime serves both. A microVM (Firecracker) is deferred: its separate kernel defends against an adversary trying to escape, a stronger threat than the agent's codegen misbehaving, which namespaces cover, and it costs 128 MB of guest RAM per instance and a new toolchain (firecracker-containerd, rootfs images, virtio-fs, TAP networking). It is revisited if the trust boundary widens (a public skill library, third-party skills triggered remotely).

### Resource budgets `[proposed]`

Per-skill caps on memory, CPU, wall-clock. Enforced at runtime, declared in `SKILL.md` frontmatter (optional — defaults apply if absent).

| Tier | Memory | Wall-clock | CPU | Mechanism |
|-|-|-|-|-|
| **WASM** | 128 MiB of linear memory | 30 s | n/a (single-threaded isolate) | None enforces memory today; the `grow` hook and the interrupt-then-kill stop are in [Tier-1 boundary](#tier-1-boundary-proposed). |
| **Container** | 512 MB | 60 s | 1 CPU share | Per-run cgroup slice under [sandbox.md](sandbox.md)'s cgroup parent pattern — same mechanism as coding delegation's per-task budgets. The task's relay ends the task on wall-clock expiry and the supervisor SIGKILLs its processes. |

Override per skill:

```yaml
---
name: heavy-data-job
tier: container
resources:
  memory_mb: 2048
  wall_clock_s: 300
  cpu_shares: 2
---
```

Overrides are validated at deploy against hard ceilings, the same for both tiers: `memory_mb` ≤ 2048, `wall_clock_s` ≤ 600, `cpu_shares` ≤ 4.

### Tier-1 boundary `[proposed]`

**Today `[confirmed]`.** Tier 1 is not an isolation boundary. `host.ts` starts a `worker_threads` Worker with no `env`, `execArgv` or `resourceLimits`, so the thread holds a copy of the server's environment, the master key included. `worker-entry.ts` calls `loadPyodide` without `jsglobals`, so Python's `js` module is the thread's `globalThis`: `js.process.env`, an unguarded `fetch` the SSRF guard never sees, and `pyodide.http.pyfetch` on top of it. `pyodide_js.FS.mount(NODEFS, …)` mounts host paths. Every JS proxy's `.constructor` is the `Function` constructor, so JS code built from a string runs in the host's global scope. `wasm-lint` has no rule for `js`, `pyodide_js` or `micropip`. What holds is the CPU bound: the interrupt buffer raises `KeyboardInterrupt` within milliseconds at the next JS↔WASM boundary, and `worker.terminate()` ends a loop that never reaches one.

**Layers**, in the order they ship. Each closes a route the others leave open, and a test per layer turns the others off and shows its route closed.

1. **A forked child process per worker** under `--permission`, granted only `--allow-fs-read` for the Pyodide distribution and the worker's read-only wheel directory and `--allow-worker`, plus `--disallow-code-generation-from-strings`: `fetch` throws `ERR_ACCESS_DENIED`, `FS.mount(NODEFS)` reaches nothing outside the grant, and the `Function`-constructor path throws `EvalError` (Pyodide evaluates no JS string once loaded). Pyodide runs on a worker thread whose `execArgv` re-lists the child's flags (an explicit `execArgv` otherwise drops the grant), so the child's main thread can write the interrupt buffer they share. Emscripten side modules that define JS with `EM_JS` build it from strings at load, so `pyodide-compat.ts` load-tests each native package in the lockfile under the flag, and one that fails makes the skill `tier: container`. The child shims `process.binding("constants")`, which Emscripten's boot calls and `--permission` denies, with `os.constants`. It exits when its IPC channel disconnects, so a dying host takes its children with it; each child leads its own process group, recorded in the host's runtime directory, and boot `SIGKILL`s every recorded group before the pool starts, since without the cgroup nothing else bounds an orphan. Node documents that the permission model does not stop malicious code: it follows symlinks out of granted paths, so the host writes the wheel directory without links, and inherited file descriptors bypass it, so the child inherits only the IPC channel.
2. **`env: {}`** for the child.
3. **Minimal `jsglobals`**: a frozen null-prototype object holding only `setTimeout` and `clearTimeout`, which `webloop` needs for the asyncio loop that `ctx` RPCs await. `ctx` crosses through the registered `__cogmo_bridge__` module, which `jsglobals` does not affect.
4. **No network from the start.** The host fetches the lockfile's wheels from PyPI, checks each against its `requirements.lock` hash (closing micropip's missing `--require-hashes`), and writes them to a per-lockfile-hash directory the child can only read. The child installs from that copy. Before skill code runs, the child deletes `fetch`, `XMLHttpRequest` and `WebSocket` from its globals, so a hole in layer 1 still finds no network API. Pyodide's built-in packages (pydantic among them) come from a `packageCacheDir` the host fills with `checkIntegrity` on.
5. **Memory.** Worker `resourceLimits` cap only the JS heap, never ArrayBuffers, and WebAssembly memory is one: a measured worker with a 64 MB JS heap limit grew Pyodide to 3.2 GB. Before `loadPyodide`, the child patches `WebAssembly.Memory.prototype.grow` to throw past `resources.memory_mb` (128 MiB by default, re-measured with pydantic loaded); Python sees a `MemoryError` and the interpreter survives. The hook covers Emscripten's growth path, which calls `grow` from JS; it does not cover a WebAssembly `memory.grow` instruction or code that reaches the original method another way. The hard ceiling is a per-child cgroup, which needs the delegation [sandbox.md](sandbox.md#hierarchical-enforcement-via-cgroup-parent-confirmed-slice-naming--assignment--proposed-aggregate-budget-enforcement) defers; without it there is no hard memory ceiling. `RLIMIT_AS` is not used, since V8 reserves guard regions far larger than the heap. `tier1Hardened` therefore claims no hard ceiling; a separate `tier1MemoryBounded`, set where the per-child cgroup exists, does. Rule 4 of [Risk tiers without a human](#risk-tiers-without-a-human) reads only `tier1Hardened`, since the gap the cgroup closes costs availability, not a secret.
6. **CPU.** At `wall_clock_s` the host sends the child an IPC message, since a `SharedArrayBuffer` cannot cross `fork()`; the child's main thread writes the interrupt buffer, and after the grace window the host sends `SIGKILL`, which a loop with no JS↔WASM boundary cannot outlast.
7. **Lint**: `wasm-lint` rejects imports of `js`, `pyodide_js`, `pyodide.ffi`, `pyodide.code`, `pyodide.http` and `micropip`; the verify stage rejects dynamic code. Lint is the UX layer that tells an honest author why, not a boundary.

**What it still cannot promise.** Nothing at the OS level separates the child from the server: no other uid, namespace or seccomp filter. An escape past layer 1 holds the server's OS privileges: its network, every file its user can read (the `_FILE` secrets included), and the server's own environment at `/proc/<pid>/environ`; `env: {}` keeps secrets out of the child's environment only. `tier1Hardened` claims the seven layers and no more; a guarantee past layer 1 needs OS containment, which this design does not specify. Resource exhaustion the layers do not meter (file descriptors, recursion depth, timer churn) is bounded only by the wall clock, the kill and, where present, the cgroup. Side channels between processes on one host are out of scope. The interrupt buffer is shared only between the child's two threads, and only the main thread writes it.

**Cost.** The layers are launch arguments or work before `ready`, so they add nothing per call. A child takes ~200 ms to start, which the pool hides; bare Pyodide boots in ~1 s (a worker thread spends ~5 s today, mostly on micropip fetching from PyPI), and the pydantic wheels add ~190 ms per cold child.

**Pool.** A warm child serves one task and exits, so module state, `sys.modules` and MEMFS never cross tasks. Memory snapshots cannot carry dependencies (`makeMemorySnapshot` is private API, and snapshotting after `loadPackage` throws `Unexpected hiwire entry`), so the pool pre-boots children per lockfile hash, with dependency warmth from the wheel directory. It aims to keep one idle child for the empty set and one for each recently used hash, best-effort within the `max` it shares with tier 2: a waiter of either tier with no free slot takes the slot of an idle warm child, which is retired, the least recently used hash's first and the empty set's last; a hash with no warm child pays a cold boot. A bare snapshot cuts boot from ~1 s to ~115 ms and is adopted only if Pyodide makes the API public.

## Warm pool `[confirmed]`

The container tier runs on a pool of reusable workers, so an invocation that finds a warm one skips the 1–2 s container start. The runner builds the pool on the first tier-2 invocation, keeps `min` workers (0 by default) and tears it down at `shutdown()` ([Sizing](#sizing-confirmed) → Lazy pool init).

Implementation lives across two trees. The TypeScript host in `src/skills/worker-sysbox/` (`pool.ts` for lifecycle, `worker.ts` wraps a long-lived `SandboxSession` running the python supervisor) and the Python runtime in `images/skills/` (a real `cogmo_skills_runtime` package with `pyproject.toml`, `uv.lock`, ruff + pyrefly + pytest, multi-stage Docker build that bakes the venv into `cogmo-skills:<version>` at `/opt/cogmo-skills/.venv`). The TS worker spawns the supervisor via `python3 -I -u -m cogmo_skills_runtime` — `__main__.py` calls `supervisor.main()`.

Tier 2 runs on the local-Docker backend only. The worker needs a stdin-attached exec that streams both ways, and Daytona's PTY exec buffers stdin until it ends ([sandbox.md → Streaming exec](sandbox.md#streaming-exec-confirmed)), so the supervisor never starts there and worker creation fails at the handshake.

### Shape `[confirmed]`

| Piece | Responsibility |
|-|-|
| **Pool manager** (`SysboxWorkerPool`) | Lease idle workers to tasks; queue beyond `max`. Scale between `min` and `max` on demand. Replace a dead worker at once, back up to `min`. Retire workers after N tasks or T ms age. Sweep idle workers above `min`. The shell around a pure state machine; see [Pool lifecycle](#pool-lifecycle-confirmed). |
| **Worker** (`SysboxSkillWorker`) | One sysbox container with a `SandboxSession`, reused across many tasks and skills, so nothing per task is staged at container start: the File workspace's staging `[proposed]` happens per task, in a directory the relay owns. Spawns the python supervisor process ONCE at create-time via `session.execStreaming` and refuses it unless it announces the host's protocol version. `invoke()` returns once the supervisor's `task_exited` confirms the task's processes are gone, or the worker dies. |
| **Supervisor** (`supervisor.py`) | Long-lived python process inside the container; it holds the host channel but never reads it. Per task it forks a **relay**, which forks the **task process** before reading anything from the host; see [State reset between tasks](#state-reset-between-tasks-confirmed). After the relay exits it kills and reaps its whole subtree, then sends `task_exited`. EOF on stdin = clean shutdown. |
| **Dispatcher** | The shell around a worker's state machine; see [Host-side worker lifecycle](#host-side-worker-lifecycle-confirmed). One per worker (NOT per task), reused across the worker's lifetime. Per-task `CtxHandler` is supplied at each `invoke()` call so the run id, manifest, and audit hooks scope to that task; a ctx call is served only by the handler of the running task that issued it. |

### Protocol

Bidirectional JSON-RPC over stdin/stdout, one JSON object per line:

- `supervisor_ready` (worker → host, tier 2) — sent once at startup with `protocolVersion`. The host refuses any version other than `SUPERVISOR_PROTOCOL_VERSION` (`src/skills/protocol.ts`), or none within 30 s.
- `task_invoke` (host → worker) — starts a task.
- `ctx_call` (worker → host) — `ctx.*` RPCs issued mid-task (e.g. `ctx.secrets.get()`).
- `ctx_result` (host → worker) — response to a `ctx_call`.
- `task_result` (worker → host) — the task's outcome.
- `task_exited` (worker → host) — every process the task started has been killed and reaped. Tier 2 only; the worker is reusable after it and not before. If the channel fails or the host watchdog fires between a task's `task_result` and its `task_exited`, the host still reports the delivered result — its side effects happened — and discards the worker.

A worker has one task in flight and possibly several `ctx_call`s nested inside it, correlated by `id`. Every `ctx_call` and `ctx_result` also carries the `taskId` it belongs to, set by the relay (tier 2) or the worker's bridge (tier 1) — never by skill code. The dispatcher serves a `ctx_call` only when it names the in-flight task and that task has not yet returned its `task_result`; anything else is refused and logged. The relay delivers a `ctx_result` only to the task it names.

```json
// worker → host (startup)
{"type": "supervisor_ready", "protocolVersion": 3}

// host → worker
{"type": "task_invoke", "id": "run-7f3", "skill": "summarize-email", "inputs": {...}}

// worker → host (mid-task)
{"type": "ctx_call", "taskId": "run-7f3", "id": "ctx-9a2", "method": "secrets.get", "args": {"name": "slack_webhook"}}

// host → worker (answer to ctx-9a2)
{"type": "ctx_result", "taskId": "run-7f3", "id": "ctx-9a2", "ok": true, "value": "..."}

// worker → host (outcome, then teardown confirmed)
{"type": "task_result", "id": "run-7f3", "ok": true, "output": {...}}
{"type": "task_exited", "id": "run-7f3"}
```

stdin/stdout chosen over HTTP / Unix socket for simplicity — one process per worker, no port allocation, no service discovery. Inside the container the host channel never reaches skill code; see [State reset between tasks](#state-reset-between-tasks-confirmed).

The supervisor ships in the `cogmo-skills:<version>` image published with each release. In the release image `COGMO_SKILLS_IMAGE` defaults to the matching tag; elsewhere to `:latest`. A supervisor announcing another protocol version, or none, fails worker creation; a protocol change bumps `SUPERVISOR_PROTOCOL_VERSION` and `PROTOCOL_VERSION` together, and so does the host coming to run something new in the image. Across versions:

- An image older than v3 lacks the `cogmo_skills_runtime.abi` module the dependency scripts run, so the handshake refuses it when the worker is created, before a populate can fail on it. The deps reaper starts no supervisor: against such an image its script fails with `No module named cogmo_skills_runtime.abi`, and it deletes nothing.
- A newer image under a host that predates the handshake runs, since that host checks no version, but every task that calls `ctx` fails with `host_protocol_mismatch`: the host answers without a `taskId`, and the relay fails the task rather than let each call stall until the wall clock.

A cached `:latest` from before the host's release needs a `docker pull`.

### Host-side worker lifecycle `[confirmed]`

Each worker channel, in both tiers, is one pure state machine (`src/skills/worker-state.ts`) with two entry points, each returning the next state and the effects to carry out — send a frame, serve a ctx call, settle a task, report the handshake, die, become disposable, log. `command(state, cmd)` takes a host command (acquire, release, invoke) and returns a `Result`: a state that does not allow the command refuses it with a reason, and stays as it was. `observe(state, fact)` takes a fact — a worker frame, a ctx reply ready to send, a deadline, the channel ending or a send failing, the host closing it — and never refuses one. The `Dispatcher` is its shell: it feeds both, and executes the effects.

| State | Meaning |
|-|-|
| `starting` | Awaiting the handshake: the worker's first frame, judged per tier (`supervisor_ready` at `SUPERVISOR_PROTOCOL_VERSION` for tier 2, `ready` for tier 1). |
| `idle` | Ready and free. Only `idle` can be acquired. |
| `leased` | Held for one task: through a venv populate before its `task_invoke`, and after its exit until its holder releases it. Only `leased` runs a task; a `dead` worker fails one as a value (`worker is dead: <reason>`). |
| `running` | The task is on the worker. The only state that serves ctx calls, and only those naming the task. |
| `awaiting_exit` | The task returned its result; its processes may still be alive. Only its own `task_exited` moves it back to `leased`. |
| `dead` | Final. Entered when the handshake is refused or times out, the message stream ends or fails, a send fails, the task's deadline passes, a `task_result` or `task_exited` names another task, or the host closes the channel. A worker that dies while its caller holds it stays held until that caller releases it; only then is it disposable. |

- A transport exposes the worker's frames as `messages(): AsyncIterable<WorkerFrame>`: each a validated worker message, or a malformed frame, which the handshake refuses and a live worker logs and ignores. The stream ending or failing is the worker going away. Tier 2 reads NDJSON from the supervisor's stdout. Tier 1 reads the thread's `MessagePort`; its stream fails when the thread errors or exits, and yields a `task_exited` after each `task_result`, since the thread never outlives its one task.
- `invoke()` resolves the task's outcome: its result, or why it has none, and its exit (`confirmed`, or `unconfirmed` with a reason). A result delivered before the worker died is kept; the worker is reusable only on a confirmed exit.
- The handshake timeout and the task deadline (wall clock plus a grace) are `AbortSignal`s that feed events in; a deadline for a task already settled is ignored.
- `dead` resolves with who ended the worker: `host` when the host closed its channel, `worker` for everything else — the channel ending or failing, a refused or missed handshake, a passed deadline, a frame naming another task.

### Pool lifecycle `[confirmed]`

The pool's bookkeeping is a second pure state machine (`src/skills/worker-sysbox/pool-state.ts`) over `{ phase, workers, spawning, queue, earlyDeaths, spawnFailed }`, each worker `idle`, `leased`, `refused` (it refused a grant; its `died` is on the way) or `dead` as the pool last heard. `transition(state, event)` returns the next state and the effects to carry out — spawn, grant, reject, retire, release, tear down, log — and `SysboxWorkerPool` is its shell.

| Event | From |
|-|-|
| `boot`, `booted` | `create()`, before its `min` spawns and once they land |
| `acquire` | `invoke()` |
| `spawned`, `spawn_failed` | a spawn settling |
| `grant_refused` | a worker refusing a grant: it died before the pool heard |
| `died`, `disposable` | a worker's `dead` (with its cause and age) and `disposable` |
| `task_returned` | a task giving its worker back: alive (task count and age), dead, or `invoke` threw |
| `sweep` | the interval, with each worker's idle time |
| `dispose` | `dispose()` |

- `boot` spawns `min` workers, and the pool stays `booting` until `booted`: nothing reconciles, and a spawn that fails fails `create()`, which disposes the pool. Boot creates exactly `min` containers.
- Every transition ends in `reconcile`, which reads only the state: it grants idle workers to the oldest waiters, then spawns for every waiter and every worker still short of `min` — a waiter's worker counts toward `min` once granted — less the spawns under way, room permitting. Whichever event queued it, a waiter has something to wait on: a spawn under way or a full pool, or, while the crash-loop cap holds, a busy worker, a probe under way, or the death of a probe that refused its grant.
- The worker stays authoritative for leases: the shell grants with `tryAcquire`, and a refusal comes back as `grant_refused`, which marks the worker `refused` and puts the waiter back at the head of the queue.
- A dead worker counts toward `max` until it is disposable — at once, or once the task holding it returns — and its container is then torn down. A container tearing down does not count, so while teardowns run the sandbox can hold more than `max`.
- A task that returns with its worker alive clears the early deaths, and the worker is retired first at `recycleAfterTasks` or `recycleAfterMs`. A worker whose `invoke` threw is retired.
- A failed spawn fails the oldest waiter, and `reconcile` spawns for the next; while the crash-loop cap holds, a waiter behind a busy worker waits for it instead. Until a spawn succeeds, a worker dies or the sweep runs, only waiters spawn, so a sandbox that fails every spawn is not retried for `min` in a loop.
- A death is early when the worker died on its own (`worker`, not `host`), never leased, within a minute of its handshake. After three early deaths in a row, a dead worker is not replaced at once. A waiter waits for a busy worker; with none, the queue probes one spawn at a time, once any refused probe's death is heard. The head waiter takes the probe: one that lives serves it, one that dies early fails it, and the next waiter probes again. The sweep spawns one worker toward `min` when nothing is spawning. Whatever `min` is, an acquire after the fault clears is served without a sweep or a restart.
- The sweep retires idle workers above `min` that have sat past `idleShutdownMs`.
- `dispose()` aborts the signal every worker was created with — a live worker's channel closes, a spawn stops at its next step — rejects every waiter, and tears down every worker, held ones included. A worker that spawns afterwards is torn down; `dispose()` returns once no spawn or teardown is left.
- A rejected waiter's task fails as a value: `invoke` returns `ok: false` naming the rejection, and the runner finishes the run as an error rather than leaving its row in flight.

### State reset between tasks `[confirmed]`

Between tasks, "state" means Python module-level globals, library internals (connection pools, engine caches), `sys.modules` entries, monkey-patches, open file handles, background threads, and processes. Any of this leaking from task 1 into task 2 is a correctness or security bug. So is a task still running when the next one starts: it could call `ctx` under the next task's identity, read the next task's input, or forge its result.

**Shipped: pre-fork supervisor, a relay per task, and a process-tree kill before release.** Each task runs in fresh processes forked from the supervisor's `sys.modules` snapshot (~ms COW forks from a parent that has already imported the runtime), so module-level state, monkey-patches, threads and open fds cannot leak between tasks. Per task:

```
supervisor   subreaper, non-dumpable; holds the host channel, never reads it
  └─ relay   reads the host channel for one task
       └─ task process   runs the skill; stdin/stdout are private pipes to the relay
```

- The relay forks the task process before reading anything from the host, so no process that runs skill code ever holds the host channel or inherits host data read for another task. The supervisor never reads host input, so its heap — the image every later fork starts from — holds no task's inputs or ctx traffic.
- The relay forwards the task's `ctx_call`s stamped with the task id, delivers only `ctx_result`s carrying that id, forwards one `task_result` with the id overwritten, and then stops relaying. It enforces the wall clock. A `ctx_result` with no `taskId` fails the task with `host_protocol_mismatch`. The runner's `ctx` also raises once the result is emitted.
- When the relay exits, the supervisor SIGKILLs every process in its subtree and reaps them, repeating until the subtree is empty. `PR_SET_CHILD_SUBREAPER` makes orphans reparent to the supervisor, so a double-forked, re-sessioned or daemonised process is still found. Only then does it send `task_exited`; if the subtree won't empty within 2 s it exits, the host sees the channel close, and the worker is discarded.
- As soon as it sends `task_exited`, the supervisor forks the next relay, and the relay its task process; both wait for the next `task_invoke`. The supervisor runs a GC pass before each fork: the task process closes every inherited fd and reuses the numbers, so inherited garbage owning an fd would otherwise close one of the task's when finalized.
- The supervisor and relay are non-dumpable (`PR_SET_DUMPABLE` 0): a task running as the same uid cannot open their host fds through `/proc/<pid>/fd` or ptrace them. It can still signal them; killing either fails its own task (`task_exited_without_result`) or the worker (channel closes), never another task. Task processes start a new session, so `kill(0, …)` stays inside the task, and run with `PR_SET_NO_NEW_PRIVS`.
- Task stderr is the supervisor's, deliberately: a write-only log pipe the host never parses for protocol frames.
- The supervisor starts isolated, `python3 -I -u -m cogmo_skills_runtime` (`SUPERVISOR_CMD`). It runs in `$HOME`, which every task on the worker can write, and `-m` alone puts the cwd first on `sys.path` of the supervisor and every task forked from it, so a `csv.py` one task left there would run inside a later task that imports `csv`. `-I` also ignores `PYTHON*` variables (`-u` stands in for the image's `PYTHONUNBUFFERED`); user site is already off in the runtime venv. The dependency scripts the host runs on a worker start from `/` with uv's config discovery off ([Populate](#populate)).

Bounded container drift via the pool's `recycleAfterTasks` / `recycleAfterMs`. Wall-clock expiry kills the task's processes; the supervisor stays alive and the worker stays reusable.

Not covered: successive tasks on a worker share the container filesystem (`/tmp`, `$HOME`, the writable `/skill-venvs` cache). A later task can read what an earlier one left in `$HOME`, though it reaches neither the later task's imports nor a populate's uv configuration. Nor does the sweep reach a process outside the supervisor's subtree, the container's `sleep` init; that leans on the host's Yama `ptrace_scope` ≥ 1 to keep a task from injecting into it.

**Why not subinterpreters (PEP 734).** NumPy and pandas do not support `Py_mod_multiple_interpreters` ([numpy/numpy#24755](https://github.com/numpy/numpy/issues/24755)), cross-interpreter asyncio needs a hand-rolled bridge, and nothing runs them in production; at ~50 ms per task against a few ms here they buy no latency. Revisited when NumPy supports them and the stdlib has an async-aware cross-interpreter queue.

**Why not recycle every task.** A container per task adds a clean filesystem, at a 1–2 s container start per invocation, the latency the pool exists to remove; the relay and the process-tree kill cost a few ms per task.

**Why not `multiprocessing` or `pebble`.** `BaseProcess._bootstrap()` closes stdin in every child whatever the start method, and neither kills a task's descendants or keeps the host channel from the task, the two properties the relay exists for. The supervisor is stdlib-only Unix code (`os.fork`, `os.pidfd_open`, `selectors`, `prctl` through `ctypes`). Logical reset (`importlib.reload` and clearing globals) misses library state and monkey-patches.

**Per-skill opt-out.** `isolation: recycle` in `SKILL.md` retires the worker after the task and the pool replaces it, so the next task starts in a fresh container, filesystem included: for a skill that leaves files the next task must not see. The default, `subinterpreter`, is process-per-task on a reusable worker; the name is reserved for a runtime that uses PEP 734.

### Sizing `[confirmed]`

`DEFAULT_POOL_OPTIONS` in `src/skills/worker-sysbox/pool.ts`, and the env values boot passes over them:

| Parameter | Default | Env override | Notes |
|-|-|-|-|
| `min` (always warm) | `0` | `COGMO_SKILLS_POOL_MIN` | The env default; boot passes it over `DEFAULT_POOL_OPTIONS.min`, which is 1. Workers exist only around active or recent tasks, so the first invocation after an idle period pays the 1–2 s cold start. `1` keeps one worker always running for ~300 ms interactive latency. |
| `max` (hard cap) | `3` | — | Personal scale — concurrent skill invocations rarely exceed. |
| Spawn-on-demand | up to `max` | — | When no idle worker is free, spawn one up to `max` rather than queuing. Personal-scale latency wins over backpressure economy. |
| `recycleAfterTasks` | 500 tasks | — | Bounds container drift (tmpfs, log accumulation, allocator fragmentation). |
| `recycleAfterMs` | 24 h | — | Wall-clock ceiling — catches workers that ran few tasks but sat warm forever. |
| `idleShutdownMs` | 30 min | `COGMO_SKILLS_POOL_IDLE_SHUTDOWN_MS` | Idle workers above `min` are retired; with `min = 0` the pool drops to no workers. |
| `idleSweepIntervalMs` | 1 min | — | Sweep cadence. |

**Lazy pool init.** The pool itself isn't constructed until the first tier-2 invocation — `cogmo serve` boots without spinning anything up on the configured sandbox. Concurrent first-callers share one in-flight construction; an init failure clears the in-flight reference so the next invocation retries. This keeps an unreachable sandbox from failing boot for deployments that may never invoke a tier-2 skill. `SkillRunnerImpl.shutdown()` waits for a construction in flight, disposes the pool, and refuses any tier-2 invoke after it; `cogmo serve` calls it on exit, before the sandbox shuts down ([infrastructure.md → Shutdown](infrastructure.md#shutdown-confirmed)).

Starting values; revisit with usage data. Skills that declare `resources.{cpu_shares,memory_mb}` overrides bypass the pool — they get a fresh, per-skill-resource-budget container, paying the cold-start every invoke. Most skills don't override and ride the warm path.

### Tier 1 pool `[proposed]`

WASM workers are not pooled today: each invocation spawns a fresh worker thread and boots Pyodide, about 5 s. The pool is pre-booted single-use children, specified with the boundary they run in ([Tier-1 boundary](#tier-1-boundary-proposed) → Pool).

## Skill storage `[confirmed]`

Skills live in git. Versioned, diffable, auditable — necessary for self-evolution rollback and audit.

### Repo location

**Local bare repo + synchronized remote, user-owned.** Shape:

```text
$COGMO_SKILLS_PATH/                # default /var/lib/cogmo/skills (configurable)
  HEAD                             # symbolic-ref → refs/heads/main
  hooks/
  objects/
  refs/                            # bare repo — no working tree
```

- Path configured via env var or `settings.local.json`.
- Cogmo initializes the bare repo on first boot if the path doesn't exist; `HEAD = refs/heads/main` and the `pre-receive` hook are reconciled on every boot so upgrades take effect. The callers that can create it, boot and the setup wizard, hold the bootstrap lock ([setup.md → Concurrent runs](setup.md#concurrent-runs)): two first-time `git init --bare` on one path can fail on git's config lock. Reconciling the hook is safe concurrently: each call writes its own temp file and renames it into place.
- **A remote is required.** Any user-owned git URL (private GitHub repo, self-hosted Gitea, Forgejo, etc.) works — Cogmo treats `coding_repos.remote_url` as opaque transport material. Setup collects the URL via one of three operator choices:
  - **Use my own remote** — operator pastes a pre-created URL they've granted Cogmo's credentials access to. Validated via `git ls-remote` before persisting.
  - **Auto-provision on GitHub** — Cogmo calls `octokit.repos.createForAuthenticatedUser({ name: "cogmo-skills", private: true, auto_init: true })` and attaches the result as origin. Only available when a GitHub identity is already configured; gated to that one provider because the convenience lives in the wizard only — no permanent provider-specific surface.
  - **Skip** — defer configuration. `delegate_coding({ repo: "skills" })` fails with a clear message until the standalone `cogmo migrate-skills-remote` CLI is run.
- The local bare repo is **authoritative** for `register` (`update-ref` writes happen here, atomically). The remote is a synchronized mirror — every successful `register` immediately pushes the new `main` SHA to the remote, so a Daytona sandbox cloning from the remote always sees the latest skill set within the latency of one push. The push gives up after 60 s, or when the caller's signal aborts; a failed push leaves the remote behind until the next one succeeds.
- Coding delegation operates on this repo exactly like it operates on user-registered repos — feature-branch flow over the same [sandbox.md](sandbox.md) + [coding-delegation.md](coding-delegation.md) infrastructure. The skills repo's only specialness is the post-`register` push-to-remote step.

**Why local-authoritative.** Filesystem `update-ref` is atomic and needs no forge client; routing `register` through a provider API (`octokit.git.updateRef` or its Gitea twin) would couple the one operation that must stay crisp to per-forge clients. A failed push degrades to "live locally, remote behind": the database and the bare repo agree, and the next push reconciles. The remote exists for off-host backup of the skill library, at the cost of one URL in setup. Past setup every path is plain `git`, with credentials from the askpass helper; the provider-specific surfaces are the wizard's GitHub auto-provision and the PR opener ([coding-delegation.md](coding-delegation.md) → Merge gate), which knows only GitHub, so another forge gets the pushed branch and the operator opens the PR.

**Where it does not live.** Not in the Cogmo repo: skills are per-deployment, and a fork would conflict on upstream pulls, leak private workflows through a misconfigured remote and tie release cadences together. Not in one shared repo: each operator owns a private `cogmo-skills`. Not behind a git server in Cogmo: deploys go through `register`, so there is no PR UI to build, and operators bring their own forge. No base skills ship with Cogmo: the agent authors what it needs, and a pattern worth shipping would move to a `base-skills/` directory in the Cogmo repo.

### Repo invariants

Hard rules enforced on the skills repo:

- **`main` is advanced only by Cogmo** — its `register` RPC, and the commits it makes at boot under the bootstrap lock (the toolchain commit, [Verify stage](#verify-stage), and the one-time layout commit, [Per-skill structure](#per-skill-structure)), which deploy no skill. Direct pushes to `main` from any other source (agent, human, tool, CI) are rejected unconditionally. Agents work on feature branches; the orchestrator is the sole merger. So "present on `main`" means "classified and live" once every deploy transaction has committed or been reconciled. Two [Deploy lifecycle](#deploy-lifecycle-confirmed) failure modes break it until then: `update-ref` landing before a commit that fails, which can leave a denied deploy's commit on `main` until the operator rewinds it, and a rollback past another skill's later deploy, which takes that skill's commits off `main` while it stays live.

  **Primary enforcement: remote-side branch protection.** The operator configures `main` protection on the remote (GitHub branch protection rule; Gitea/Forgejo equivalent). The agent's sandbox-side pushes target feature branches (`cogmo/<idShort>`), so they never attempt `main`; Cogmo's `register`-side push uses an authenticated identity with bypass so the legitimate path still works.

  **Secondary enforcement: bare-repo `pre-receive` hook.** Installed by `bootstrapSkillsRepo` against direct `git push <bare-repo>` from a misconfigured CI script or operator typo. In normal operation the hook is bypassed — `register` uses filesystem `update-ref`, and `fetchFeatureBranch` uses `git fetch` (write-side ref update with no `receive-pack`). The hook is defense-in-depth, not the primary gate.

  `register` is a two-leg operation: `git update-ref refs/heads/main <sha>` on the bare repo's filesystem, then `git push origin <sha>:refs/heads/main` to the remote. Push failure surfaces to the operator and leaves the local advance in place; the next `register` (or a manual push) reconciles. The filesystem-write path is the sole merge mechanism and is available only to Cogmo.

- **No history rewrite under a deployed sha.** `skill_deploys.git_sha` names specific commits; a rewrite would leave them dangling and the live skill uninvocable. Enforced by:
  - the bare repo's `pre-receive` hook, which refuses a non-fast-forward update of any branch pushed to it;
  - branch protection on the remote's `main` (GitHub "do not allow force pushes", or the Gitea/Forgejo equivalent), which the operator configures, with Cogmo's identity allowed to bypass it for `register`'s push and the rollback mirror's `--force-with-lease`.

  Nothing intercepts git commands in a coding sandbox. Coding delegation force-pushes only per-task refs (`cogmo/run/<taskId>` from the host, `refs/cogmo-wip/<taskId>` from the salvage), which no deploy row names.

- **Append-only branches.** Every deploy is a commit added to a feature branch, then merged fast-forward into `main` by `register`. Today `[confirmed]` a rollback rewinds `main` to a prior SHA, mirrored with `--force-with-lease`; the forward-commit rollback (Deploy lifecycle) `[proposed]` makes every move of `main` a fast-forward.

- **Signed commits (optional)** `[proposed]`, unbuilt. If the user configures commit signing, Cogmo verifies signatures on `register` and refuses unsigned commits.

### Per-skill structure

Follows the Anthropic SKILL.md standard for progressive disclosure (see [integrations.md](integrations.md)):

```text
skills/
  summarize-email/
    SKILL.md             — name, description, when-to-use (retrieval key)
    skill.py             — entrypoint
    requirements.lock    — `uv pip compile`-generated, hash-pinned; see Dependencies → Lockfile
    test_skill.py        — a test per spec example; the verify stage runs it
  check-spending/
    SKILL.md
    skill.py
    ...
```

Today `[confirmed]` register reads `SKILL.md`, `skill.py` and `requirements.lock` at the repo root, one skill per branch. A directory per skill on `main`, as above, is `[proposed]`: it lets drafts of different skills merge `main` cleanly and makes rollback a forward commit.

**Moving to it.** `migrateSkillsLayout`, a bootstrap step after the skills repo is initialized, runs under the bootstrap lock and makes one layout commit:

- It copies the files of every `skills` row whose `git_sha` is on `main` (`main` itself or an ancestor), disabled ones included, read at that sha from the repo root, to `skills/<name>/`, and deletes the root skill files in the same commit. A pending, denied or blocked first deploy's sha is not on `main`, so its files are not copied: its row keeps that sha, which reads from the repo root, a pending one meets `non_fast_forward_at_approve_time` (below), and a later draft of the name starts from `main` without the code.
- It advances `main` and records the commit in one transaction: it inserts the `skills_repo_layout` row with the commit's sha, runs `update-ref main` with compare-and-swap inside the transaction (as register's `applyFilesystem` does), then commits. The commit carries a `Cogmo-Layout: v1` trailer.
- When the compare-and-swap loses to a concurrent register, the transaction rolls back; it re-reads the `skills` rows and `main`, rebuilds the commit and retries under the lock.
- Every transaction attempt starts with the recovery check: it reads the row and, finding none, looks for the layout commit on `main`'s first-parent history; if one is there, it records it instead of making a second. A boot that finds the row does nothing. On the transactor's `40001` retry the check is defensive: REPEATABLE READ raises `40001` at a statement, and the row insert precedes `update-ref`, so a retry never follows a completed `update-ref`. What does follow one is a failed commit or a crash, and the next boot's check recovers both.
- The layout commit is the oldest first-parent commit that carries the `Cogmo-Layout: v1` trailer, is committed under Cogmo's own committer identity (`Cogmo <skills@cogmo.invalid>`, which every host-side commit carries: the layout, toolchain and forward-rollback commits), and has a tree with no skill files at the root and a `skills/<name>/` directory for each `skills` row whose `git_sha` is that commit or an ancestor of it. Register fast-forwards author commits onto `main`, so it refuses, as `layout_violation`, a tip whose commits not yet on `main` carry that identity or the trailer; a commit failing the identity or tree check is skipped.

| Failure mode | State left | Why it is safe, or the residual |
|-|-|-|
| Crash before the advance | no row; `main` unmoved; the commit object unreachable | the next boot starts over; git collects the object |
| Crash after `update-ref`, or the transaction failing to commit after it | `main` at the layout commit; no row | the next boot finds the layout commit on `main` and records it, so no second layout commit is made |
| Compare-and-swap lost to a concurrent register | nothing committed | retried from fresh reads of `skills` and `main`, so the skill that just deployed is copied too |
| A register committing after the layout commit, from a branch cut before it | that register rejected | `non_fast_forward`, and its notification says to register again |
| Second boot, or two boots at once | one row | the bootstrap lock serializes them; the second finds the row |

`skills.git_sha` is unchanged. The runner and register read a sha's files from `skills/<name>/` when the recorded layout commit is an ancestor of the sha (or the sha itself), and from the repo root otherwise. A forward rollback to a target from before the move restores `skills/<name>/` from that target's root files. A deploy pending across the move, or a branch cut before it, meets `non_fast_forward` (at approve or at register), and its notification says to register it again. A tip that descends from the layout commit but adds or keeps skill files at the repo root is rejected as `layout_violation`, so the dual-path read cannot silently ignore them.

### SKILL.md schema `[confirmed]`

`SkillManifestSchema` in `src/skills/types.ts` is the one definition of the frontmatter, and `parseManifest` (`src/skills/manifest.ts`) strips the YAML block and validates it, so every consumer reads the same parsed manifest: register, the classifier, invoke (`inputs` through ajv, `resources` for the container's limits), the tool builder (`description`, `inputs`) and the dependency populator (`dependencies`). It is a superset of Anthropic's SKILL.md: a file with only `name` and `description` fails for want of `tier` and `inputs`, but the fields it has mean the same, and an Anthropic loader ignores the rest. `inputs` must be an object schema, since tool-call APIs take only objects; `isolation` applies to tier 2 and is dropped from a tier-1 manifest.

**Example (full):**

```yaml
---
# Identity — required
name: send-morning-digest
description: >
  Send a one-paragraph summary of the user's unread email to their morning
  Telegram chat. Skips if inbox is empty. Runs daily at 09:00 local.

# Execution — required
tier: container                    # wasm | container
isolation: subinterpreter          # tier 2 only: subinterpreter (default) | recycle

# Invocation — optional, all absent = manual-only
triggers: [manual, cron]
schedule: "0 9 * * *"              # required if 'cron' in triggers

# Contract — inputs required (an object schema); outputs optional
inputs:
  type: object
  properties:
    since: { type: string, format: date-time }
  required: []
outputs:
  type: object
  properties:
    summary: { type: string }
    count: { type: integer }

# Dependencies — optional; absent = stdlib only. See Dependencies → Declaration.
# Strict name==version form. No ranges, no extras, no URLs, no path specifiers.
dependencies:
  - httpx==0.27.0
  - google-api-python-client==2.108.0

# Permissions & effects — optional but drive risk classification
effects:
  - reads_user_data
  - sends_message
secrets:
  - name: telegram_bot_token
    binding:                       # host-side substitution, stage 2
      destination: "https://api.telegram.org/*"
      substitute: "header:Authorization: Bot {{value}}"
  - name: gmail_oauth
    binding:
      destination: "https://gmail.googleapis.com/*"

# Egress allowlist — absent means no network. See Secret exposure and egress control.
network:
  allow:
    - api.telegram.org
    - gmail.googleapis.com

# Resource caps — optional; defaults apply if absent
resources:
  memory_mb: 512
  wall_clock_s: 60
  cpu_shares: 1

# Cost — optional
cost_per_call_usd: 0.001           # declared external cost per invocation
budget:
  daily_usd: 0.50
  monthly_usd: 10.00
  per_invocation_usd_cap: 0.05
---

# Send Morning Digest

## When to use

Only triggered automatically at 09:00. Manual runs for testing — e.g. after
changing the summarization prompt.

## Inputs

`since` — optional ISO-8601 timestamp. If present, only emails newer than this
are considered. Default: 24 hours ago.

## Behavior

1. Pulls unread emails from Gmail since the cutoff.
2. Summarizes via `ctx.llm.complete` using a short, factual prompt.
3. Sends a single Telegram message. No-op if no unread emails.
```

**Changes `[proposed]`:**

- `inputs` and `outputs` leave the frontmatter: register generates them from `skill.py`'s pydantic `Input` and `Output` ([Contracts](#contracts-proposed)). A skill with no `Input` model keeps frontmatter `inputs`.
- A secret's `binding` names its `location` (`header`, the default, or `query`) in place of `substitute`, and may carry `exchange: oauth_refresh` ([Egress proxy](#egress-proxy-proposed) → Substitution). A `substitute: "header:<template>"` parses as `location: header` with that template; a `substitute: url` binding keeps parsing and is not substituted. Until the proxy substitutes, every binding is parsed and ignored.

## Risk tiering & auto-apply `[confirmed]`

Each deploy is classified, from the manifest and a static-analysis pass, into a tier that decides whether Cogmo merges silently, merges and notifies, or waits for an approval tap. This section is what `computeRiskTier` does today; [Risk tiers without a human](#risk-tiers-without-a-human) replaces it once reviewers stand in for the tap.

### Tiers

| Tier | Matches when | Action |
|-|-|-|
| **Auto** | Everything not matched below: tier `wasm`, no declared or detected effect, no `network:` block, at most two secrets of any kind, every dependency on the allowlist | `register` fast-forwards `main` to the branch tip immediately on classification. Skill is live. No notification. |
| **Notify** | A dependency on neither list, OR any other declared or detected effect (`reads_memory`, `writes_memory`, `reads_user_data`, `writes_user_data`, `reads_filesystem`), OR a `network:` block without secrets | `register` fast-forwards `main` to the branch tip immediately on classification. No notification is sent today; [Notifications and undo](#notifications-and-undo) specifies one. |
| **Approve** | First match: validation errors; a dependency on the approve list; an effect in `APPROVE_GATING_EFFECTS` (`deletes_external`, `sends_email`, `sends_message`, `posts_public`, `financial`, `spawns_subprocess`, `writes_filesystem`); tier `container`; **any secret together with a `network:` block**; three or more secrets | `register` leaves `main` untouched; the branch stays as-is. Through `register_skill`, Telegram gets an approval prompt with the name, declared effects, schedule and short sha, and approve/deny buttons; the auto-register path posts nothing. `main` is fast-forwarded only when `approveDeploy` fires. |

Secrets-plus-network is its own `approve` trigger rather than a count, because the count answers "how broad are this skill's permissions" while the pairing answers "can this skill read a credential and also reach somewhere to send it". `APPROVE_SECRETS_THRESHOLD` stays as the breadth signal for skills with no egress.

**Tier 1 capped at `notify`** `[proposed]` (todo.md → Skills autonomy S1). While `tier1Hardened` is unset, the table returns `notify` where it would return `auto`: an unhardened tier-1 skill holds the server's environment ([Tier-1 boundary](#tier-1-boundary-proposed)), so none deploys without a notification. Tier 1 is the only tier the table promotes to `auto`, so no deploy is `auto` under the cap. Setting `tier1Hardened` lifts it, and `auto` returns only once `reviewPanel` is set too: without a panel, [Risk tiers without a human](#risk-tiers-without-a-human) caps `auto` at `notify`.

### Classifier

The classifier is deterministic and takes:

- **Declared effects** from `SKILL.md` frontmatter.
- **Declared secrets** + their destination bindings.
- **Execution tier** (WASM vs container).
- **Static analysis pass** — walks the Python AST for imports + call patterns the manifest didn't declare: imports of `subprocess` / `smtplib` / `stripe` / etc., calls to `os.remove` / `subprocess.run` / `open(..., "w")`, etc. Any undeclared match → `validation_errors` populated and the deploy is rejected; the author (agent or human) must declare the effect to proceed.

Output: one of `auto` / `notify` / `approve`. Recorded in the `skills.risk_tier` column and in the `skill_deploys` audit log.

#### Implementation

Static analysis runs on [tree-sitter](https://tree-sitter.github.io/)'s WASM build (`web-tree-sitter`, with `vendor/tree-sitter-python/tree-sitter-python.wasm`), which needs no native build step. Loading the parser takes tens of ms; parsing a skill file, single-digit ms.

Detection rules live in `src/skills/ast-rules.ts` as pure data — two tables (`IMPORT_RULES` mapping top-level packages → effect, `CALL_RULES` mapping `(object?, attr)` patterns → effect with optional positional-arg predicates like `open_write_mode`). Adding a rule is one row; the walker in `src/skills/ast-classifier.ts` doesn't change.

**Threat model: a drift catcher, not a boundary.** A body can call `getattr(__import__("os"), "system")(...)`, alias a module, or use an SDK no rule covers, and pass. Lint keeps `effects:` tracking what the body visibly does, so an undeclared effect surfaces at register. It is not hardened against an adversarial author and does not make `auto` safe: that rests on the verify gates and the review panel ([Risk tiers without a human](#risk-tiers-without-a-human)), with the tier's isolation and the egress allowlist as the boundaries.

**Failure mode.** A throw from the AST path (parser load failure, walk panic, unexpected node shape) is caught at the `classifier.ts` boundary and falls back to the declaration-only `classifyManifestStub`, whose `classifier_version`, `stub-2-effect-aware` in place of `ast-1`, marks the degradation in the audit log. The stub never returns `auto`, since only the AST path can show a body is read-only. Its `approve` predicates are the AST path's (tier `container`, an approve-gating effect, an approve-list dependency, three or more secrets, any secret with a `network:` block), so it returns `approve` or `notify`, and the deploy completes. A null parse tree takes the declarations-only path instead, which can return `auto`; the planned verify stage's syntax gate rejects such a file before register.

### Where the classifier runs

**Branch + register RPC.** Commits land on a feature branch; Cogmo's `register` RPC is the only path that advances `main`. Cogmo does not watch or poll the repo.

```bash
# Agent / user workflow
git checkout -b skill/summarize-email-<date>
# ... edit skill ...
git add . && git commit -m "..."                           # commits on the branch; NOT live
cogmo skills register --branch skill/summarize-email-<date>
# → classifier + merge into main (auto/notify) or pending approval (approve)
```

The `register` RPC, in the order its checks run:

1. **Lock.** Inside the deploy transaction, `pg_advisory_xact_lock(hashtext("skill_register:" + name))` queues registers of one name. Under REPEATABLE READ it does not refresh the queued transaction's snapshot, so the in-transaction checks of steps 2, 6 and 7 can read state from before the winner's commit ([store-pattern rule](../.agents/rules/store-pattern.md); the advisory-lock audit in `todo.md`).
2. **Base** `[proposed]`, for a draft's register only: `skills.git_sha` must equal the draft's `base_git_sha`, and for a create (a null base) the name must not have gone live (no `live` or `rolled_back` row), else `base_moved`, and the draft ends, spending no round. Read before the transaction, ahead of step 3, and re-read in it beside steps 6 and 7, so a base a rollback or a CLI register moved is reported as `base_moved`, never as the `non_fast_forward` that would spend a round.
3. **Fast-forward.** Before the transaction, `main` must be an ancestor of the branch tip, else `non_fast_forward`: the author merges `main` into the branch and registers again. `applyFilesystem` re-reads `main` just before `update-ref`, since the lock is per name and `main` is shared, and the compare-and-swap catches a move after that re-read; either rolls the transaction back with the same rejection. `approveDeploy` does the same (`non_fast_forward_at_approve_time`); `rollback` requires `main` unchanged since its pre-transaction read, so it never rewinds past a deploy that landed meanwhile (`main_moved`).
4. **Read and classify**, before the transaction: `SKILL.md` and `skill.py` at the tip, the manifest against `SkillManifestSchema`, its `inputs` and `outputs` compiled by ajv, tier 1's `wasm-lint`, then the classifier, whose undeclared effects reject.
5. **Lockfile**, before the transaction: with dependencies declared, the committed `requirements.lock` must byte-equal a fresh `uv pip compile --generate-hashes --no-header` run in a short-lived sandbox session, destroyed whatever the outcome ([Lockfile](#lockfile)); tier 1 then checks the locked packages against Pyodide (`pyodide-compat.ts`).
6. **No-op**, in the transaction: a tip equal to `skills.git_sha` returns `no_op` and writes nothing.
7. **Pending**, in the transaction: a `pending_approval` row for the skill returns `pending_deploy_exists`.
8. **Writes** by tier, as the [Deploy lifecycle](#deploy-lifecycle-confirmed) table states; a rejection from steps 2–7 persists nothing. For an `approve`-tier deploy through `register_skill`, the Telegram prompt follows the commit. The result returns synchronously.

`SkillRunner` (`src/skills/runner.ts`) is the public interface: `register`, `approveDeploy`, `denyDeploy`, `rollback`, `deregister`, `enable`, `list`, `listAll` and `invoke`. Each call that can put a schedule live takes a `SkillDeployOrigin` (`src/skills/deploy/origin.ts`), which decides who the schedule runs as ([Run-as identity](#run-as-identity-confirmed)); `register`'s `signal` cancels the deploy until its transaction starts. The results:

```typescript
// Each variant also carries name, riskTier and gitSha.
type RegisterResult =
  | { status: "live" }                                              // gitSha: main's new tip
  | { status: "pending_approval"; pendingId: string; schedule?: string }  // gitSha: branch tip
  | { status: "no_op" }
  | { status: "rejected"; errors: readonly string[] };              // nothing written; the [proposed] `blocked` rejection writes its deploy row

// [proposed]: `rejected` carries a sealed union in place of `errors`.
//   | { status: "rejected"; rejection: RegisterRejection }
type RegisterRejection =
  // terminal for this tip: the author, or the owner, must change something
  | { kind: "manifest_invalid"; issues: readonly string[] }
  | { kind: "lint_failed"; findings: readonly SkillFinding[] }
  | { kind: "classifier_rejected"; undeclared: readonly SkillEffect[] }
  | { kind: "lockfile_invalid"; detail: string }
  | { kind: "tier1_incompatible_dependency"; packages: readonly string[] }
  | { kind: "spec_drift"; fields: readonly string[] }
  | { kind: "non_fast_forward"; at: "register" | "approve" }   // approve: non_fast_forward_at_approve_time
  | { kind: "layout_violation"; paths: readonly string[] }   // root skill files after the layout commit, or Cogmo's identity or layout trailer on an author's commit
  | { kind: "blocked"; reasons: readonly SkillRiskReason[] }   // writes the terminal `blocked` deploy row
  // approve and rollback
  | { kind: "deploy_not_found" } | { kind: "deploy_not_pending"; status: SkillDeployStatus }
  | { kind: "skill_not_found" } | { kind: "main_moved" }
  // pausing: nothing is wrong with the tip
  | { kind: "concurrent_first_deploy" }   // the first-deploy 23505 race, returned only after register's own single retry also loses
  | { kind: "pending_deploy_exists"; pendingId: string }   // at the tip: the tip's own deploy, which a draft settles from; elsewhere: the owner resolves it
  | { kind: "registrar_unavailable"; cause: "index" | "sandbox" }
  // ends the draft: the live version moved under it, and no change to the tip can fix that
  | { kind: "base_moved"; liveGitSha: string | null };   // a draft's register only: `skills.git_sha` is not the draft's `base_git_sha`, or, for a create, the name has gone live since; step 2, read before the fast-forward check and re-read in the deploy transaction; the draft ends, spending no round

// SkillRunResult, DeregisterResult, EnableResult and DenyDeployError are in
// src/skills/ (invoke/run-result.ts, deploy/activation.ts, deploy/deny.ts).

// Why `invoke` declined to run; nothing executed. A skill run that fails is
// not a rejection: it is a `SkillRunResult` with `status: "error"`.
type SkillInvokeRejection =
  | { kind: "not_found"; name: string }
  | { kind: "disabled"; name: string }
  | { kind: "invalid_inputs"; name: string; issues: readonly string[] }
  | { kind: "sandbox_unavailable"; name: string }
  | { kind: "inflight"; name: string; runId: string };  // see At-most-once invocation
```

<a id="first-deploy-race"></a>**The first-deploy race** `[proposed]`. Two first deploys of one name both insert a `skills` row, and the loser's insert raises `23505` on `skills.name`, which the transactor does not retry. Register maps it at the store edge and retries once, in-process, in a fresh transaction whose snapshot holds the winner's row, so the retry meets the skill as an edit: `no_op` when the winner deployed the same tip, `pending_deploy_exists` when it left a pending deploy, otherwise a normal register. Only a retry that loses again returns `concurrent_first_deploy`. Nothing is wrong with the tip, so the rejection is pausing: a draft parks at `blocked: registrar_unavailable` on it and spends no round ([Skill lifecycle](#skill-lifecycle)).

### Deploy lifecycle `[confirmed]`

The unit is a `skill_deploys` row, keyed by its id; its `status` is the `skill_deploy_status` enum. `live`, `denied` and `rolled_back` are terminal, and `live` means the deploy went live, not that it is current — the enable guard below reads it that way. While a deploy of an enabled skill is pending, its `skills` row keeps the skill's last live sha, so the live version stays live through the approval window. A first deploy has no live version: its `skills` row is inserted disabled at the pending or blocked tip and stays there if the deploy is denied or blocked, and the enable guard keeps that sha from going live without a review.

Activation is a second lifecycle this section does not model: `skills.disabled` together with whether a `live` row exists at the skill's current sha — a first deploy pending, denied or blocked (disabled, no live row), live (enabled), deregistered (disabled, live row), and the planned failure breaker — with `deregister`, `enable`, `approve` and `rollback` as its transitions. Naming it as its own state machine is a todo; until then it is an accepted residual, and the enable guard is its one explicit rule.

```
register (auto, notify) ──────────────────────────────▶ live
register (approve) ──▶ pending_approval ──approve──▶ live
                                        └──deny────▶ denied
rollback ─────────────────────────────────────────────▶ rolled_back   (a new row; the one it supersedes keeps `live`)
register (blocked tier) ──────────────────────────────▶ blocked       [proposed]: terminal, writes nothing else
```

Register, approve and rollback take the skill name's `pg_advisory_xact_lock` inside the transaction. It queues them; it does not refresh the snapshot the queued transaction reads ([store-pattern](../.agents/rules/store-pattern.md)), so it is not a guard and the table below does not count it as one. Every check a use case makes before `runDeployTx` — the pre-transaction reads of the base and fast-forward checks, steps 2 and 3 above — belongs to the use case and is not in the table; step 2's re-read inside the transaction is a guard of the `register` rows.

| Transition | Guard | Writes, in order, in one transaction | Outcome |
|-|-|-|-|
| `register` → `live` | no `pending_approval` row for the skill, read from the snapshot (stale under a concurrent register: failure modes); `[proposed]` a draft's register: base unchanged (step 2's re-read); `main` fast-forwards to the tip | upsert `skills` at the tip; insert the row `live`; `update-ref main`. After the commit, best-effort: delete the feature branch, then mirror | `live`, `no_op`, `rejected`; a moved `main` rolls back as `non_fast_forward` |
| `register` → `pending_approval` | no `pending_approval` row for the skill (snapshot); `[proposed]` a draft's register: base unchanged (step 2's re-read). `main` is not checked in the transaction: `applyFilesystem`, where it is re-read, runs only when the deploy goes live | insert `skills` disabled for a first deploy, else leave it; insert the row | `pending_approval` |
| `approve`: `pending_approval` → `live` | `UPDATE skill_deploys SET status = 'live' … WHERE id = $1 AND status = 'pending_approval'`, the transaction's first write; a pre-read of the row refuses one the snapshot already shows resolved before the lock is taken | the row (`approved_by`, `resolved_at`); then `skills` at the deploy's sha and manifest, `disabled = false`; then `update-ref main`. After the commit, best-effort: mirror | `live`; `rejected` with `deploy_not_found`, `skill_not_found`, or `deploy_not_pending: status is '<status>'`; a moved `main` rolls back as `non_fast_forward_at_approve_time` |
| `deny`: `pending_approval` → `denied` | `UPDATE … WHERE id = $1 AND status = 'pending_approval'`; a zero-row match re-reads the row | the row (`resolved_at`); `skills` and `main` untouched | `transitioned`; `not_found`; `not_pending` with the row's status |
| `register` → `blocked` `[proposed]` | the risk tier is `blocked` ([Risk tiers](#risk-tiers-without-a-human)); a draft's register: base unchanged (step 2's re-read) | for a first deploy, insert `skills` disabled at the tip (`awaiting_first_deploy`), as a pending first deploy does, since the row's `skill_id` needs it; else leave `skills` alone; insert the row `blocked`, terminal, its reasons in `classifier_log`; `main` untouched | `rejected` with the `blocked` rejection, the only rejection that writes a row |
| `rollback` → `rolled_back` | `main` unchanged since the pre-transaction read. The target is any commit whose manifest names the skill: no prior `live` row is required and nothing checks for a pending deploy — rollback is an owner-only CLI override of the approval gate (failure modes) | `skills` at the target sha; insert the row; `update-ref main` to the target, which rewinds past every commit after it, other skills' deploys included (failure modes). After the commit, best-effort: mirror with `--force-with-lease`. `[proposed]`: a forward commit on `main` that restores `skills/<name>/` to its content at the target, so `main` only fast-forwards, no other skill's deploy is touched, and the mirror is a plain push; `skills.git_sha` is the new commit, and the row records `restores_git_sha`: the target, or, when the target is itself a restoring commit whose row is `rolled_back`, that row's `restores_git_sha`, so the value always names a commit that had its own deploy | `live`, `no_op`, `rejected`; a moved `main` rolls back as `main_moved` |

Deny's outcomes are values its callers match exhaustively: `denyDeploy` returns `Result<void, DenyDeployError>`, `cogmo skills deny` exits 1 naming the miss, and a keyboard tap toasts `skill_deploy_not_found` or `skill_deploy_not_pending`. Nothing reports a resolution that did not happen. Approve and rollback carry a rejection as the `reason` string of `ExecuteRegisterResult`, which the use cases flatten into `RegisterResult.errors`: untyped, with no split between a failure that is terminal for the deploy (a manifest error) and one that only pauses it (PyPI unreachable during the lockfile compile), and the first-deploy `23505` race surfaces as a throw. `transport.skills.approveDeploy` recovers the two codes it can name by prefix and renders the rest as `skill_deploy_register_failed`. A residual, closed by the tagged rejection union in todo.md → Skills autonomy S10.

#### Per-state data `[confirmed]`

`resolved_at` and `approved_by` are per-state data, so two CHECKs tie them to `status` and no transition can leave a row between states.

| `status` | `resolved_at` | `approved_by` |
|-|-|-|
| `pending_approval` | null | null |
| `live` | set | the approver's identity when `approve` ran for a user, and the owner on an Override's `register` row; null when `approve` ran for the owner from the CLI, and on any other `register` row, which no human approved |
| `denied` | set | null |
| `rolled_back` | set | null |
| `blocked` `[proposed]` | set | null; an Override registers again, and that row carries the owner |

- `chk_skill_deploys_resolved_at_iff_terminal` (Data model): `resolved_at` is set iff the row is terminal.
- `chk_skill_deploys_approved_by_only_live`: an approver only on a `live` row. One direction only: a `live` row without an approver is a `register` other than an Override, or an owner-CLI `approve`.

Each is a single field — a timestamp, a foreign key — so it keeps its natural type under CHECK rather than moving into a per-state JSONB blob ([architecture-rules](../.agents/rules/architecture-rules.md)). The `skill_deploy_status` enum holds the four states above, and `blocked` once it lands `[proposed]`. `0077_skill_run_and_deploy_state_checks` rewrites the type without `approved` and adds the CHECKs of both tables; its failure modes are under [At-most-once invocation](#at-most-once-invocation-confirmed) → Per-state data and hold for this table too — every shipped writer (`executeRegister`, `executeApprove`, `denyPendingDeploy`, `executeRollback`) sets `resolved_at` with a terminal status and `approved_by` only with `live`. Deploy-specific:

| Failure mode | State left | Why it is safe, or the residual |
|-|-|-|
| a row holds `approved` when the migration runs | the cast to the rewritten type fails and the file rolls back whole | refused: no build has written `approved` |
| a deploy transaction in flight across the migration | its row `pending_approval` or terminal, both legal | the two `ALTER COLUMN … TYPE` steps rewrite `skill_deploys`, and a table rewrite is not MVCC-safe: a REPEATABLE READ transaction whose snapshot predates the rewrite and first reads `skill_deploys` after the migration commits sees it empty — register's pending guard sees no pending row (the duplicate-pending case under "two `register`s of one skill at once" below), approve's pre-read returns `deploy_not_found`, deny reports `not_found`. **Residual**, benign at single-user scale. `skill_runs` is altered in place and is unaffected |
| a future writer violates a CHECK at runtime (`23514`) | the deploy transaction rolls back before `applyFilesystem`, so `main` and `skills` are untouched | the error surfaces as the throw it is — a bug in the writer, not a value |

Who repeats a deploy: the Inngest auto-register caller runs `register` in one step with `retries: 0`. The `register_skill` tool is `durable: true` inside `handle-message`'s tool step (`retries: 2`); the loop hands it a `ToolCallContext.idempotencyKey`, which the handler drops, and `register` takes no key, so a crash after the commit and before Inngest records the step runs `register` again (failure modes). Every other repeat is an operator's.

| Failure mode | State left | Why it is safe, or the residual |
|-|-|-|
| `deny` of an unknown id, or of a row already `live`, `denied` or `rolled_back` (a second tap, a stale CLI call) | nothing written | the conditional UPDATE matches no row; the caller gets `not_found`, or `not_pending` with the status the row holds |
| `approve` racing a deny or another approve of the same row (two taps; a tap and the CLI) | one resolution wins and commits; the loser writes nothing | a resolution committed after the loser's snapshot raises `40001` at the loser's first UPDATE, and the transactor retries from a fresh snapshot, as if the winner had committed first: approve's pre-read sees `denied` or `live`, and a losing deny's conditional UPDATE matches zero rows and returns `not_pending`. The guarded UPDATE as the first write is hardening: REPEATABLE READ never reaches its zero-row path, which writes nothing |
| two `register`s of one skill at once | mixed tiers: an approve-tier winner writes only a `skill_deploys` INSERT; a notify-tier loser's snapshot does not see it, its `skills` UPDATE conflicts with nothing and `main` has not moved, so the skill goes live at the loser's tip while the winner's row stays pending. Two approve-tier registers of an existing skill insert two `pending_approval` rows — nothing conflicts, and no index forbids it. Two first deploys hit `skills.name` UNIQUE with `23505`, which the transactor does not retry, so the loser throws. A register racing an approve or deny may read a stale `pending_deploy_exists` | the stranded pending row blocks register until it is denied; approving it goes live when it carries the tip `main` already holds (the fast-forward check passes) and is `non_fast_forward_at_approve_time` otherwise; the thrown `23505` is a call the operator repeats; the stale rejection is benign. **Residual** until the advisory-lock audit (todo): only taking the lock before the snapshot closes the mixed-tier case; a partial unique index on `(skill_id) WHERE status = 'pending_approval'`, written through `ON CONFLICT DO UPDATE`, closes only the duplicate pending rows, since the mixed-tier loser inserts a `live` row |
| `register_skill` run again by Inngest after the commit, before the step result was recorded | live tier: the second run is `no_op`, the tip being `main`. Approve tier: the second run is `pending_deploy_exists`, which the model reads as a rejection; and when the crash fell between the commit and the `skills/deploy/approval-requested` emit, no approval keyboard is posted | the database is consistent either way; the operator approves from the CLI. **Residual**: `register_skill` drops the `ToolCallContext.idempotencyKey` the loop supplies, `register` takes no key, and the emit is not part of any recovery |
| `main` moves between a deploy's checks and its `update-ref` (another skill's deploy landed) | nothing committed | `advanceMain` throws inside the transaction, which rolls back the row and the projection; the caller gets the rejection named in the transition table and retries |
| `update-ref main` succeeds inside `applyFilesystem`, then the commit fails or the process dies | `main` at the deploy's sha; the database as before the transaction — for an approve of an enabled skill, the row still `pending_approval` and `skills` at the old sha; register's feature branch still exists | the database decides what runs, so the code on `main` does not execute. A repeat of register or approve converges: `isAncestor(main, sha)` holds for the sha `main` already holds, `update-ref` to it is a no-op, and register's branch survives until after the commit. A rollback's database repeat converges too (`main` already equals the target, which satisfies its guard), but its mirror never does: the lease expects the remote at the target while the remote holds the pre-rollback sha, so every push is rejected until the manual force push below. **Residual**, against *`main` is authoritative* below: until then `refs/heads/main` and `skills.git_sha` disagree, and every other skill's branch on the old `main` is `non_fast_forward`. If the operator denies instead, or a deny waiting on the row lock proceeds when approve's commit fails, deny writes only the row, so `main` keeps a commit whose deploy is `denied`, and the next deploy's mirror pushes it. Reconciliation is manual, before any further deploy: rewind `main` to the `skill_deploys.git_sha` with the newest `resolved_at` among `live` and `rolled_back` rows across all skills (or delete `refs/heads/main` if no deploy ever committed; register handles an unborn `main`), not to this skill's `skills.git_sha`, which would drop other skills' later deploys |
| the feature branch delete after a committed register fails | the deploy is live; the branch lingers | logged as a warning; registering the branch again is `no_op` while its tip is `main`, and `non_fast_forward` once another skill has deployed — harmless either way; the branch can be deleted by hand |
| `mirrorMainToRemote` fails after the commit, or the process dies between the commit and the push | local `main` and the database agree; the remote lags | every failure in the mirror — reading `origin`, resolving the identity, the push — is caught and logged as a warning, and the deploy still returns `live`. After a register or approve the next deploy's push, or `git -C $COGMO_SKILLS_PATH push origin main`, reconciles (Repo invariants). After a rollback the remote is ahead of local `main` and every later fast-forward push is rejected; recovery is `git push --force-with-lease=refs/heads/main:<remote sha> origin main` by hand |
| `rollback` of one skill past another skill's later deploy | `main` loses the other skill's commits; its `skills.git_sha` is reachable from no ref once its feature branch was deleted; the force-with-lease mirror pushes the rewind | **Accepted residual** of the single linear `main`, against *`main` is authoritative* and the Repo invariant on dangling shas: the other skill stays invocable while git keeps the unreachable commit (whether gc against the bare repo prunes it is not established), and its next register on a branch based on the old `main` is `non_fast_forward` until rebased. Recovery is to re-register the other skill's tip from a branch rebased onto the rewound `main`. The forward-commit rollback above `[proposed]` removes this residual |
| `rollback` while a deploy of the same skill is pending | a `rolled_back` row and `main` at the target; the pending row stays pending, its `prior_git_sha` stale | accepted as the owner override it is: a later approve fast-forwards `main` back over the rollback when the target is an ancestor of the pending tip, and is `non_fast_forward_at_approve_time` otherwise until the tip is rebased; a deny leaves the rollback in place. A rollback to the pending tip itself puts unreviewed code live with the row still pending |
| `[proposed]` forward rollback: `update-ref` lands, then the transaction fails or the process dies | `main` holds the restoring commit; `skills.git_sha` and the deploy rows as before, so the old version keeps running | the operator repeats the rollback. Its recovery check, as in the layout move, finds the newest first-parent commit on `main` that changes `skills/<name>/`; when that is Cogmo's restoring commit for this target (Cogmo's identity and a `Cogmo-Restores: <target>` trailer) with no row, it records it instead of making a second, even when other skills have deployed since. **Residual** until the repeat: a draft of the skill that merges `main` starts from the restored directory while its base is still the old live sha |
| `[proposed]` forward rollback: the mirror push fails after the commit | local `main` and the database agree; the remote lags | a plain push, so the next deploy's push or a manual `git push origin main` reconciles, as after a register |
| `rollback` to a sha that never had a `live` row, then `deregister`, then `enable` | `enable` is refused with `no_live_deploy` | the enable guard matches `live` only and the rollback's row is `rolled_back`; accepted and stated at the guard, which is the one place that reads it. `[proposed]`: the guard also accepts a `rolled_back` row whose `restores_git_sha` once had a `live` row, which still refuses this case, since the target never did |
| a `deregister` or `/disable` lands while a deploy is pending or a draft is open, then the deploy is approved or the draft's register goes live (the planned failure breaker lands the same way) | both write `disabled = false` (`executeRegister` and `executeApprove`), so the skill comes back live | **Decision:** approve and register keep `disabled` unless `disabled_reason` is `awaiting_first_deploy` or the deploy comes from a Repair draft, and `RegisterResult` carries `enabled: false`, so the toast, the CLI and the draft's notification say the skill stays disabled. Until `disabled_reason` lands, the predicate is that the skill's current sha has a `live` row. A disable committed after approve's or register's snapshot disables the now-live skill, which is what it asked for. Until implemented (todo.md → Skills autonomy S12), a residual |

**Approval-gate guard on `enable`.** `enable` refuses (`no_live_deploy`) when the skill's current `git_sha` has no `live` row, so `/disable` then `/enable` cannot activate a denied, blocked or pending first deploy. A rollback target that once had a `live` row passes; one that never did stays refused (failure modes). `[proposed]` After a forward rollback `skills.git_sha` is the restoring commit, whose row is `rolled_back`; the guard also accepts such a row when its `restores_git_sha` once had a `live` row.

**Key properties:**

- **`main` is authoritative.** After reconciliation, every enabled skill's `skills.git_sha` is on `main`: equal to it right after that skill's deploy, an ancestor once another skill has deployed. The failure modes above name the windows where it is not (an `update-ref` that landed before its transaction failed; a rollback past another skill's deploy) and how each reconciles. A pending, denied or blocked first deploy holds a sha that is not on `main`, and runs nothing.
- **Cancellable until the deploy transaction starts.** `register` checks its `signal` at its start and again just before the transaction, and the lockfile compile honours it throughout: a wait for the image ends, no session starts, and a running exec is disposed before its session is deleted. An abort seen by then stops the deploy, and `register` rejects with the signal's reason, not with a rejection the abort caused, leaving `main` and the branch untouched. These are checks, not a wall-clock cap: work between them that takes no signal (local git, the classifier, the Pyodide check's PyPI lookups) runs to its end first. Once the transaction has started, its wait on the advisory lock included, an abort only kills the mirror push to the remote, and the result stands. A skill-repo coding task's auto-register runs `register` under a 300 s deadline.

## Authoring pipeline `[proposed]`

A request becomes a live tool without anyone reading its code. The human answers manifest-level questions once, on a spec card, and afterwards sees notifications. Between the approved spec and a live deploy everything is machine-checked: mechanical gates, then agent reviewers from two model families, then register's own checks as the floor no reviewer can override.

```
request ─▶ spec card ─approve─▶ author(r) ─▶ verify(r) ─▶ review(r) ─▶ register ─▶ live
                                   ▲             │            │            │
                                   └── findings ─┴────────────┴────────────┘   r < max_rounds
```

The agent's only authoring tool is `draft_skill`, which requires a user turn ([agents.md → Turn Authority](agents.md#turn-authority-proposed)); `register_skill` leaves the agent surface (the CLI keeps `cogmo skills register` for the owner), and `delegate_coding` refuses `repo: "skills"`, so every skill-repo coding task belongs to a draft.

The lifecycle reuses the pipelines' gate and loop patterns ([pipelines.md](pipelines.md)) but not their engine (Decisions → Authoring lifecycle). A stage turn also holds `pipeline` authority, which refuses `delegate_coding`, while a draft starts its coding tasks from its own transitions: the first once the spec is approved, by the requester's tap or automatically, and the rest from later attempts and rounds.

### Skill lifecycle

**Unit.** A `skill_drafts` row, keyed by its UUIDv7 `id`: one request to create a skill, or to change a live one, from the first spec to a terminal state. Which of the two it is comes from the `skills` row at insert, never from the agent. Its bounds are fixed when the row is inserted — the skill name, and for an edit the live `base_git_sha` — so nothing re-plans them. A round (`round`, from 0) is one authoring pass that reviewers judge. An attempt (`attempt`, from 0 within a round) is one coding task: a pausing failure or a terminated run starts a new attempt without spending a round. Coding tasks are keyed `skill-draft:<id>:<round>:<attempt>`, rounds' attempts are `skill_draft_rounds` rows on `(draft_id, round, attempt)`, and reviews are keyed on `(draft_id, round, reviewer)`.

**Sequence.** `transition_seq` increments on every transition, the claim included. Each event the draft emits carries `{ draftId, seq }` and the bus-dedup id `skill-draft-<id>-<seq>-<event>`, the event's name included, since one transition can emit two events. Each gate key is `${draftId}:${seq}`, encoded as the pipelines' 8-hex token. A re-emit after a Retry, an Override or a second block in one round therefore always has an id the bus has not seen, and a card left from an earlier park never matches.

**Each attempt is a fresh coding task.** It has a fresh CLI session seeded with the findings and starts from the previous attempt's tip with `main` merged in, so a `non_fast_forward` from another skill's deploy is resolved before authoring instead of recurring each round; the per-skill directory layout keeps that merge clean. Coding delegation gains a `baseRef` on the task for this, which S9 designs in [coding-delegation.md](coding-delegation.md) with its CHECKs and failure rows (todo.md → Skills autonomy S9). Each attempt opens its own branch and PR; the draft closes the PR an attempt supersedes, so only the latest is open.

**Admission.** The skills repo admits one coding task at a time (`maxConcurrentTasks: 1`). When admission refuses a draft's next task, the draft stays in `authoring` in its `awaiting_slot` variant, which holds the attempt's pending findings; the round row, whose coding-task reference is NOT NULL, is written once admission succeeds. The reconcile cron retries admission each tick; after 24 h of refusals the draft parks at `blocked: author_unavailable` with `cause: admission`. In `awaiting_slot` no coding task exists, so its transitions (admission, the 24 h park and Abandon) guard on the variant; every other transition out of `authoring` guards on the attempt's task. The `skill_draft` source's daily quota, failure backoff and priority are coding delegation's admission rules ([coding-delegation.md → Admission & Rate Limiting](coding-delegation.md#admission--rate-limiting-proposed)), set in S9 (todo.md → Skills autonomy).

**States** — `skill_draft_status`:

| State | Meaning | Waits on |
|-|-|-|
| `specifying` | Spec drafted, card posted; the requester answers its open questions and approves it | the requester, 7 d |
| `authoring` | Round r's current attempt is writing the code on the draft branch | the coding task, within its wall time; in `awaiting_slot`, admission, 24 h |
| `verifying` | Mechanical gates on round r's tip ([Verify stage](#verify-stage)) | a step |
| `reviewing` | The reviewer panel on round r's tip ([Review stage](#review-stage)) | steps |
| `registering` | Panel passed, or no panel; the deploy is owed | a step |
| `awaiting_approval` | The deploy at the tip is pending, because an effect is in the owner's opt-in approve set | the owner, 14 d |
| `blocked` | An owner decision is needed; `blocked_reason` says which | the owner, 14 d |
| `live` | Terminal: the deploy went live | — |
| `abandoned` | Terminal: a person or a timeout ended the draft; `end_reason` says which | — |
| `failed` | Terminal: a draft function failed after its retries; `end_reason = step_error` | — |

```
draft_skill ─▶ specifying ◀─┐ revise_spec
                  │ ────────┘
                  │ approve_spec
                  ▼
     ┌──────▶ authoring(r) ──pr opened──▶ verifying(r) ──pass──▶ reviewing(r) ──pass──▶ registering(r) ──live──▶ live
     │             │                          │                     │    │                 │    │
     │ r+1         │ coding failed            │ findings            │    │ block           │    │ pending ─▶ awaiting_approval ──approved──▶ live
     └─────────────┴──────────────────────────┴─────────────────────┘    ▼                 │    ▼                    └──denied / timeout──▶ abandoned
       (r = max_rounds ⇒ blocked: rounds_exhausted)        revise   blocked: reviewer_block │  rejected (r+1)
                                                                                           ▼
     authoring, verifying, reviewing ──unavailable──▶ blocked: *_unavailable    blocked: risk_blocked ──override──▶ registering
     any non-terminal but registering ──abandon / timeout──▶ abandoned          a draft function failing after retries ──▶ failed
     verifying(r) ──pass, no review panel──▶ registering(r)
     registering(r) ──the deploy at the tip already denied, or base moved──▶ abandoned
     authoring(awaiting_slot) ──admitted──▶ authoring, or ──refused for 24 h──▶ blocked: author_unavailable
```

**Transitions.** Each is a conditional `UPDATE … WHERE id = $1 AND status = <from> AND transition_seq = <seq>` that increments `transition_seq`, sets `transitioned_at` to now, and returns whether it happened, claims and releases included ([state-machines.md](../.agents/rules/state-machines.md)); the guard's other reads share its transaction. One use-case file per transition lives under `src/skills/draft/`. **Actors:** the requester (who may be the owner) answers the spec card; the owner alone approves or denies a pending deploy and retries, overrides, extends or abandons a blocked or awaiting draft.

| Transition | Actor or trigger | Guard | Writes |
|-|-|-|-|
| insert → `specifying` | `draft_skill` (user turn) | the spec parses `SkillSpecSchema`, else the tool returns its issues and writes nothing; no open draft holds the name, read in the transaction under the partial name index's `targetWhere` | the row, `spec_version = 1`, and its kind from the `skills` row the transaction reads: an edit at `base_git_sha` = the skill's sha when the skill has gone live (its sha has a `live` or `rolled_back` row), otherwise a create with `base_git_sha` null; through `ON CONFLICT (idempotency_key) DO UPDATE` with a no-op SET, the one arbiter; the key is the call's `ToolCallContext.idempotencyKey` plus a digest of the canonical spec. A recovered row with another name, or an insert losing the name index to a concurrent one (`23505`, mapped at the store edge), returns `{ kind: "name_taken"; draftId; status }`; `state.card` for version 1. Emit `skills/draft.parked` |
| claim (same state) | the first step of each draft function | status and seq; `state.claimedByRunId` null, this Inngest run's id, or its lease expired (`claimedAt` plus the function's maximum runtime) | `state.claimedByRunId`, `state.claimedAt`; returns `claimed`, `claimed_by_this` (a replay) or `stale` with the row's status |
| release (same state) | `skill-draft-reconcile`, for `verifying`, `reviewing` or `registering` older than 30 min (`transitioned_at`) | status and seq; `state.claimedByRunId` null, or its lease expired, as read | the claim cleared, `transition_seq + 1`; then emit the state's owed event under the new seq, an id the bus has not seen |
| `specifying` → `specifying` (revise spec) | `draft_skill` naming a draft in `specifying`, keyed like the insert | status `specifying`; a spec whose digest equals the current one is a no-op, so a replayed call writes nothing | `spec`, `spec_version + 1`, `state.card` for the new version; emit `skills/draft.settled` for the old gate key and `skills/draft.parked` for the new one |
| `specifying` → `authoring` (approve spec) | the requester's Approve tap; or automatically when the spec equals the live manifest and asks nothing: for a Repair, or while the skill has had fewer than three `auto` approvals in 24 h | status, seq from the gate key; no open questions; for a tap, `state.card.specVersion` equals `spec_version`, so the requester approved the text they read | `round = 0`, `attempt = 0`, `state.approvedSpecVersion`, `state.specApproval` (`requester`, `auto` or `repair`); the first `coding_tasks` row (`insertOrRecoverTask`, `trigger_source = 'skill_draft'`) and its round row, one transaction, or, when admission refuses, the `awaiting_slot` variant ([Admission](#skill-lifecycle)); then emit `coding/task/start` (when admitted) and `skills/draft.settled` |
| `authoring` → `verifying` | `coding/task/pr-opened` for the current attempt's task | status, seq, the task is the current attempt's | the attempt's `tip_sha`; emit `skills/draft.verify` |
| `verifying` → `verifying` (re-verify) | `verify-code`, finding the dependency artefact gone ([Verify phases](#verify-phases)) | status, seq; the attempt's phase reset in the same transaction | `transition_seq + 1`, the claim released; emit `skills/draft.verify`, so a fresh run plans `verify-install` again; no round or attempt spent |
| `authoring` → `authoring` | `coding/task/failed` ([Coding failures](#coding-failures)) | status, seq, the current attempt's task | a round-spending reason: `round + 1`, `attempt = 0`, the failure as a finding; a retrying one: `attempt + 1`. Both insert the next coding task, or enter `awaiting_slot` when admission refuses, and after the commit close the superseded attempt's PR if it opened one |
| `authoring` (`awaiting_slot`) → `authoring` | the reconcile cron's admission retry | status, seq, the `awaiting_slot` variant: no task exists to guard on | the coding task (`insertOrRecoverTask` under the attempt's key) and its round row, carrying the variant's findings; then emit `coding/task/start` |
| `authoring` (`awaiting_slot`) → `blocked: author_unavailable` | the reconcile cron, when admission has refused for 24 h (`transitioned_at`) | status, seq, the `awaiting_slot` variant | `blocked_reason`, `state.cause = admission`, `state.resumeTo = authoring`, the findings kept; emit `skills/draft.parked`; no round spent |
| `authoring` → `abandoned: user_abandoned` | `coding/task/failed` with `user_cancelled` or `user_requested_revisions` | status, seq, the current attempt's task | `end_reason = user_abandoned`; after the commit, close the attempt's PR if it opened one; emit `skills/draft.settled` |
| `verifying` → `reviewing`, or → `registering` when `skills.review_panel` is off | `settle-verify`, report has no `revise` finding | status, seq | the report on the attempt row, whose `verify_phase` stays `code` for register; for `reviewing`, the round's panel frozen on the round row (members, their model ids from the flag row's `calibration_inputs.modelIds`, the checklist version, the calibration run that set the flag); emit `skills/draft.review`, or `skills/draft.register` when there is no panel |
| `reviewing` → `registering` | `settle-review` | status, seq; every member of the round's frozen panel has a `pass` row for round r | emit `skills/draft.register` |
| `registering` → `live` | `settle-register` | the deploy row it names is `live` or `rolled_back` ([Functions](#skill-lifecycle)) | `state.deployId` |
| `registering` → `blocked: registrar_unavailable` | `settle-register`, from a pausing outcome ([Functions](#skill-lifecycle)): `registrar_unavailable` (`index` or `sandbox`); `concurrent_first_deploy` ([first-deploy race](#first-deploy-race)); `pending_deploy_exists` whose pending row is not at the tip, which the owner resolves before Retry; or `resets_exhausted` ([Verify phases](#verify-phases)) | status, seq | `blocked_reason`, `state.cause` (`index`, `sandbox`, `concurrent_first_deploy`, `pending_deploy` or `resets_exhausted`), `state.resumeTo = registering`; emit `skills/draft.parked`; no round spent |
| `registering` → `awaiting_approval` | `settle-register` | the deploy row it names is `pending_approval` ([Functions](#skill-lifecycle)) | `state.deployId`, `state.card` (the approval message's text); emit `skills/draft.parked` |
| `registering` → `abandoned: denied` | `settle-register` | the deploy row it names is `denied`, a deny that landed before the draft settled | `state.deployId`, `end_reason = denied`; no approval card; emit `skills/draft.settled` |
| `registering` → `abandoned: base_moved` | `settle-register`, from the memoized `base_moved` rejection | status, seq | `end_reason = base_moved`; emit `skills/draft.settled`. The bounds are fixed at insert, so no tap can fix a moved base; the notification says the live version changed and a new draft starts from it |
| `awaiting_approval` → `live` / `abandoned` | `skills/deploy/resolved` for `state.deployId`, emitted by `approveDeploy` and `denyDeploy` whoever calls them (owner tap, CLI); the waiter's timeout, which denies, and on `not_pending` settles from the row's status; or the reconcile cron reading the row | the row's resolution; a timeout matches its gate key | `end_reason = denied` or `approval_timeout` on `abandoned`; emit `skills/draft.settled` |
| `verifying`, `reviewing`, `registering` → `authoring` (r+1) | findings: verify `revise`, any reviewer `revise` (none `block`), or a register rejection from `RegisterRejection`'s terminal group other than `blocked` | status, seq, round r < `max_rounds` | from `registering`, `register_rejection` on round r's current attempt row; `round + 1`, `attempt = 0`, the next coding task, carrying every finding of round r; after the commit, close round r's PR |
| any working state → `blocked: rounds_exhausted` | the same, at r = `max_rounds` | status, seq | `blocked_reason`; from `registering`, `register_rejection` on the attempt row; emit `skills/draft.parked` |
| `authoring`, `verifying`, `reviewing` → `blocked: *_unavailable` | a pausing coding failure; a verify sandbox or reviewer still unreachable after the step's retries; or a verify phase reset refused at the cap | status, seq | `blocked_reason`, `state.resumeTo`, and for `verifier_unavailable` `state.cause` (`sandbox` or `resets_exhausted`); emit `skills/draft.parked` |
| `reviewing` → `blocked: reviewer_block` | any reviewer `block` | status, seq | `blocked_reason`; emit `skills/draft.parked` |
| `registering` → `blocked: risk_blocked` | `settle-register`, from the memoized `blocked` rejection ([Risk tiers](#risk-tiers-without-a-human)) | status, seq | `blocked_reason`, `state.reasons` (the rejection's `SkillRiskReason[]`, rule 2's reasons); emit `skills/draft.parked` |
| `blocked` → `state.resumeTo` (retry) | the owner's Retry tap | reason is `*_unavailable` (including `registrar_unavailable`); seq from the gate key | `author_unavailable` inserts the next attempt's coding task, or re-enters `awaiting_slot` when admission refuses; the others re-emit the resumed state's event under the new seq, with the tap's phase reset ([Verify phases](#verify-phases) → At the cap); emit `skills/draft.settled` |
| `blocked` → `registering` (override) | the owner's Override tap | reason is `reviewer_block`, `risk_blocked` without the `binding_unenforced` reason ([Risk tiers](#risk-tiers-without-a-human), rule 2), or `rounds_exhausted` with round r's current attempt holding a `verify_report` with no `revise` finding and a null `register_rejection`; seq | `state.overriddenBy`, which register needs to accept a `blocked` tier; from `risk_blocked`, the tap's phase reset ([Verify phases](#verify-phases) → At the cap); emit `skills/draft.register`, `skills/draft.settled` |
| `blocked: rounds_exhausted` → `authoring` (extend) | the owner's One-more-round tap | `max_rounds` < 6; seq | `max_rounds + 1`, `round + 1`, the next coding task; after the commit, close the last round's PR; emit `skills/draft.settled` |
| `awaiting_approval` → `abandoned` | the owner's Abandon tap | status, seq | denies the pending `skill_deploys` row (`denyPendingDeploy`) in the same transaction, so later registers of the skill are not refused `pending_deploy_exists`; `end_reason = user_abandoned`; emit `skills/draft.settled` |
| other non-terminal → `abandoned` | Abandon (the requester's in `specifying`, the owner's in `blocked`; the tool's or the CLI's in any state but `registering`) or the waiter's timeout in `specifying` or `blocked` | not terminal and not `registering`, where Abandon returns `not_abandonable`, so `settle-register` never meets an abandoned draft; a timeout matches its gate key's seq | `end_reason`: `user_abandoned`, `spec_timeout`, `blocked_timeout`; an abandoned working state's coding task is cancelled, and from `verifying` or `reviewing` the attempt's PR is closed after the commit; emit `skills/draft.settled` |
| any non-terminal → `failed` | a draft function's `onFailure` | not terminal, and the failing run still holds the position. A claiming function: `state.claimedByRunId` is the failing run's. `skill-draft-on-coding`, which cannot read its run's step results: the event's `(round, attempt)` (carried by `coding/task/*` events for `skill_draft` tasks) are the draft's current ones and the draft is `authoring`, or, for `coding/task/failed` only, `blocked` at a reason that outcome writes (`author_unavailable`, `rounds_exhausted`), whose lost `skills/draft.parked` nothing re-emits; a draft it moved to `verifying` is the reconcile cron's. `-on-deploy`: `state.deployId` is the event's and the draft is `awaiting_approval`. `-waiter`: its gate key's seq is current. `-register` first reads the deploy at the tip ([Functions](#skill-lifecycle)): when one committed, it settles from it as `settle-register` would, and emits that state's event; it fails the draft only when none did. `-reconcile` never fails a draft: a failed tick is logged, and the next tick retries | `end_reason = step_error`, the error text in `state.detail` |

Transitions not in the table are illegal. A tap is honoured only from its row's actor and only while its gate key's seq is current. A transition that supersedes the current attempt (the next attempt or round, Extend) or leaves it no verify or register work (`awaiting_approval`, `live`, `abandoned`, `failed`) also moves the attempt's `verify_phase` to `done` in its transaction. A park in `blocked` keeps the phase, since Retry and Override resume into verify or register.

**Per-state data.** `state` is `SkillDraftStateSchema`, a Zod union discriminated on `status`, and a CHECK ties `state->>'status'` to the column; a `blocked` state is further discriminated on its reason, so `resumeTo` exists only on the `*_unavailable` variants, and `cause` (a Zod enum) only on `verifier_unavailable`, `registrar_unavailable`, and `author_unavailable` when admission parked it (`admission`); the `risk_blocked` variant carries `reasons`, the `blocked` rejection's list, written by the transition that parks it. `blocked_reason` (`skill_draft_blocked_reason`) is set iff `blocked`; `end_reason` (`skill_draft_end_reason`: `user_abandoned`, `spec_timeout`, `blocked_timeout`, `approval_timeout`, `denied`, `base_moved`, `step_error`) iff `abandoned` or `failed`. `spec` changes only in `specifying`, and stays the one copy of the spec; after approval `state.approvedSpecVersion` names the version every later check reads. The `specifying` and `awaiting_approval` variants carry `card: { specVersion, text }`, the exact text the gate message showed, so a tap is verified against what its actor read; the renderer fits a card within the transport's message limit (Telegram's 4096 characters), which bounds the stored text.

#### Coding failures

Every `coding_tasks.failure_reason` maps to one outcome for the draft:

| Outcome | Reasons |
|-|-|
| spend a round, the failure as a finding | `cli_exit_error`, `no_plan_produced`, `branch_conflict`, `verify_failed`, `verify_timed_out`, `pr_validation_failed`, `unexpected_error`, `unknown` |
| new attempt in the same round | `run_terminated`, `start_emit_failed`, `push_failed`, `pr_open_failed`; the fourth such attempt in one round parks at `blocked: author_unavailable` instead |
| pause at `blocked: author_unavailable` | `claude_auth_failed`, `auth_failed`, `pr_auth_failed`, `credentials_unavailable` |
| abandon (`user_abandoned`) | `user_cancelled`; `user_requested_revisions`, unreachable since a draft's plan gate clears itself, is treated the same |

**Functions.** Event-chained, each with concurrency 1 keyed on the draft id; the bare body branches only on memoized results ([inngest.md](../.agents/rules/inngest.md)). The working-state functions (`-verify`, `-review`, `-register`) claim first (above) and fail the draft through the claim. The others (`-on-coding`, `-on-deploy`, `-waiter`, `-reconcile`) do not claim. Their transitions are guarded on the `status` and `transition_seq` they read; their `→ failed` is guarded on durable state named by the event (the `→ failed` row).

| Function | Trigger | Steps and replay cost |
|-|-|-|
| `skill-draft-on-coding` | `coding/task/pr-opened`, `coding/task/failed` for a `skill_draft` task | one step that transitions and, for a new attempt, inserts its coding task; the emit is a second step |
| `skill-draft-verify` | `skills/draft.verify` | `claim`, `verify-install` and `verify-code` ([Verify phases](#verify-phases)), then `settle-verify`; or an emit step, which ends the run, when a verify step reset the phase from `verify-code` or parked the draft at the reset cap: the body runs up to five times, none of it billable |
| `skill-draft-review` | `skills/draft.review` | `claim`, one `review-<reviewer>` step per member of the round's frozen panel in parallel, then `settle-review` reading the review rows, since code after a parallel group runs only in fully memoized invocations. Four steps, so the body runs up to five times. Each reviewer step runs one CLI session within the review budget; a malformed-verdict retry resumes that session with the error instead of starting another. The step has `retries: 1`, and a retry repeats the session |
| `skill-draft-register` | `skills/draft.register` | `claim`, `register`, `settle-register`, then an emit step for the events the settled transition owes (`skills/draft.parked`, `skills/draft.settled`, or the next round's `coding/task/start`), as `-on-coding` has: four steps, so the body runs up to five times, none of it billable; `register`'s sandbox sessions run only inside its step. A `settle-register` retry after its commit reads `stale` with the row at the transition's target status and `seq + 1`, takes that as its own commit, and returns the same events, so the emit step still runs. The skill's **deploy at the tip** is its newest `skill_deploys` row whose `git_sha` is the tip, unless that row is `blocked`, which an Override is past. The `register` step reads it first: one there means an earlier attempt of the step, or a CLI register of the same sha, committed it, so the step returns it without calling register. Otherwise it re-enters from the attempt's phase ([Verify phases](#verify-phases)) and returns `RegisterStepResult`: `{ kind: "deployed"; deployId }`, `{ kind: "registered"; result: RegisterResult }` or `{ kind: "resets_exhausted" }`. Register never returns the approve- and rollback-only rejections, so the step's rejection type excludes them. `settle-register` matches the result exhaustively. `deployed`, a `live`, `pending_approval` or `no_op` result, and `pending_deploy_exists` at the tip each name one deploy row (for `no_op`, the enabled skill's sha has a `live` row by the enable guard, or a `rolled_back` one); `settle-register` reads it and settles from its status now: `live` or `rolled_back` → `live`, `pending_approval` → `awaiting_approval`, `denied` → `abandoned: denied`; a `blocked` row, or none, is an invariant violation that fails the run. **Residual:** a rollback or deregister landing between the two steps leaves the row as it was, so the draft can report `live` for code since rolled back or deregistered, which matches `live`'s meaning in the Deploy lifecycle. `base_moved` ends the draft `abandoned: base_moved`; `pending_deploy_exists` elsewhere, the pausing rejections and `resets_exhausted` park at `registrar_unavailable`; the remaining rejections, `blocked` included, settle from the memoized value |
| `skill-draft-on-deploy` | `skills/deploy/resolved` | one step: `awaiting_approval` → `live` or `abandoned` for the draft whose `state.deployId` it names |
| `skill-draft-waiter` | `skills/draft.parked` `{ draftId, gateKey, boundMs }` | `idempotency: gateKey`; sleeps out the bound with two reminders, then emits the timeout carrying its gate key; `cancelOn` `skills/draft.settled` matched on `data.gateKey`, as `pipeline-gate-waiter` does |
| `skill-draft-reconcile` | cron, every 10 min | for `verifying`, `reviewing` or `registering` older than 30 min (`transitioned_at`) whose claim is null or past its lease, it releases the claim (the release row) and emits the owed event under the new seq; a live claim it leaves alone, since an early re-emit would be consumed as `stale` and its id deduplicated by the bus for 24 h. For `awaiting_approval` it reads the deploy row and settles a resolved one. For `authoring` it reads the attempt's coding task: `queued`, re-emit `coding/task/start`; `pr_open` or `failed`, apply that outcome as `skill-draft-on-coding` would; running past its wall time, nothing, since coding delegation's own reconciliation ends it. In `awaiting_slot` it retries admission, and parks the draft after 24 h |

**Failure modes.**

| Failure mode | State left | Why it is safe, or the residual |
|-|-|-|
| A transaction that admits a coding task (approve spec, an admission retry, a new attempt or round) commits, the `coding/task/start` emit is lost | `authoring`, its coding task `queued` | the reconcile cron re-emits; a second tap carries a stale seq and is refused. The bus id and the task's `queued → planning` guard collapse duplicates |
| A coding task's outcome event is lost | `authoring` | the reconcile cron reads the task and applies its outcome |
| A coding task fails | per [Coding failures](#coding-failures) | a pausing or transient failure never spends a round, and a retry gets a fresh coding-task key, so it never recovers the failed task |
| A duplicate or late event, a re-run claim, a waiter from an earlier park, or a second tap or a tap racing a timeout on one gate | unchanged | each meets its transition's guard on status and seq (the claim also on its run id), reads `stale` and writes nothing; of two concurrent taps one wins, and the loser is told only if its decision did not stand |
| `verify-install`, `verify-code` or `register` crashes before Inngest records it | `verifying` or `registering` | the step re-enters from the attempt's phase ([Verify phases](#verify-phases) → failure modes). A repeat costs one more sandbox session; steps reset at most twice per attempt before the draft parks |
| A reviewer step bills its model, then crashes before recording | `reviewing` | the retry bills once more; the review row (unique on draft, round, reviewer, `ON CONFLICT DO UPDATE` with a no-op SET) keeps the first verdict that committed. **Residual:** one re-billed review per crash |
| A reviewer stays unreachable or returns a malformed verdict after retries | `blocked: reviewer_unavailable` | never a pass on a partial panel; Retry resumes `reviewing` under a new seq and re-runs only the missing member, whose row is absent |
| `register` commits, then the step result is lost | `registering` | the retry's `register` step returns the deploy at the tip without calling register ([Functions](#skill-lifecycle)), and `settle-register` reads it |
| A CLI `register` of the draft's exact tip lands first (live, pending or denied) | once the draft reaches `registering`, it settles from that deploy | the `register` step's read is keyed on the sha, not the draft, so it adopts the row as its own ([Functions](#skill-lifecycle)): `live`, `awaiting_approval` or `abandoned: denied`. **Residual:** the draft takes an outcome it did not request, which is the owner's decision on that exact code. Before register, verify and review still judge the tip, so a draft in `verifying` or `reviewing` can end in `revise` or `reviewer_block` while the CLI has that code live |
| Two first deploys of one name race on `skills.name` | `registering`, or `blocked: registrar_unavailable` | the [first-deploy race](#first-deploy-race): one in-process retry, then a park without spending a round |
| Register rejects the tip (validation, lockfile, spec drift, `non_fast_forward`) | `authoring` at r+1, or `blocked: rounds_exhausted`; the rejection in the attempt's `register_rejection` | the rejection becomes a finding, so the author fixes what the floor refused. Each attempt merges `main` before authoring, so a `non_fast_forward` recurs only when another skill deploys between that merge and register. **Residual:** that window costs a round |
| Rounds run out | `blocked: rounds_exhausted` | the cap bounds cost; Extend grants one round at a time up to 6, Override registers only a tip that passed verify and that register has not refused, read from the attempt's `verify_report` and `register_rejection` (the override row) |
| `cogmo skills approve` or `deny` resolves the draft's pending deploy outside the draft | `live` or `abandoned` | both emit `skills/deploy/resolved`, which the draft follows like a tap |
| `cogmo skills rollback`, `deregister`, `/disable` or a CLI `register` of the same skill while a draft is open | the draft's state | a rollback or a live CLI register moves `skills.git_sha` off the draft's base, so the draft's register returns `base_moved` and the draft ends `abandoned: base_moved`, spending no round; a deregister or `/disable` moves no sha, and register keeps the skill disabled (Deploy lifecycle → failure modes); a pending deploy the CLI left at another sha parks the draft at `blocked: registrar_unavailable` (`pending_deploy`) until the owner resolves it and taps Retry |
| A cron fire of the skill while a revision is in flight | the live version runs | a draft writes nothing to `skills` until register; each run records the `git_sha` it ran |
| Abandon commits, the coding-task cancel it emits is lost | `abandoned`; the task runs on | when the task opens its PR, `skill-draft-on-coding` finds the draft terminal and closes the PR. **Residual:** the task's tokens are spent |
| The coding task finishes between Abandon's read and its commit | `abandoned`; the outcome event arrives after | the outcome's transition guard reads `stale`; a PR it opened is closed as above |
| `approveDeploy` or `denyDeploy` commits outside Inngest and its `skills/deploy/resolved` emit is lost; or the resolution commits after `settle-register` read the row `pending_approval`, and its event arrives while the draft is still `registering`, so `-on-deploy` reads it as stale | `awaiting_approval` | the reconcile cron reads the deploy row and settles the draft within one tick; the waiter's timeout does the same if it fires first |
| A claim holder is cancelled or its process dies | the working state, claimed | after the lease (`claimedAt` plus the function's maximum runtime), the reconcile cron's release takes a new seq and re-emits, so a new run claims under an id the bus has not seen; within the lease the cron does nothing |
| The release commits, its emit is lost | the working state, unclaimed, at the new seq | 30 min later the next release takes a newer seq and emits again |
| Admission refuses for 24 h (a stuck task holds the slot; the source's quota or backoff) | `blocked: author_unavailable` (`admission`) | Retry tries admission again, and Abandon ends the draft; no round spent |
| Abandon in `awaiting_slot` | `abandoned` | no coding task exists to cancel |
| A run in flight across a deploy that changes these functions | each step replays its stored result | new data rides new steps reading committed rows, never an earlier step's return value |
| `draft_skill` re-run by Inngest after its commit | the same row | the key (the call's key plus the spec digest) recovers it through the one `ON CONFLICT` arbiter |
| Two `draft_skill` calls for one name at once | one row | the loser trips the partial name index (`23505`), which the store returns as `name_taken` |
| A skills-repo coding task started before the draft machine shipped reaches `pr-opened` | no draft row | the subscriber registers it as the auto-register subscriber does today; the path is removed once no skills-repo coding task without the `skill_draft` trigger source is non-terminal |
| The requester has no reachable channel for the card | `specifying` | it times out to `abandoned: spec_timeout`; `cogmo skills drafts` lists it meanwhile |
| A draft function fails after its retries | `failed: step_error`; for `-register` with a deploy committed at the tip, the state that deploy settles | reported to the requester with the error. `-register` never fails a draft whose deploy committed, so a failed draft leaves no deploy behind, except a waiter failing in `awaiting_approval`, which leaves its pending deploy to the owner (`cogmo skills drafts`, the CLI); until it is resolved, a new draft of the name meets `pending_deploy_exists` |
| `skill-draft-on-coding`'s emit step fails after its `authoring → verifying` committed | `verifying` | its `onFailure` leaves a `verifying` draft alone; the reconcile cron re-emits `skills/draft.verify` |
| `skill-draft-on-coding`'s emit step fails after it parked the draft | `failed: step_error` | its `onFailure` fails a draft it parked at the event's position, since no waiter started and nothing re-emits `skills/draft.parked` |
| A claiming function's `skills/draft.parked` emit fails after its retries (the event API unreachable throughout) | the parked state, no waiter | the park released the claim, so `onFailure` cannot fail the draft. **Residual:** no reminders or timeout; `cogmo skills drafts` lists it, and Abandon from the tool or the CLI ends it |

**Cost bounds.** A draft spends at most `max_rounds + 1` rounds (default 3 + 1, ceiling 6 + 1 with Extend), each of at most four coding tasks under the skills repo's `taskTokenBudget`, though only the round-spending first is normal. Each round runs at most two review sessions of up to 100k tokens, malformed-verdict retries included, and an Inngest retry of a review step (`retries: 1`) runs one more: at most rounds × 2 × 2 × 100k tokens, 1.6M by default and 2.8M at the Extend ceiling. Each attempt's verify takes two sandbox sessions, and each phase reset one or two more; steps reset at most twice per attempt, and every reset past that is an owner's tap. A skill starts at most three card-less drafts in 24 h ([Spec phase](#spec-phase)). Nothing loops without a round or an attempt, and every wait is bounded.

### Spec phase

The spec is the contract the user approves: the manifest without code. `draft_skill` takes it from the agent, and `SkillSpecSchema` validates it — `SkillManifestSchema`'s fields, with `inputs` and `outputs` as field lists (name, type, required, description), plus at least one `examples` entry and the agent's `open_questions`. A `name` equal to a built-in tool's is refused, since the tool registry drops such a skill with only a warning (`mergeBuiltInsAndSkillTools`). Cogmo adds the questions only it can ask: a declared secret missing from the secrets store, a tier-1 dependency Pyodide cannot load, a wildcard host on a shared zone, who a schedule runs as.

The card shows what the skill will be allowed to do, never code:

- name, description, trigger and schedule, and who a schedule runs as;
- inputs and outputs as a table, and the examples;
- effects, hosts, secrets (each bound or raw, present or missing) and direct dependencies with their category;
- the tier, and the risk tier the declarations alone predict, with its reasons;
- the open questions.

Approve appears only when no question is open; Abandon always does. The user answers in the chat, and the agent revises the spec with `draft_skill`. That conversation is the only human interaction before deploy. An edit whose spec equals the live manifest, a bug fix, skips the card, up to three such drafts per skill in 24 h (counted from `state.specApproval = 'auto'`); past that the card is posted. A Repair's draft starts from the owner's tap and is not counted.

**Drift is a rejection.** The author receives the approved spec rendered as `SKILL.md` frontmatter and may change only the body below it. Verify and register both compare the branch against `state.approvedSpecVersion`: frontmatter byte-equal to the rendering; the JSON Schema generated from `Input` and `Output` ([Contracts](#contracts-proposed)) matching the spec's field lists; hosts, secret names and effects found in the code within what the spec declares. A difference is a `spec_drift` finding naming the field. Widening a skill takes a new spec, which the user approves.

### Verify stage

Mechanical checks, run by Cogmo on the round's tip before any reviewer sees it, from configuration the author cannot edit. A failure is a `revise` finding with the check's id; every prompt-level practice in the skills repo's `CLAUDE.md` has a check here.

| Check | Mechanism | Practice it enforces |
|-|-|-|
| Owned paths | `git diff main...tip`, from the merge base since each attempt merges `main`, touches only `skills/<name>/` (`SKILL.md`, `skill.py`, `requirements.lock`, `test_skill.py`) for the draft's own skill | toolchain files and other skills are not the author's |
| Syntax | `python -I -m py_compile`; a tree-sitter `ERROR` node also fails | — |
| Entrypoint | AST: `async def run(inputs: Input, ctx: Ctx) -> Output` at module level | typed `run` |
| Contracts | AST: `Input` and `Output` subclass `pydantic.BaseModel`; their JSON Schemas generate in the tier's runtime and match the spec | pydantic contracts |
| Types and lint | `pyrefly check` against the `cogmo_ctx` stubs; `ruff check` with `E`, `F`, `B`, `BLE`, `S` (the flake8-bandit port, which stands in for bandit), `ASYNC` | failures as values: no bare or swallowing `except`, `SkillError` for expected failures |
| Imports | each import root is stdlib, `pydantic`, `cogmo_ctx`, or a module a declared dependency's wheel installs (from its `RECORD`, read at lockfile compile) | dependencies declared for every import |
| Dynamic code | AST: `exec`, `eval`, `compile`, `__import__`, `importlib.import_module` or `getattr` on a module with a non-literal name | no code built at runtime |
| Tier-1 bridges | `wasm-lint` rows for `js`, `pyodide_js`, `pyodide.ffi`, `pyodide.code`, `pyodide.http`, `micropip` | tier 1 reaches the host only through `ctx` |
| Effects, hosts, secrets | the AST rules plus rows for `ctx.memory.*`, `ctx.files.*`, a `ctx.http` write ([Write requests](#write-requests-proposed)), literal `ctx.secrets.get` names and literal URL hosts, checked against the spec | the manifest says what the code does |
| Idempotency | a `ctx.http` write ([Write requests](#write-requests-proposed)) without an `Idempotency-Key` from `ctx.run().key` is a `note` | external writes keyed |
| Tests | `pytest -q` passes `test_skill.py`, which has a test per spec example | tests for the examples |
| Sample call | each spec example runs through `run` in the skill's own tier runtime, with a recording `ctx`: reads return empty or fixture values, `ctx.secrets.get` a fixed placeholder (so no run id is needed), writes and egress are recorded, not performed; the output validates against `Output` and survives `json.dumps(allow_nan=False)` | output is the contract |
| Observed effects | the sample call's recorded hosts, secrets and writes are within the spec | — |
| Size | `skill.py` at most 400 lines | reviewers lose recall on large diffs, so skills stay small |
| Register dry run | `prepareRegister` without the write: manifest, ajv, lockfile compile, Pyodide compatibility | register's floor, met before review |

Static checks and `pytest` run under CPython in short-lived `cogmo-skills` sandbox sessions, one per verify step ([Verify phases](#verify-phases)), from a tools virtualenv (`/opt/cogmo-skills/tools`: ruff, pyrefly, pytest) outside the task's `sys.path`. The skill's dependencies come from the CPython venv `verify-install` populated ([Verify phases](#verify-phases)), for a tier-1 skill as for tier 2: the venv populate already exists for tier 2, the lockfile is compiled under CPython so it installs there, and the sample call is the check that runs the code under Pyodide. Running `pytest` inside the Pyodide child instead would add pytest to the hardened child's wheel set and a second test path. The session's egress comes in two phases ([Egress proxy](#egress-proxy-proposed) → credential classes): an install credential for the lockfile compile and the dependency install, revoked before any skill code runs, then a code credential for the schema import, the tests and the sample call, which answers the spec's hosts in shadow and denies the rest. Until sessions sit behind the proxy (todo.md → Skills autonomy S7), skill code runs with no network: `verify-code`'s session, which installs offline, is created with the backend's no-network mode (`NetworkMode: none` on Local-Docker), and register's session leaves its network after the install, before the schema import. A backend that cannot do either keeps the legacy schema path, with no import, for that tier. A tier-1 skill's sample call runs in the hardened Pyodide child ([Tier-1 boundary](#tier-1-boundary-proposed)). A tier-2 skill's sample call and `pytest` run only once tier-2 workers sit behind the proxy, with every request answered in shadow and none forwarded; until then a tier-2 skill gets the static checks only.

**Per backend.** `pytest` and a tier-2 sample call need the dependencies `verify-install` populated, which `verify-code`'s session reaches only on a `shared-volume` backend ([Cache layout](#cache-layout)). On a `per-sandbox` backend (Daytona) the venv is discarded with `verify-install`'s session, so neither runs there. The verify stage there is the static checks, plus a tier-1 skill's sample call, which reads the host's wheel directory. pyrefly there types a declared dependency's imports as `Any`, and a tier-2 skill's schema generation falls to register, which compiles, installs and imports in one session ([Contracts](#contracts-proposed)).

The report is `SkillVerifyReportSchema` on the round row: per check, its status and findings, plus the sample call's trace, which the reviewers and the notification read.

#### Verify phases

`verify-install` and `verify-code` are separate steps in separate sandbox sessions, so the install's output must be durable. `verify-install` populates the dependencies keyed by the lockfile hash: the `<hash>-py<X.Y>` venv under the existing `/skill-venvs` layout ([Populate](#populate)) for every tier, which `pytest` and pyrefly import under CPython, and for wasm also the tier-1 wheel directory, which the sample call's Pyodide child installs from; the two together are a tier-1 skill's artefact. It records that hash on the attempt row as `deps_hash`. `verify-code` installs offline from it. On a `per-sandbox` backend no venv outlives `verify-install`'s session, so there it populates only the tier-1 wheel directory, `verify-code` looks only for that, and a tier-2 skill has no artefact and no reset ([Verify stage](#verify-stage) → Per backend).

`skill_draft_rounds.verify_phase` (`skill_verify_phase`) decides which verify credential the proxy admits, and `verify_resets` is its generation; the attempt row arrives with the draft machine (S10), so the proxy's verify classes before it serve only a draftless register. Each credential names both, so a reset back to an install phase leaves every earlier credential refused ([Egress proxy](#egress-proxy-proposed) → credential classes). Each transition is a conditional UPDATE on the attempt row:

```
             ┌─────── reset ───────┐                       ┌───────────── reset ─────────────┐
             ▼                     │                       ▼                                 │
insert ─▶ install ──populated──▶ code ──compile──▶ register_install ──schema import──▶ register_code

populated: verify-install    compile, schema import: register    reset: verify_resets + 1
any phase ──attempt superseded, or left no verify or register work──▶ done
```

| Transition | By | Guard | Writes |
|-|-|-|-|
| insert → `install` | the round row's insert | — | `verify_phase = 'install'`, `deps_hash` null, `verify_resets = 0` |
| `install` → `code` | `verify-install`, after the populate | `verify_phase = 'install' AND verify_resets = $gen`, the draft `verifying` at this attempt | `verify_phase`, `deps_hash` (null for a skill with no dependencies); the install credential is refused from here on |
| `code` → `install` (reset) | a `verify-install` or `verify-code` run that finds no artefact for `deps_hash` (swept, or the volume lost); an owner's tap (At the cap, below) | `verify_phase = 'code' AND verify_resets = $gen`; a step also matches `deps_hash = $hash` and needs `verify_resets < 2` | `verify_phase`, `deps_hash` null, `verify_resets + 1` |
| `code` → `register_install` | `skill-draft-register`'s `register`, when it reaches the lockfile compile | `verify_phase = 'code' AND verify_resets = $gen`, the draft `registering` at this attempt | `verify_phase`: the compile reaches the index again |
| `register_install` → `register_code` | `register`, before the schema import | `verify_phase = 'register_install' AND verify_resets = $gen`, the draft `registering` at this attempt | `verify_phase` |
| `register_code` → `register_install` (reset) | a `register` run that reaches the compile with the attempt at `register_code`; an owner's tap (At the cap, below) | `verify_phase = 'register_code' AND verify_resets = $gen`, the draft `registering` (or, for a tap, `blocked`) at this attempt; a step also needs `verify_resets < 2` | `verify_phase`, `verify_resets + 1` |
| any → `done` | a draft transition that supersedes the attempt or leaves it no verify or register work ([Skill lifecycle](#skill-lifecycle), after the transitions) | that transition, in its transaction | `verify_phase` |

**Re-entry.** A step can crash after its UPDATE commits and before Inngest records it, so each step re-enters from the phase it finds:

- **`verify-install`** at `install` populates and moves; the populate is idempotent on `.ready`. At `code` it does nothing when the artefact for `deps_hash` is present, or when there is none to look for (a tier-2 skill on a `per-sandbox` backend). Otherwise it resets and installs again in the same step, under the new generation's credential.
- **`verify-code`** at `code` proceeds when the artefact is present. When it is not, the reset commits with the draft's `verifying → verifying` transition, which takes a new seq and emits `skills/draft.verify`, and the run ends. This run has `verify-install` memoized, so only a fresh run can install again; it plans `verify-install` from the start.
- **`register`** at `register_install` (a retry after its move, before the next) finds its `code` move matching no row and takes the phase as its own. The install credential of this phase and generation is still admitted, so it compiles again; the install is a no-op when the tip's lockfile hashes to `deps_hash` and that artefact is present. At `register_code`, skill code may already have run in the session the lost attempt held, so register resets and compiles under the new generation's credential. A `register` step that finds the deploy at the tip ([Functions](#skill-lifecycle)) returns before any of this.
- **No dependencies.** A skill that declares none has no artefact: `install → code` leaves `deps_hash` null, `verify-install` and `verify-code` at `code` find nothing to look for and proceed, and no artefact reset arises; register's lockfile step does not run. `register`'s reset at `register_code` still applies, since it is about skill code that may have run, not the artefact.
- **At the cap** (`verify_resets = 2`) a step's reset is refused and the working state parks with `state.cause = resets_exhausted`. A verify step commits `verifying → blocked: verifier_unavailable` in its own transaction and returns `{ kind: "parked" }`; an emit step for `skills/draft.parked` follows and the run ends. The `register` step returns `resets_exhausted` without calling register, and `settle-register` parks `registering → blocked: registrar_unavailable` from it. The owner's Retry from `verifier_unavailable` with the attempt at `code`, or from `registrar_unavailable` or Override from `risk_blocked` with it at `register_code`, performs that phase's reset in its own transaction, uncapped. A resumed run therefore starts with a fresh install credential instead of re-entering the state it parked in; past the cap, each further reset takes a tap.

A draftless register has no attempt row and moves through `register_install` and `register_code` in-process ([Egress proxy](#egress-proxy-proposed) → credential classes).

Re-entry above covers a crash after each step's move; the table adds the rest.

| Failure mode | Phase left | Why it is safe, or the residual |
|-|-|-|
| The artefact is swept, or the volume lost, before `verify-code` | `install` at the next generation | the reset and a fresh verify run under a new seq; no round or attempt spent |
| The reset commits, its `skills/draft.verify` emit is lost | `install`; the draft `verifying` at the new seq | the reconcile cron's release re-emits it under a newer seq |
| The artefact keeps disappearing | `code`; the draft `blocked: verifier_unavailable` | two resets per attempt, then each further one is the owner's tap |
| Override of `risk_blocked` | `register_install` at the next generation | the tap's reset; register's re-run proceeds there |
| An install credential leaks into skill code (left in the session's environment or a file) | any | it is admitted only at the phase and generation it names, with the draft in the matching state, and skill code runs only after the move out of that phase ([Egress proxy](#egress-proxy-proposed) → credential classes) |
| Two verify or register runs of one draft at once | unchanged | concurrency 1 per draft, and the claim |

**The skills repo toolchain.** Bootstrap writes Cogmo-owned files to the repo root: `pyproject.toml` (Python 3.14, a `dev` group pinning the tools virtualenv's versions, ruff and pyrefly configuration), `CLAUDE.md` (the authoring convention, generated from `SkillManifestSchema` and `SKILL_EFFECTS` so it cannot drift from them), `cogmo_ctx/` stubs ([Contracts](#contracts-proposed)) and `skill.schema.json`. A Cogmo release that changes them commits them to `main` through `advanceMain` at boot, under the bootstrap lock, deploying no skill. The repo's `verifyCommand` is `uv run --locked --group dev scripts/verify`, which runs ruff, pyrefly and pytest inside the coding task so the author sees failures in its own session; bootstrap writes it to an existing `coding_repos` row too, since today it inserts the row only when missing. Cogmo's verify stage is still the authority, since the author can edit nothing it runs.

The toolchain commit needs no row: the boot compares the toolchain files on `main` with the release's and commits only when they differ, so that comparison is its recovery check. The commit carries Cogmo's committer identity, which register refuses on an author's commits (`layout_violation`).

| Failure mode | State left | Why it is safe, or the residual |
|-|-|-|
| Crash before the advance | `main` unmoved; the commit object unreachable | the next boot compares again and commits |
| Crash after `update-ref` | `main` at the toolchain commit | the next boot finds the files equal and does nothing |
| Compare-and-swap lost to a concurrent register | nothing committed | retried under the lock from a fresh `main`, so the deploy that just landed is kept |
| A register of a branch cut before the commit | that register rejected | `non_fast_forward`; a draft merges `main` at its next attempt |
| Two boots at once | one commit | the bootstrap lock serializes them; the second finds the files equal |
| A rollback rewinds `main` past it | `main` holds the older toolchain files | **Residual** until the next boot recommits: drafts merging `main` verify against the older files. The forward rollback `[proposed]` touches only `skills/<name>/`, so it removes this case |

### Review stage

Read-only reviewer agents replace the human approval tap. A panel reviews every round that passed verify:

- **The author's model**, in a fresh session with no access to the author's;
- **a model of the other family.** Drafts are Claude-authored only today (the skills repo's `allowedBackends` is `["claude"]`), so Codex reviews them; Claude reviewing a Codex author is the future case. The author's family never reviews alone.

`SkillReviewer` is the interface (`review(input, signal): Promise<Result<SkillReviewVerdict, SkillReviewerError>>`), with a Claude Code backend (`claude -p --permission-mode plan`) and a Codex backend (`codex exec --sandbox read-only`), each in a read-only sandbox holding the draft branch, so a reviewer reads the repo, not just the diff. Tests run once, in the verify session, and reach reviewers as the report and trace. A review session has a 100k-token budget, which also covers its malformed-verdict retries, since each resumes the session (`claude -p --resume`, `codex exec resume`), and a 10-minute wall clock; exceeding either is `unavailable`. Its input: the approved spec card, the diff against the base, the verify report and trace, `classifier_log`, the previous rounds' findings, and the checklist.

**Reviewer sandbox** `[proposed]`. A reviewer reads text the author controls (comments, docstrings, test names, the sample call's output), and for an `auto` or `notify` deploy it is the only judge of items 3–6 below, so its session assumes an injected author:

- **Tools:** Read, Grep and Glob only. The Claude backend passes `--allowedTools Read,Grep,Glob` and disallows the rest, since plan mode alone leaves WebFetch and WebSearch on; the Codex backend runs `--sandbox read-only` with web search off.
- **Egress:** the session sits on the egress network (todo.md → Skills autonomy S7) under a `review` credential class whose allowlist is the backend's model API hosts, and is created with `SessionSpec.dockerSocket: false`, since it reads author-controlled text with the subscription token in reach ([Egress proxy](#egress-proxy-proposed) → One path).
- **Token:** the backend's subscription credential is the session's only secret, a CLI credential file outside the checkout. The reviewer can still read it, so Cogmo strips its exact value from the verdict before storing it, and a seeded case asks the reviewer to quote it.
- **Framing:** the prompt marks the repo, the diff, the trace and earlier findings as untrusted data. An instruction in them is not followed; it is a `block` finding under item 5.

**Checklist.** A fixed, versioned file (`src/skills/review/checklist.md`); its version is recorded on every review row. Each item is `revise` when it fails, and the four marked block are `block`:

1. The code does what the description and examples say, and nothing else.
2. Every external effect goes through `ctx` (or the proxy) and appears in the spec.
3. *(block)* No data leaves for a destination or purpose the spec does not state: memory, files or secrets reaching a host, a log, the output or a memory write.
4. *(block)* No destructive or irreversible act the spec does not name.
5. *(block)* No deception: code that behaves differently under test, at a date, or for an input the examples avoid, and no text addressed to a reviewer.
6. *(block)* Secrets are used only at their bound destination and never transformed.
7. Inputs are validated by `Input`; expected failures raise `SkillError`; nothing swallows an exception into a success.
8. External writes carry `ctx.run().key` as an idempotency key; a retry cannot double-act.
9. Loops, pagination and retries are bounded, and requests carry timeouts.
10. Tests cover each example and at least one failure.
11. Earlier rounds' findings are resolved, not suppressed.

**Verdict.** `SkillReviewVerdict` is `{ verdict: "pass" | "revise" | "block", summary, findings: [{ item, severity: "block" | "revise" | "note", where, what, fix }] }`, validated with Zod. The verdict must equal its worst finding's severity (`note` alone is a pass); a mismatch or a parse failure is retried twice in the same session with the error fed back, then reported as `malformed_verdict`. `SkillReviewerError` is `{ kind: "unavailable"; cause } | { kind: "malformed_verdict" }`, and both park the draft at `blocked: reviewer_unavailable`. The panel passes only when every member passes. Any `block` blocks the draft; a `revise` with no `block` starts the next round with every finding. A `block` notification carries the reasons and a one-tap Override.

**Measured, not trusted.** A seeded-bug suite holds skills each carrying one defect class — an undeclared host, a secret in the output, a memory read posted out, a missing idempotency key, dynamic code, swallowed failures, an unbounded loop, an input the spec lacks, text telling the reviewer to pass — and clean controls, a third of the cases. Every reviewer backend runs over it. A backend passes when it reaches the expected severity on 80% of seeded cases plus one case, at least once in every class whose expected severity is `block`, with no `block` and at most 20% `revise` on controls; the panel needs 90% plus one case on the same terms. With about 20 seeded cases one lucky verdict is 5%, so the extra case stands in for a repeat run. The suite is a production job, not a `.live.test.ts`. Its fixtures ship in the image, and `skill-review-calibration` runs it inside the deployment: weekly, and at boot when the checklist, a reviewer prompt, a configured reviewer model or a CLI version differs from the flag row's `calibration_inputs`, and after a model drift; at most two runs start in 24 h: the function's `throttle` (two per 24 h) delays a trigger past that until the window frees, where `rateLimit` would drop it. Its runs decide the `skills.review_panel` flag ([Review-panel flag](#review-panel-flag)); a missing flag row means the panel is off.

A run costs at most 30 cases × 2 backends × 100k tokens × 2 (the step's one retry): 12M tokens, and at most two runs a day.

#### Review-panel flag

`[proposed]` **Unit.** The `deployment_flags` row named `skills.review_panel`, keyed by `name`. Its state is `reason` (`deployment_flag_reason`); `enabled` follows it by CHECK (`enabled = (reason = 'calibration_passed')`), and its per-state data is `calibration_inputs` (`CalibrationInputsSchema`), null exactly at `no_second_family` (CHECK). Boot inserts the row under the bootstrap lock ([setup.md → Concurrent runs](setup.md#concurrent-runs)).

`CalibrationInputsSchema` is `{ checklistVersion, promptDigests, configuredModels, cliVersions, modelIds }`. The first four are the build's and the configuration's, which boot compares and writes. `modelIds` holds, per backend, the upstream model id the panel is judged on: boot writes the configured model when `configuredModels` changes, and a drift writes the id a reviewer reported. Boot never compares `modelIds`, so an id a drift wrote survives a boot that changes nothing else. A round's frozen model ids are the row's `modelIds` when it enters `reviewing` ([Calibration runs](#calibration-runs) → Frozen per round).

```
none, any ──boot, no Codex backend─────────────────────────────▶ no_second_family
none, any ──boot, the build's or configuration's inputs changed──▶ recalibration_pending
any but no_second_family ──settle, the run's inputs current────▶ calibration_passed | calibration_failed
any but no_second_family ──a review reports a model off its round's frozen id──▶ model_drift
```

| Transition | By | Guard | Writes |
|-|-|-|-|
| none → `recalibration_pending` or `no_second_family` | boot, under the bootstrap lock | no row | the row, through `ON CONFLICT (name) DO UPDATE` with a no-op SET: `calibration_inputs` from the build and the configuration, or null with no Codex backend; after the commit, with inputs, the job's `boot:<boot id>` trigger |
| any → `recalibration_pending` | boot, under the bootstrap lock | a Codex backend is configured; `checklistVersion`, `promptDigests`, `configuredModels` or `cliVersions` differ from the build's and the configuration's, or the inputs are null | those four fields; `modelIds` set to the configured models where `configuredModels` changed, kept otherwise; `enabled = false`; after the commit, the `boot:<boot id>` trigger carrying the inputs written |
| any → `no_second_family` | boot, under the bootstrap lock | no Codex backend is configured; the reason is not already `no_second_family` | `calibration_inputs` null, `enabled = false`; the owner told once |
| any but `no_second_family` → `calibration_passed` / `calibration_failed` | a calibration run's `settle` ([Calibration runs](#calibration-runs)) | `calibration_inputs = <the run's inputs>`, in the transaction that settles the run; a run whose inputs a boot or a drift has replaced matches no row and settles `stale`, so it can never re-enable the flag | `reason`, `enabled`; the owner notified on `calibration_failed` |
| any but `no_second_family` → `model_drift` | a `review-<reviewer>` step whose verdict reports a model other than its round's frozen id for that backend, in the transaction that writes the review row | `calibration_inputs->'modelIds'->>'<backend>' = <the round's frozen id>` | that backend's `modelIds` entry set to the reported id (`jsonb_set`), `reason`, `enabled = false`; after the commit, the job's `drift:<reviewId>` trigger carrying the inputs written |
| re-send a drift trigger (same state) | the retry of that review step: its review row comes back from the `ON CONFLICT` arm, and the guard above matches no row | the backend's `modelIds` entry already equals the review's reported id | nothing; after the commit, the `drift:<reviewId>` trigger again with the row's inputs, which the bus deduplicates if the first emit landed |
| re-send a lost trigger (same state) | boot, under the bootstrap lock, when no transition above applies | `reason` is `recalibration_pending` or `model_drift`, and no `calibration_runs` row exists for the current inputs' digest | nothing; after the commit, the `boot:<boot id>` trigger with the row's inputs |

A drifted round's verdicts still settle it, and its register classifies without the panel, since the flag is off.

| Failure mode | State left | Why it is safe, or the residual |
|-|-|-|
| A drift commits while a run with the earlier inputs is in flight | `model_drift` | the drift changed `modelIds`, so the run's remaining case steps skip and its `settle` matches no row and ends `stale`: a run that judged the old model never re-enables the flag |
| Both reviewers of a round, or reviews in two drafts, report drift at once | `model_drift`, each reported id written | each guard reads only its own backend's entry. Two writes to the row conflict, and the loser retries on `40001` from a fresh snapshot and writes its entry if it still holds the frozen id. The first trigger's run goes `stale` when the second write changes the inputs, so the last run judges both ids. A second report of an id already written matches no row and writes and triggers nothing |
| A review step crashes after the drift commits, before Inngest records it | `model_drift` | the retry recovers its review row, finds the backend's entry already at the reported id, and re-sends `drift:<reviewId>`; the trigger id is deterministic, so the bus drops it if the first emit landed. A retry that never comes (the step's retries spent) leaves the run to the next boot's re-send or the weekly run; tiers only drop meanwhile (`auto` lands at `notify`) |
| Boot crashes after writing `recalibration_pending`, or after a transition to it, before the emit | `recalibration_pending`; no run | the next boot finds the inputs equal, so no transition applies, and no `calibration_runs` row for their digest, so it re-sends the trigger under its own boot id. **Residual:** the panel stays off until that boot or the weekly run |
| A boot re-send while a drift or boot trigger is only delayed by the throttle, its run row not yet inserted | `model_drift` or `recalibration_pending` | the two triggers have different ids, so two runs judge the same inputs and both settle the flag the same way. **Residual:** one extra run, within the throttle |
| A drift's trigger arrives past the throttle | `model_drift` | the run is delayed, not dropped; register classifies without the panel meanwhile |
| Boot changes the inputs while a drift run is in flight | `recalibration_pending` | the drift run settles `stale`; the boot run judges the new build with the drift's `modelIds`, unless `configuredModels` changed |
| Boot finds no Codex backend while a run is in flight | `no_second_family` | the inputs are null, so its `settle` matches no row and ends `stale` |
| Two boots at once | one row | the bootstrap lock; the second finds the inputs equal and writes nothing |
| A backend configured with a model alias | one drift after each boot that changes `configuredModels` | boot writes the alias as `modelIds`, the first review reports the resolved id, and the drift run judges that. **Residual:** one extra run per configured-model change |
| An upstream that alternates between two model ids | a drift whenever a round meets the id the row does not hold | each drift writes the other id and starts a run. **Residual:** the throttle bounds it to two runs a day, and the panel is off between a drift and its run's settle |
| The retry of a review step in a second draft that reported an id another draft's drift already wrote | `model_drift` | its first attempt's guard matched no row, yet its retry finds the entry at its reported id and re-sends under its own review id. **Residual:** one extra run, within the throttle |

#### Calibration runs

**Unit.** A `calibration_runs` row, keyed by `(inputs_digest, trigger)`: the digest of its `CalibrationInputsSchema` value and the suite's fixture version, and the trigger (`boot:<boot id>`, `weekly:<scheduled time>` or `drift:<review id>`). A boot or drift trigger carries the inputs its transaction wrote ([Review-panel flag](#review-panel-flag)); a weekly fire judges the row's inputs as it fires. Its status is `calibration_run_status`; a `failed` run records `calibration_failure_reason`.

```
insert ─▶ running ──settle, inputs current, floor met──▶ passed
             │    ├─settle, inputs current, below floor─▶ failed: below_floor
             │    └─settle, inputs moved───────────────▶ stale
             └──onFailure──────────────────────────────▶ failed: step_error
```

| Transition | By | Guard | Writes |
|-|-|-|-|
| insert → `running` | the job's first step | — | the row, through `ON CONFLICT (inputs_digest, trigger) DO UPDATE` with a no-op SET, so a retried trigger recovers it |
| `running` → `passed` / `failed: below_floor` | `settle`, from the case steps' results | `status = 'running'`, and `UPDATE deployment_flags … WHERE name = 'skills.review_panel' AND calibration_inputs = <the run's inputs>` matches its row, in the same transaction; inputs a boot or a drift replaced match nothing | the scores per backend and per class; the flag set (`calibration_passed`) or cleared (`calibration_failed`, the owner notified) by that UPDATE |
| `running` → `stale` | `settle`, when that UPDATE matches no row | `status = 'running'` | the scores; the flag untouched |
| `running` → `failed: step_error` | the job's `onFailure` | `status = 'running'` | `failure_reason`; the flag untouched; the owner notified |

**Steps.** One `case-<backend>-<caseId>` step per backend and fixture, its ids from the shipped fixture list, then `settle`. Each case step first reads the flag row and returns `skipped` without calling the model when the row's `calibration_inputs` are no longer the run's, so a run overtaken by a boot or a drift stops billing. Concurrency 1 across the job, so runs queue rather than interleave, and the `throttle` delays a third start in 24 h. At 30 cases and two backends the job has 62 steps (the insert, 60 case steps, `settle`), so the body runs up to 63 times; it reads only memoized results and the shipped fixture list, and bills only inside case steps.

**Frozen per round.** Entering `reviewing` freezes the round's panel on the round row: members, their model ids (the flag row's `calibration_inputs.modelIds`, the ids the run that set the flag judged), the checklist version and the calibration run that set the flag. `settle-review` judges that membership, so a flag change mid-round neither adds nor drops a member. Register reads `reviewPanel` when it classifies, so a flag cleared since the round froze only lowers the tier.

| Failure mode | State left | Why it is safe, or the residual |
|-|-|-|
| A run passes after a boot or a drift changed the inputs | `stale`; the flag cleared as the boot or the drift left it | the compare-and-set matches no row, so an old run never sets the flag for new inputs |
| A run in flight across a deploy that changes its inputs | `stale` | its remaining case steps are `skipped`; only the cases already run were billed |
| A case step bills its model, then crashes before recording | `running` | the retry bills once more. **Residual:** one re-billed session per crash |
| `settle` commits, then its result is lost | terminal | the retry's guard matches no row, and the step returns the row's status |
| The job fails after its retries | `failed: step_error` | the flag stays as it was: a cleared one until the next run, a set one because an infrastructure failure says nothing about the reviewers |
| The flag is cleared while a draft is in `reviewing` | the round's frozen panel finishes | register classifies without the panel, so the draft can only land lower: `notify` instead of `auto` |
| A boot run and a weekly run triggered together | one waits | concurrency 1; the second's case steps skip when its inputs are no longer the flag row's |

**Without a panel.** When no Codex backend is configured, or the seeded-bug floor fails, `reviewPanel` is off: `reviewing` is skipped (the draft goes `verifying → registering`), and today's tier table applies with `auto` capped to `notify`. The owner is told once at boot, or when the suite clears the flag.

### Risk tiers without a human

`computeRiskTier` returns one of `auto`, `notify`, `approve`, `blocked`, plus the reasons that put it there (`SkillRiskReason[]`, from Reasons below), recorded in `classifier_log` and shown in every notification. Its inputs are the classifier log, the deployment's enforcement capabilities, and one owner setting.

| Tier | Effect at register |
|-|-|
| `auto` | Live; no message. Listed in `/skills` and the activity view. |
| `notify` | Live; a notification with undo. |
| `approve` | Pending until the owner taps Approve. Only for what the owner opted into. |
| `blocked` | Not deployed; a notification with the reasons and one-tap Override, which registers with `approved_by` set to the owner. |

`approve` is opt-in per class: the `skill_approval_classes` rows, one per class the owner opts into from `SKILL_EFFECTS` plus `raw_secret`, `reads_and_egress` and `sensitive_dependency`; none by default.

Rules, first match wins. They are the one statement of the tiering; every other section links here:

1. **Rejected**, no tier: validation errors, as today.
2. **`blocked`**: the manifest needs enforcement this deployment lacks — a bound secret before the proxy substitutes (`binding_unenforced`), a `network:` block on a tier-2 backend without the egress proxy's network (`egress_network_missing`), or a `network:` block of either tier on a host without the egress listener (`egress_listener_missing`: `egressListener = false`, [Egress proxy](#egress-proxy-proposed) → One path). Register returns the `blocked` rejection and writes a terminal `blocked` deploy row (Deploy lifecycle). Override is refused for `binding_unenforced`, since the skill would receive the plaintext its binding says it never sees; a spec declaring the secret raw is the way forward. The rule exists only with `reviewPanel`, so `blocked` is unreachable until the review stage ships.
3. **`approve`**: a declared or detected effect, or a reason, in `skill_approval_classes`.
4. **`auto`**, when all hold: an edit whose manifest does not widen the live one (a first deploy always notifies); the tier's boundary is enforced (tier 1 hardened; tier 2 behind the proxy network); no write, send, delete, financial or subprocess effect; every secret bound; no read effect alongside `network:`; every dependency on the allowlist; `cost_per_call_usd = 0`.
5. **`notify`**: everything else, each reason listed. A raw secret (`raw_secret`) lands here at most, never `auto`: its plaintext is in the skill's memory, so it can leave through any allowed host, a memory write or the output, and no check sees the value. A read effect with `network:` (`reads_and_egress`) is the same pairing as a raw secret with egress.

**Reasons** `[proposed]`. `SKILL_RISK_REASONS` (`src/skills/risk-reasons.ts`) is the one list, and `SkillRiskReason` its element type, for `classifier_log.reasons`, the `blocked` rejection and a `risk_blocked` draft's `state.reasons` alike. A deploy records every reason that applies, not only the first rule's; without `reviewPanel`, today's table ([Tiers](#tiers)) raises the reasons its rows name.

| Reason | Rule | Raised when |
|-|-|-|
| `binding_unenforced` | 2, `blocked` | a bound secret while `bindingsSubstituted` is off |
| `egress_network_missing` | 2, `blocked` | a tier-2 `network:` block while `tier2EgressEnforced` is off |
| `egress_listener_missing` | 2, `blocked` | a `network:` block of either tier while `egressListener` is off |
| `opted_in` | 3, `approve` | an effect or a reason in `skill_approval_classes`; `classifier_log.approvalClasses` names the classes that matched |
| `first_deploy` | 4 | a first deploy, with no live manifest to compare |
| `manifest_widened` | 4 | an edit whose manifest widens the live one |
| `tier1_unhardened` | 4; today's table, the tier-1 cap | tier 1 while `tier1Hardened` is off |
| `tier2_unenforced` | 4 | tier 2 while `tier2EgressEnforced` is off |
| `acting_effect` | 4 | a write, send, delete, financial or subprocess effect |
| `unlisted_dependency` | 4; today's table, `notify` | a dependency on neither list |
| `sensitive_dependency` | 4; today's table, `approve` | a dependency on the approve list |
| `paid_call` | 4 | `cost_per_call_usd` above 0 |
| `raw_secret` | 5 | a declared secret without a binding |
| `reads_and_egress` | 5 | a read effect alongside a `network:` block |
| `no_review_panel` | today's table | `auto` capped to `notify` while `reviewPanel` is off |
| `container_tier` | today's table, `approve` | tier `container` |
| `approve_gating_effect` | today's table, `approve` | an effect in `APPROVE_GATING_EFFECTS` |
| `secrets_with_network` | today's table, `approve` | any secret together with a `network:` block |
| `secret_breadth` | today's table, `approve` | three or more secrets |
| `declared_effect` | today's table, `notify` | any other declared or detected effect |
| `network_declared` | today's table, `notify` | a `network:` block without secrets |

Rule 1's validation errors are rejections, not reasons, and a `blocked` rejection carries only rule 2's three.

The classifier reads capabilities as flags (`tier1Hardened`, `egressListener`, `tier2EgressEnforced`, `bindingsSubstituted`, `reviewPanel`), never by inspecting the build, so the tier follows what is enforced while the pieces ship in order. Without `reviewPanel`, `reviewing` is skipped and rules 2–5 give way to today's table ([Risk tiering & auto-apply](#risk-tiering--auto-apply-confirmed)) with `auto` capped to `notify`, since no reviewer stands in for the tap. `tier1Hardened` and `bindingsSubstituted` are properties of the build; `egressListener` is set at boot (a container, or `COGMO_SKILLS_EGRESS_HOST_LISTENER=1` on the host); `tier2EgressEnforced` needs the build and `egressListener`; `reviewPanel` is the `skills.review_panel` row of `deployment_flags`. `tier1MemoryBounded`, set at boot where the per-child cgroup exists, is recorded beside them in `classifier_log`, and no rule reads it ([Tier-1 boundary](#tier-1-boundary-proposed), layer 5).

#### Write requests `[proposed]`

A request is a write when `isWriteRequest(method, host, path)` says so: a method other than `GET`, or a `GET` whose host and path match `WRITE_ENDPOINTS` in `ast-rules.ts`, the APIs that act on `GET` (the Telegram Bot API's `send*`, `edit*` and `delete*` methods). The verify stage's effect and idempotency checks ([Verify stage](#verify-stage)) and the shadow rule read this one predicate. **The shadow rule:** a shadow run ([Notifications and undo](#notifications-and-undo) → Shadow first fire) shadows every write, and every request to a host the deploy added to `network.allow`, whatever its method.

### Notifications and undo

One use case (`announceDeployOutcome`) serves every register caller and emits `skills/deploy/outcome` with `{ skillId, deployId, outcome, riskTier, reasons, conversationId }`; the transport renders it in the requester's conversation, or the owner's when there is none. The emit follows the deploy's commit, and nothing replays it: a lost `skills/deploy/outcome` loses only the message, a residual, since `/skills` and the activity view list every deploy.

| Outcome | Message | Buttons |
|-|-|-|
| `live`, `notify` | `skill X is live` (new, or `abc1234 → def5678`), the description, the reasons, effects (declared and detected), hosts, secrets (bound or raw), dependencies, schedule and run-as, verify and panel verdicts with the round | Disable; Roll back for an edit, a forward commit restoring the skill's directory (Deploy lifecycle); Details |
| `pending_approval` | the same, and the opted-in class that holds it | Approve, Deny |
| `blocked` | the same, and the reasons | Override and Abandon, the owner's |
| `rejected` | the findings, and the round it starts | — |

`auto` sends nothing at deploy. The `skills-auto-digest` cron sends the owner, once a day and only when there is one, the day's `auto` deploys with their reasons and verdicts; its bus id is the scheduled day, so a retry sends nothing twice. Disable is `/disable X`; Details links to the run view ([Observability](#observability-proposed)).

**Shadow first fire** `[proposed]`. The first scheduled fire after a deploy that adds or widens a write effect runs in shadow: reads are live; `ctx` writes and every proxied request the shadow rule covers ([Write requests](#write-requests-proposed)) are recorded and answered with a fixed shadow reply instead of performed. The intents are notified (Looks right, Disable), and the run is recorded with `shadow = true`. Looks right only dismisses the card: nothing waits on it, and the next fire runs live. A tool call is never shadowed: the user asked for the act in that turn and saw the deploy notification. Nor is a CLI invoke, the owner's own act. A shadow run that fails is reported with the intents it reached and does not count toward auto-disable.

The debt is a `skill_shadow_fires` row, keyed by the owing deploy and bound to its `git_sha`, with status `skill_shadow_fire_status`:

```
insert ─▶ owed ──claim with the run insert──▶ claimed ──run finished──▶ completed
           ▲                                    │
           └──────run ended pausing─────────────┘
owed, claimed ──a later deploy or rollback of the skill──▶ superseded
```

| Transition | By | Guard | Writes |
|-|-|-|-|
| insert → `owed` | the transaction that puts a deploy live (register, approve, an Override's register), or a rollback's | register and approve: its `classifier_log` adds or widens a write effect against the version it replaces, or the skill's open row (`owed` or `claimed`) exists. A rollback, which classifies nothing and restores code the owner chose: only the open row existing | the row at the deploy's sha (a rollback's: its `rolled_back` row and the sha it puts live); the open row `superseded` |
| `owed` → `claimed` | a scheduled fire's run insert (`startOrRecoverRun`), in its transaction | status `owed`, whatever sha the run reads | `run_id`; the run inserted with `shadow = true` |
| `claimed` → `completed` | the run's finish transition, in its transaction | status `claimed`; `run_id` is the finishing run, which ran at the row's `git_sha` | `resolved_at`; the notification after the commit |
| `claimed` → `owed` | the same, the sweeper's finish included, for a run ending in a pausing kind (nothing ran to its end) or run at another sha | as above, without the sha | `run_id` cleared, so the next fire, the pausing re-fire included, is shadowed |
| `owed`, `claimed` → `superseded` | a later deploy or rollback of the skill, in its transaction | not terminal | `resolved_at`; the new deploy inherits the debt (insert) |

A scheduled fire that finds the row `claimed` by another run also runs in shadow, without claiming.

| Failure mode | State left | Why it is safe, or the residual |
|-|-|-|
| Crash between the run insert and the dispatch | `claimed` with a `started` run | the sweeper finishes the run `host_lost`, a pausing kind, which returns the row to `owed` |
| Two scheduled fires at once | one `claimed` | the other finds it claimed and runs in shadow too |
| A deploy lands between a cron tick and its dispatch | the new deploy's row, which inherits an unpaid debt | a fire claims whatever sha it reads, so it is shadowed; only a run at the row's sha pays the debt |
| A tool call runs the skill before its first fire | live; the row stays `owed` | the user asked for the act in that turn |
| The shadow notification's emit is lost | `completed` | **Residual:** the run view shows the shadow run and its recorded intents |

**Auto-disable.** Defect-class failures ([Contracts → Run failures](#run-failures)) at the live sha — three in a row, or half of the last ten with at least five — disable the skill with `disabled_reason = 'error_rate'` and notify with the last error: Enable, Roll back, Repair. Repair opens a draft whose spec is the live manifest, so it skips the card, with the failures as round 0's findings.

## Dependencies `[confirmed]`

Skills declare direct Python dependencies in `SKILL.md`. Register produces a hash-pinned lockfile committed alongside `skill.py`. At first invocation of a given lockfile hash, the worker materialises a private virtualenv on a persisted volume; subsequent tasks activate the existing venv. One venv per lockfile hash, shared across workers and across skills with identical lockfiles.

### Declaration

`dependencies:` in the manifest frontmatter — a flat list of strict pins:

```yaml
dependencies:
  - httpx==0.27.0
  - pydantic==2.5.3
  - google-api-python-client==2.108.0
```

Strict `name==version` only. The Zod regex in `SkillManifestSchema` rejects every other form at the manifest layer:

| Excluded form | Why |
|-|-|
| Ranges (`pkg>=1.2,<2`) | Resolution drifts between register and re-resolve — same skill resolves to different transitives over time. |
| Extras (`pkg[foo]`) | Add transitive surface invisible in the manifest line — bypasses the classifier's per-package read. |
| URL / git refs (`pkg @ git+https://…`) | Supply-chain surface — bypasses PyPI + hash pinning. |
| Path / file specifiers (`./local-pkg`) | Non-portable, no meaningful audit, breaks the sandbox model. |
| Bare names (`pkg`) | Implicit "latest" — same drift class as ranges. |

Skills needing an extra declare the underlying package directly. URL/path forms are a future escape hatch when a real driver appears.

Empty `dependencies` is the common case — a tier-1 skill calling REST APIs through `ctx.http` needs no third-party package, so it pays no populate cost and skips the venv-overlay activation entirely.

### Lockfile

`requirements.lock` lives next to `skill.py` in the skill's directory — hash-pinned via `uv pip compile --generate-hashes --no-header`, transitive graph fully expanded, committed by the skill author in the same git commit as `SKILL.md`. Atomic from the operator's perspective.

**Authors MUST pass `--no-header`** when generating the lockfile. Without it, uv prepends a comment block carrying the literal command line (`uv pip compile requirements.in -o requirements.lock`), which differs from the verifier's command line (`uv pip compile -`); the byte-comparison below would then reject every fresh skill register as stale.

`SKILL.md`'s `dependencies` is the source of truth for the classifier and for what authors edit. `requirements.lock` is the source of truth for `uv pip sync` at populate time. Register verifies they agree by re-running the compile inside a short-lived sandbox session (`SandboxClient.create()` → `execStreaming(["uv", "pip", "compile", "--generate-hashes", "--no-header", "-"])` → destroy) and byte-comparing against the committed file — stale lockfile fails register with a clear error. The compile runs against the `uv` binary baked into `ghcr.io/iskhakovt/cogmo-skills:<version>`, so the resolver at register matches the resolver at populate, byte-for-byte.

No host-side `uv` dependency. The Cogmo TS host shells out to the sandbox for compile + populate; the `uv` binary is part of the runtime image, not the deployment surface.

### Cache layout

The wheel cache and per-lockfile-hash virtualenvs live flat at `/skill-venvs/`, with the populator owning the `<lockfile-hash>-py<major>.<minor>/` subdirectory layout. The directory layout is the same on every backend; what differs is whether the storage *behind* `/skill-venvs/` is a cross-worker shared volume or container-local ephemeral disk.

```text
/skill-venvs/
  .uv-cache/                       # UV_CACHE_DIR — content-addressed wheel cache.
                                   # Dotted so it can't be mistaken for a lockfile-hash dir
                                   # (sha256 hex never starts with a `.`); the reaper's
                                   # regex excludes it from the sweep set.
  <hash>-py3.14/                   # populated, ready (suffix = runtime's `py<major>.<minor>`)
    bin/
    lib/python3.14/site-packages/
    .ready                         # marker — readers gate on this
  <other-hash>-py3.14.tmp.<wid>/   # mid-populate; rename-target
```

Backend dispatch happens through the `SandboxCapabilities.depsCacheSharing` flag — `"shared-volume"` or `"per-sandbox"`. The skill runner reads the capability off the configured `SandboxClient` and decides whether to mount a shared deps-cache volume; consumers branch on the capability rather than the backend identity.

**`shared-volume` backends (Local-Docker).** A named Docker volume mounts at `/skill-venvs` on every worker in the pool, so the wheel cache and populated venvs persist across worker recycle and are shared across pool members. `.uv-cache/` and the `<hash>-py<X.Y>/` venvs share one ext4 filesystem so uv's hardlink install mode works — cross-filesystem hardlinks silently fall back to copy and inflate disk by ~100× ([uv #15149](https://github.com/astral-sh/uv/issues/15149)). Wheels download once across the entire cache; every venv hardlinks from `.uv-cache/` for free dedup. The populate script's `mv -T` atomic publish (see *Populate* below) relies on POSIX rename(2), which ext4 honours.

**`per-sandbox` backends (Daytona).** No shared volume is mounted. Each sandbox writes `/skill-venvs/` to its own container-local ephemeral disk, populates lazily on first use, and discards everything on `sandbox.delete()`. This is forced by what Daytona offers: Volumes are mountpoint-s3 FUSE mounts, which lack hardlinks, general rename(2), and O_RDWR on existing files ([mountpoint-s3 SEMANTICS](https://github.com/awslabs/mountpoint-s3/blob/main/doc/SEMANTICS.md)). uv's content-addressed cache and the populate script's atomic publish both require those ops; on the volume they fail durably with `EPERM`. The capability flag advertises this fact to the runner, which drops `depsCacheVolumeName` regardless of operator config, and to `DaytonaSandboxClient.create` itself, which rejects a `SessionSpec.depsCacheVolume` outright so wiring bugs fail fast instead of wedging skill registration.

The trade-off on `per-sandbox`: each pool worker pays one cold populate per `(lockfile-hash, py-abi)` pair it sees over its lifetime (typically seconds — `httpx`-class deps are ~5 MB). With `max=3` workers (`COGMO_SKILLS_POOL_MIN` defaults to 0) and `recycleAfterTasks=500`, the worst case is N skills × 3 workers × first-invoke populate, amortised over thousands of subsequent invokes. At personal scale this is in-line with the existing Daytona snapshot warm-up cost. Cross-sandbox dep dedup (snapshot-per-lockfile bake, or per-hash pool restructure) is the future move when pool sizing changes or empirical populate cost demands it; tracked in `todo.md`, as is the conformance scenario a POSIX-volume Daytona tier would need. The `skill-venvs-reaper` Inngest cron similarly checks the capability and no-ops on `per-sandbox` backends — each sandbox's `/skill-venvs/` is already disposed with its container.

The `-py<major>.<minor>` suffix encodes the runtime's Python ABI so an image bump that changes Python minor (e.g. `python:3.14-slim` -> `python:3.15-slim`) routes to a fresh venv: populate writes `<hash>-py3.15/`, the task process activates the same. The stale `<hash>-py3.14/` orphans cleanly and (on `shared-volume` backends) the reaper sweeps it on the next tick. Host doesn't need to know the image's ABI: the populator and the reaper run `python3 -I -m cogmo_skills_runtime.abi` (`PYTHON_ABI_TAG_COMMAND` in `deps.ts`), and the task process calls the same `python_abi_tag()`, in the runtime they share. `-I` keeps the cwd off `sys.path` and ignores `PYTHON*` variables, so `-m` runs the image's module whichever directory the script runs in; without it, a `cogmo_skills_runtime` in the cwd would run instead.

### Populate

First task using a given lockfile hash populates the venv. Concurrent populators on the same lockfile hash are serialised by `.ready` + `mv -T` rename failure — the marker file plus atomic rename is the synchronisation point; the loser of the race detects `.ready` on the target after its own rename fails and exits success without redundant work. No Postgres advisory lock is used.

```text
0. PY_ABI=$(python3 -I -m cogmo_skills_runtime.abi)
1. if /skill-venvs/<hash>-$PY_ABI/.ready exists → done
2. uv venv /skill-venvs/<hash>-$PY_ABI.tmp.<workerId>
3. uv pip sync --require-hashes --only-binary=:all: \
       --python /skill-venvs/<hash>-$PY_ABI.tmp.<workerId>/bin/python /dev/stdin
                                  (lockfile contents streamed in on stdin from the host;
                                   hardlinks from .uv-cache/)
4. touch /skill-venvs/<hash>-$PY_ABI.tmp.<workerId>/.ready
5. mv -T /skill-venvs/<hash>-$PY_ABI.tmp.<workerId>
       → /skill-venvs/<hash>-$PY_ABI
                                  (atomic; readers see the populated venv or nothing.
                                   `mv -T` refuses to nest on collision, so the loser's
                                   rename fails and it exits success after seeing .ready.)
```

`.ready` is the marker readers gate on — `uv` itself does not provide directory-level atomicity guarantees for parallel `--target` or `venv` population ([uv #15335](https://github.com/astral-sh/uv/issues/15335), [#13883](https://github.com/astral-sh/uv/issues/13883)). The marker file plus `mv -T` rename is the portable answer.

The register-time compile and the populate and reap scripts run from `/` with `UV_NO_CONFIG=1` (`DEPENDENCY_EXEC_OPTIONS` in `deps.ts`). The image's working directory is `$HOME`, which tasks on a warm worker share and can write ([State reset between tasks](#state-reset-between-tasks-confirmed)). uv reads a `uv.toml`, `pyproject.toml` or `.python-version` from the cwd and its parents (a project's `requires-python` even with discovery off), and `~/.config/uv/` from any cwd, so a file a task left there could choose the interpreter or index for the venv a later task runs in.

Failure during steps 2-4 leaves an orphaned `<hash>-py<X.Y>.tmp.<workerId>/` directory. The populate script itself opportunistically sweeps `.tmp.*` entries older than 10 minutes at the top of every populate run — the per-hash reaper (`skill-venvs-reaper` Inngest cron) targets only published `<hash>-py<X.Y>/` directories (sha256 hex + ABI suffix), never in-flight tmp dirs.

`--only-binary=:all:` forbids source distributions by default — sdists require a build toolchain in the sandbox and run arbitrary `setup.py` code at install. A skill declaring a package available only as sdist fails at its first populate: the register-time compile does not pass `--only-binary` yet, and may build an sdist to read its metadata (todo.md → Skills autonomy). Sdist support is a future opt-in (`allow_sdist: true` in the manifest) when a real driver appears; its tier is decided then.

### Activation

Before running the skill, the task process activates the skill venv. The path is constructed from the lockfile hash + the runtime's Python ABI — the populator (running in the same image) produces the same path, so the two agree without coordinating through the host:

```python
venv = f"/skill-venvs/{lockfile_hash}-{python_abi_tag()}"  # py<major>.<minor>
os.environ["VIRTUAL_ENV"] = venv
os.environ["PATH"] = f"{venv}/bin:{os.environ['PATH']}"
sys.path[:0] = [f"{venv}/lib/python{sys.version_info[0]}.{sys.version_info[1]}/site-packages"]
```

The supervisor's own venv (`/opt/cogmo-skills/.venv`, where `cogmo_skills_runtime` lives) stays on `sys.path` — the runner needs it to keep serving the dispatcher protocol. The skill venv is *prepended*, so any name collision resolves to the skill's pinned version (`import httpx` → skill's `httpx==0.27.0`, not whatever the runtime happens to bundle). Skill code can technically reach `cogmo_skills_runtime` symbols; that's UX confusion at worst — the real isolation boundary is the sysbox container, not Python module visibility.

A skill with `lockfile_hash IS NULL` (empty `dependencies`) skips activation entirely — the task runs with the stdlib and nothing else.

### Tier 1 (WASM)

Pyodide consumes the parsed package specs from `requirements.lock` via `micropip.install(specs, keep_going=False)` at worker init. Hashes are dropped — micropip has no `--require-hashes` equivalent; see *Security posture* below for the asymmetry vs the sysbox tier. After install, `importlib.metadata.version(name)` is checked per declared dep and any mismatch (silent skip, bundled-vs-pin drift) raises a fatal init error surfaced as the task's `error`.

Pyodide-incompatible wheels (native extensions outside the [pre-built Pyodide list](https://pyodide.org/en/stable/usage/packages-in-pyodide.html) and not available as pure-Python wheels via `micropip`) fail at register. `src/skills/pyodide-compat.ts` reads `pyodide-lock.json` from the installed pyodide package and verifies each declared `name==version` is either bundled exactly or has a pure-Python wheel on PyPI; mismatches reject the register with `tier1_incompatible_dependency`. Skills depending on native-only wheels must declare `tier: container`.

Worker init (Pyodide load + micropip install + version verify) is capped at 60s by default — a hung micropip resolve against a slow PyPI surfaces as `worker_init_timeout` instead of wedging the worker. Pyodide's built-in `packageCacheDir` covers the runtime's bundled packages only, so a skill with dependencies re-downloads them from PyPI on every worker boot today. The per-lockfile-hash, hash-checked wheel directory in [Tier-1 boundary](#tier-1-boundary-proposed) (layer 4) replaces micropip's fetch.

### Cache reachability

A `<hash>-py<X.Y>/` directory is reachable iff some `skills` row (enabled or disabled, since disabled skills can re-enable) has `lockfile_hash = <hash>` AND `<X.Y>` matches the reaper sandbox's own Python ABI. The reaper reads `PY_ABI` from `python3 -I -m cogmo_skills_runtime.abi` in its own sandbox and builds the expected reachable set as `<hash>-$PY_ABI` per row; candidate dirs are compared against that full-name set. Stale ABI variants (e.g. `<hash>-py3.14/` left behind after an image bump to py3.15) don't match the current expected set, so they're unreachable from the current runtime and sweep on the next reaper tick once they age past the 7-day grace window. Same logic reaps legacy bare `<hash>/` dirs left over from before the ABI suffix shipped.

`skills.lockfile_hash` is denormalised from git for cheap reachability queries — updated atomically in the same transaction that advances `git_sha`. LRU is the wrong policy on this volume: a rarely-used but live skill would lose its venv and pay a multi-second cold start on the next invocation. Reachability with a grace period is correct.

`.uv-cache/` (the wheel cache, not the venvs) is swept by `uv cache prune` on a separate cadence. Wheels are shared across many venvs and reachability is harder to compute (track which wheels each `requirements.lock` references); growth is bounded by `(name, version, platform tag)` distinct combinations and stays manageable at personal scale without aggressive eviction.

### Classifier inputs

The classifier reads `dependencies` directly from the manifest — not the lockfile. Transitive graphs are too noisy for the risk decision; the direct deps are what authors saw and what humans audit. Three categories live in `src/skills/ast-rules.ts` next to the existing effect rules:

| Category | Examples | Tier impact |
|-|-|-|
| **Allowlist** | `httpx`, `requests`, `pydantic`, `pyyaml`, `python-dateutil`, `markdown-it-py`, `beautifulsoup4` | All deps allowlisted → does not block `auto`. |
| **Notify** | Anything not on either explicit list — unknown but no known-bad pattern | Bumps to at least `notify`. |
| **Approve** | `boto3`, `paramiko`, `psycopg`, `stripe`, `requests-oauthlib`, anything matching `*-credentials` / `*-aws-*` / `crypto*` patterns | Today's table: `approve`. `[proposed]`: the `sensitive_dependency` reason, `approve` only when the owner opts into that class ([Risk tiers without a human](#risk-tiers-without-a-human)), else `notify`. |

A dependency added to a deployed skill widens its manifest, so the edit is not `auto` ([Risk tiers without a human](#risk-tiers-without-a-human), rule 4).

### Security posture

> **Precondition: tier-2 skills are mutually trusted code by the operator.** The shared `/skill-venvs` volume is mounted RW on every tier-2 worker under the same UID; any skill can write under `/skill-venvs/<other-hash>-py<X.Y>/` and pre-stage entries the next populator activates. Hash pinning at install time doesn't protect against this because the trivial bypass is `.ready`-pre-staging (creating the marker file + a stub Python layout at the path the populator will check) which skips `uv pip sync` entirely. The runtime venv (`/opt/cogmo-skills/.venv`) is outside the precondition: it is root-owned and read-only to the task UID, so a task cannot swap its `bin/python3`, first on `PATH` for the populate and reap scripts, or its `cogmo_skills_runtime`. Nothing writes there at runtime: its bytecode is compiled at build. Cogmo's v1 deployment model is single-operator with operator-authored / operator-audited skills; this section enumerates the threats accepted under that precondition. **Multi-author skill libraries require per-skill UID isolation (or per-hash bind-mount made read-only after publish) before the precondition holds.** `per-sandbox` backends share no `/skill-venvs/` across workers, so the pre-stage path does not exist there; across Cogmo instances on one host it does (`COGMO_SKILLS_DEPS_VOLUME`, below).

- **Hash pinning via `--require-hashes`** is non-optional **on the sysbox tier**. The lockfile carries SHA-256 per wheel; `uv pip sync` refuses to install anything unhashed.
- **WASM-tier dependency install trusts public PyPI without wire integrity verification.** `micropip.install` has no `--require-hashes` equivalent and fetches wheels from PyPI's JSON API over TLS with no per-wheel hash check. A flash-malicious release between register (when uv pinned the resolution) and the first WASM-tier invocation gets installed silently — the lockfile-hash byte-compare at register catches *staleness*, not *integrity at fetch time*. Mitigation today: post-install version verification (catches silent skips and bundled-vs-pin drift) plus narrow classifier tier-bumps for security-relevant deps so anything sensitive lands on `tier: container`. The host-fetched, hash-checked wheel directory of [Tier-1 boundary](#tier-1-boundary-proposed) (layer 4, todo.md → Skills autonomy S2) closes it `[proposed]`.
- **`--only-binary=:all:`** forbids sdists by default. Sdists run arbitrary install-time code and need a build toolchain — both are surface the auto tier should not provide.
- **Public PyPI for v1.** Hash pinning makes the index untrusted-but-verified. A private pull-through mirror (Devpi / Bandersnatch) is the obvious next step when (a) the user base widens beyond single-operator or (b) we want quarantine windows on new package versions to catch flash-malicious publishes. `[research]`.
- **PEP 740 / Sigstore attestation verification.** 132k+ packages had attestations by Mar 2026 via PyPI Trusted Publishing. Verification via `pypi-attestations` is "free defense in depth" once the mirror is in place. `[research]`.
- **`COGMO_SKILLS_DEPS_VOLUME` is `shared-volume`-only and multi-instance deployments must override per-deployment.** The default `cogmo-skills-deps-cache` is right for single-tenant single-host installs. Two Cogmos on the same Docker host using the default name share one cache, so the pre-stage path above spans every instance instead of every worker. Multi-instance operators scope per-deployment (`...-staging` / `...-prod`). The variable is ignored on `per-sandbox` backends, where each sandbox's cache is container-local.

## Cost tracking `[proposed]`

Two cost surfaces, measured separately.

**Compute** `[confirmed]`. `skill_runs.resource_usage` (`SkillRunResourceUsageSchema`) carries `wallClockMs`, always set from `finishedAt - createdAt`, and `peakMemoryBytes`. Tier 2 sets the latter in `runner.py` from `getrusage(RUSAGE_SELF).ru_maxrss * 1024` (Linux reports kilobytes) before `task_result`. It is null on tier 1, where `getrusage` is process-wide and would inflate under concurrent workers, and on every tier-2 result the host synthesises (wall-clock kill, a dead task process, `task_exited_without_result`, the watchdog), since none of them sees the task's rusage.

**External cost**, what Cogmo pays for:

- **LLM tokens** through `ctx.llm.complete()`, metered per call against the model's pricing and attributed to the run once `ctx.llm` exists ([Not in v1](#not-in-v1)). A direct SDK call from skill code is invisible to Cogmo.
- **Paid third-party APIs**: `cost_per_call_usd` in `SKILL.md` (default 0), summed per run. Bandwidth and storage are not tracked.

**Budgets: unbuilt, and no slice owns them.** `budget` (`daily_usd`, `monthly_usd`, `per_invocation_usd_cap`) parses (`SkillBudgetSchema` in `types.ts`) and nothing reads it: no dispatch is refused and no cron skill is suspended over cost. Enforcement is designed with `ctx.llm`, the first metered surface. Until then the only cost rule is the classifier's: rule 4 of [Risk tiers](#risk-tiers-without-a-human) keeps a skill with a nonzero `cost_per_call_usd` out of `auto`, and today's classifier reads no cost.

### Recovery

If an auto-applied skill misbehaves:

- **`/disable <skill>`** — channel command disables immediately (sets `skills.disabled = true`; running tasks finish, no new invocations accepted). Idempotent on already-disabled rows.
- **`/enable <skill>`** — re-activates a previously disabled skill. Refuses with a "no live deploy" message if the skill was never live at its current sha (denied-on-first-deploy guard above).
- **`/skills`** — operator inventory: lists every registered skill (enabled + disabled, with marker), tier, risk tier, short git sha. Discovery surface for the other two commands.
- **`/rollback <skill>`** — back to the prior deploy's version (Deploy lifecycle).
- **Auto-disable** `[proposed]` on defect-class failures ([Notifications and undo](#notifications-and-undo)).

## Invocation `[confirmed]`

Skills are invoked three ways:

| Trigger | Source | Handling |
|-|-|-|
| **Manual (agent tool)** | LLM calls the skill's own tool (one tool per skill — see below) | The tool handler calls `runner.invoke` inside its durable tool step → dispatcher → worker → result returned to the LLM |
| **Cron** | Inngest cron, one per scheduled skill | Dispatcher → worker. Result handled by skill itself (posts to channel, writes memory, etc.) |
| **Event-driven** (future) | Inngest event subscription | Same path as cron |

Manual invocations are synchronous from the LLM's perspective — tool result returned before the next turn. Cron invocations are fire-and-forget; skill output is whatever side effects the skill itself emits.

### Run-as identity `[confirmed]`

Every run acts for a user: `ctx.user()` returns them, and `ctx.memory` / `ctx.files` go through a scoped `Service` built for them (`SkillRunner.invoke({ runAs })`). `ctx.memory` gets exactly what the agent's own memory tools get — the profile's `memoryScope`, the restricted-class exclusion, and writes staged in `pending_memories` for the Observer. `ctx.files` is the deployment-wide workspace (see [File workspace](#file-workspace-proposed)).

| Trigger | Runs as |
|-|-|
| Agent tool | The turn's user, through the turn's scoped `Service`. |
| `cogmo skills run` | The install owner with the default profile. |
| Cron | `skills.run_as_user_id` / `run_as_profile_id`, built by `resolveSkillRunAs` inside the fire's `dispatch` step. |

The cron identity is set iff the schedule is live — `schedule` set on an enabled row (`chk_skills_run_as_iff_live_schedule`). Whoever puts a schedule live is who it runs as: every deploy and every `/enable` that does so writes the identity afresh, so code never runs as whoever vouched for the code before it, and disabling or dropping the schedule clears it. Each request names its origin (`SkillDeployOrigin`); none falls back to the owner by omission.

| Request | User | Profile |
|-|-|-|
| `register_skill`, or a skill-repo coding task's auto-register | The requesting conversation's user | That conversation's profile |
| Approval tap, or `/enable` | The user who acted | The profile of the conversation the chat's active session points at, when that conversation is theirs; otherwise the default |
| CLI `register` / `approve` / `rollback`, or a coding task with no conversation | The install owner | The default profile |

A user's persona is known only from a conversation of theirs. The approval keyboard is posted into the requesting conversation's chat, so a tap there by the requester takes the requesting profile while the chat's session still points at that conversation; after a boundary or expiry it takes the new conversation's profile, or the default when the chat has no session. For a scheduled skill, the approval prompt shows the pending deploy's schedule and says it will run as whoever approves, and the `/enable` reply says the schedule now runs as the enabler.

A cron run's `ctx.memory.remember` waits in `pending_memories` until the Observer next drains that user's rows, on a `conversation/idle` long enough to pass the `too_short` gate. A user who rarely chats sees a scheduled skill's writes late.

### One tool per skill

Each registered skill is its own entry in the model's tool list: the skill's `name` is the tool name, its `description` the tool description, its `inputs` schema the tool's JSON Schema. There is no generic `invoke_skill` wrapper, so the model sees `summarize_email` with its one-line description. The list is rebuilt each turn from `SkillRunner.listToolDefs()` (`listing.ts`), so a skill registered since the last turn appears and a disabled or rolled-back one disappears. `buildSkillToolSpec` (`skill-tool-builder.ts`) gives each a handler that calls `runner.invoke` inside its durable tool step, as the turn's user, through the turn's scoped `Service`.

A run's output reaches the model as JSON in the tool result. Binary output waits on `ctx.attachments` ([Not in v1](#not-in-v1)), which uploads to `AttachmentStore` and returns paths the outbound path delivers, as [image-generation.md](image-generation.md) does.

### Skill discovery at LLM time

**v1: progressive disclosure**, the SKILL.md standard ([integrations.md](integrations.md)):

- **Always loaded**: each skill's name and one-line description in the tool list, about 50 tokens a skill, so under 50 skills the list stays under about 2.5k tokens.
- **Loaded on selection** `[proposed]`, owned by no slice: when the model picks a skill, Cogmo swaps the full `SKILL.md` body (about 500 tokens) into that tool's description for the turn's later calls.
- **Loaded on demand**: data files and reference assets, read by the skill's own code at runtime.

**Later: retrieval.** Above about 100 skills, a `search_skills(query)` tool over embedded descriptions surfaces the top k per turn. Add it when tool-list tokens pass about 5k or selection accuracy drops on evals.

### Cron skill failure handling

See [Run failures](#run-failures): the `error_kind` class decides retry, notification and auto-disable.

## Host context (`ctx`) `[confirmed]`

Skills receive a host context object as the second argument to `run()`:

```python
# skill.py
async def run(inputs, ctx):
    webhook = await ctx.secrets.get("slack_webhook")
    await ctx.memory.remember("posted the morning digest to Slack")
    return {"posted": True}
```

With [Contracts](#contracts-proposed), `inputs` and the return value become pydantic `Input` and `Output` models.

`ctx` is a thin Python SDK shipped into every skill worker: tier 1 runs `src/skills/worker-wasm/py/ctx.py` in the Pyodide globals the skill body shares, and tier 2's lives in `cogmo_skills_runtime/runner.py` in the image. Each method is an async RPC back to the host over the channel that dispatched the task: tier 2's stdin/stdout pipe, tier 1's worker `MessagePort`. This mirrors the TS `Service` pattern used by in-process tools — same shape, projected over a pipe.

### v1 surface

The methods in `CTX_METHODS` (`ctx-handler.ts`), on both tiers:

| Method | Purpose |
|-|-|
| `ctx.secrets.get(name)` | Fetch a declared secret value (manifest-gated) |
| `ctx.memory.recall(query, ...)` | Semantic search of the run's user's memory, under the run's profile scope (see [Run-as identity](#run-as-identity-confirmed)) |
| `ctx.memory.remember(content, ...)` | Stage a fact in `pending_memories` (`source = 'skill'`) for the Observer to classify and retain; Hindsight's `metadata.skill` names the skill. The skill's name and tags reach the Observer as context, not as memory tags. |
| `ctx.files.read(path)` | Read UTF-8 text from the workspace (see [File workspace](#file-workspace-proposed)) |
| `ctx.files.write(path, content)` | Create or overwrite workspace file |
| `ctx.files.list(prefix=None)` | List workspace entries |
| `ctx.now()` | Canonical time (mockable in tests) |
| `ctx.user()` | The run's user — `id`, and the deployment's `timezone` (`USER_TIMEZONE`) |
| `ctx.log.info(msg, **fields)` | A structured line in Cogmo's log, tagged with the run id and skill name, which the skill cannot overwrite |
| `ctx.http.request(method, url, ...)` | Outbound HTTP performed by the host; `get` / `post` wrap it. Tier 1's only network path — Pyodide has no sockets, so `httpx` and `requests` cannot run there. Present in tier 2 as well, so a skill does not break when adding a dependency moves it across the boundary; tier 2 may use `httpx` directly instead. Returns `{status, headers, body}`; a 4xx/5xx is a value, not an exception. Every destination must appear in the manifest's `network.allow` list, checked on the hostname ahead of resolution — a skill with no `network:` block reaches nothing. `http`/`https` only, capped at 5 MiB, and timed out under the skill's own `wall_clock_s` so a hung request stays catchable. Redirects are not followed — the 3xx comes back with its `location` so the next hop is a fresh, separately-checked call. Destinations resolving to a non-public address are refused (`isBlockedAddress` in `src/util/blocked-address.ts`, shared with `fetch_url`): `fetch` runs in the host process, so without it a skill would reach internal services a tier-2 sandbox cannot see. Residual: `fetch` resolves the name again, so DNS rebinding between the check and the connection is open until connections are pinned to the checked address. Audited to `skill_context_calls` by origin and path, never the query string. `[proposed]` (S6): the [Egress proxy](#egress-proxy-proposed) listener takes over the allowlist, the address guard, pinning and the audit, and its `skill_egress` row replaces the `http.request` context-call row. |

Every RPC: validates against the skill's manifest (allowlists, permission scopes) → executes → logs to `skill_context_calls` (`[proposed]` (S6): `http.request` to `skill_egress` instead, by the proxy) → returns a result or raises `CtxError` with a `kind`.

### Not in v1

| Method | Status |
|-|-|
| `ctx.attachments.upload(data, media_type)`, `ctx.attachments.download(path)` | Planned: binary output through `AttachmentStore` |
| `ctx.llm.complete(prompt, model=...)` | Planned: Cogmo's provider routing, metered for [Cost tracking](#cost-tracking-proposed) |
| `ctx.notify(channel, message)` | Planned: a message to the run's user on their channel |
| `ctx.files.delete(path)` | Planned with the [POSIX shim](#per-tier-posix-shim--stage--reconcile-proposed) |
| `ctx.metrics.*` | Deferred: `ctx.log` covers visibility at personal scale |
| `ctx.skills.invoke(other_skill, ...)` | Deferred: no inter-skill composition (below) |
| `ctx.schedule(when, event)` | Deferred: schedules are declared in `SKILL.md` |

### File workspace `[proposed]`

`ctx.files.read`, `write` and `list` are built, over the S3-backed `service.files` store the agent's `read_file` / `write_file` / `list_files` tools use, so the model and skills see one workspace. It is deployment-wide, keyed by the logical path; the per-user prefix is designed, not built (todo.md). `files.delete` and the POSIX shim below are proposed, and no Skills-autonomy slice owns them (todo.md, p3).

**Text only.** The workspace holds UTF-8 text; binary output goes through `ctx.attachments` once it exists.

| Store | Use when | Properties |
|-|-|-|
| `ctx.files` | Named, mutable, listable text — notes, drafts, CSV, summaries | Logical paths, S3-backed |
| `ctx.attachments` | Binary blobs, write-once outputs — PNG, PDF | Opaque path token, no listing, immutable once uploaded |

**Two access paths** `[proposed]`, over one ACL boundary (`Service["files"]`) and the same `reads_filesystem` / `writes_filesystem` effects. POSIX (`open("/files/notes.md")`, `pathlib`, `pandas.read_csv`) is the default for anything that takes a path. The RPC serves live writes that need cross-task visibility, and files too large to stage.

| Method | Returns |
|-|-|
| `ctx.files.read(path)` | `str`; raises `CtxError` if missing |
| `ctx.files.write(path, content)` | `None`; creates or overwrites |
| `ctx.files.list(prefix=None)` | entries with `path`, `size`, `last_modified` |
| `ctx.files.delete(path)` `[proposed]` | `None`; idempotent |

Paths are logical (`notes/meeting.md`). The 100 KB cap on `ctx.files.read`, matching the agent's `read_file`, keeps a large string out of a tool result the model re-reads. POSIX `open()` would not inherit it and is bounded by the substrate: MEMFS by worker memory, the relay's directory by its mount size. Writes have no cap beyond S3's object limits.

#### Per-tier POSIX shim — stage + reconcile `[proposed]`

Each tier exposes the workspace at `/files` through a private substrate per task, staged before the task runs and reconciled to S3 after it exits. The host owns the loop; the skill is unaware.

Stage-in lists the user's prefix through `Service["files"].list`, reads each entry, writes it to the substrate and records `path → sha256(content)`. Reconcile walks the substrate, computes the same map and diffs it: a new or changed path is written through `Service["files"].write`, a path missing from the substrate is deleted through `Service["files"].delete`, an unchanged one is skipped. Hashing content, not mtime, skips files a skill only read, and works on MEMFS, which has no real mtime.

| Tier | Substrate | Stage in | Reconcile out |
|-|-|-|-|
| WASM (Pyodide) | Pyodide MEMFS, per task | `pyodide.FS.writeFile` per entry | walk `pyodide.FS`, read changed paths |
| Sysbox (local Docker) | a per-task directory the relay owns inside the worker, mounted at `/files` for the task process | the host sends the staged set over the task's channel; the relay writes it before it forks the task | after the task process exits, the relay returns the changed paths over the channel and removes the directory before the worker's next task |

Staging is per task, never per container: a warm worker serves many tasks and skills ([Shape](#shape-confirmed)), so nothing is staged at container start or reconciled at container stop. One host-side loop drives both tiers through a `TierFs` interface (`stage`, `reconcile`); only the substrate adapter differs. The mount is `/files` because `/workspace` is the coding-delegation worktree.

**Designed with the shim, unspecified until then:** whether a failed task's writes publish; a reconcile that fails partway, leaving some paths published; and a worker that dies before reconcile, which loses the task's POSIX writes. Each gets a row in the run transition table before the shim ships.

**Why staging, not a live mount.** FUSE (`s3fs-fuse`, `rclone mount`) needs `CAP_SYS_ADMIN`, `/dev/fuse` and S3 credentials inside the container, and `s3fs-fuse` has open OOM and whole-object-rewrite bugs. A SharedArrayBuffer-backed Emscripten FS for Pyodide needs a third worker thread and a hand-rolled protocol. Staging keeps credentials on the host and needs no kernel privilege. JSPI-backed Pyodide FS hooks ([pyodide #5720](https://github.com/pyodide/pyodide/discussions/5720)) or an opt-in `rclone` mount could later replace one tier's adapter behind `TierFs`.

#### Semantics

- **Within a task**, POSIX and the RPC are isolated: a POSIX write lands in the substrate, invisible to `ctx.files.read`, which reads S3; an RPC write lands in S3, invisible to `open()`. A skill picks one path per file.
- **Deletion:** `os.remove` removes the path from the substrate and reconcile deletes the object; `ctx.files.delete` deletes it at once. Delete-then-write in one task reconciles as a write.
- **Across sequential tasks**, A reconciles before B's stage-in, and S3's read-after-write consistency (AWS, MinIO, R2) makes B see A's writes and deletions.
- **Across concurrent tasks**, each has its own substrate, and the last reconcile wins on a path both changed, a delete included. **Residual**, narrowed by the per-user throttle on most flows and by the RPC for live visibility. An etag check at reconcile, surfacing a conflict instead of overwriting, can be added without changing the shape.
- **Stage-in costs** `O(workspace size)` per task, small at personal scale. Past a few hundred MB, stage only the prefix a skill declares, or keep large files RPC-only.
- **No locking:** `ctx.files.write` creates or overwrites, with no append, and read-modify-write races are the caller's. Skills coordinating on one file pass state through return values or `ctx.memory`.

### Inter-skill composition

**Not in v1.** Skills are flat: the agent composes them by calling one, reading its result and calling another, and state shared across skills lives in `ctx.files` and `ctx.memory`. A future `ctx.skills.invoke(name, inputs)` goes through the host: a new task through the pool, under the callee's own secrets, with a recursion cap, cycle detection and an audit row per call, and the callee's effective permissions the intersection of its own and the caller's. Direct imports between skills are rejected, since they break permission scoping and pool management; pure helpers shared between skills go in `skills/_shared/` or a pinned package.

### Secrets: pull model

1. `SKILL.md` frontmatter declares the allowlist:

   ```yaml
   secrets:
     - slack_webhook
     - github_token
   ```

2. At deploy time, every listed secret must exist in the `secrets` table.
3. At runtime, `ctx.secrets.get(name)` checks the manifest, reads the encrypted `secrets` row, returns the value (a placeholder for a bound secret, once the proxy substitutes: [Egress proxy](#egress-proxy-proposed) → Substitution) and records the access, by name, in `skill_context_calls`.
4. Rotation needs no change to skill code: the next `get` returns the new value.

What the host guarantees: Cogmo puts no secret in a worker's or a task's environment; writes none, of its own accord, to `skill_runs.inputs` or `output` or to a log (ctx replies are not logged at the framing layer, and `skill_context_calls` holds names only); and hands a secret to the worker only as the reply to the skill's own `get`. None of this binds the skill's code. A skill holding a raw secret has the plaintext and can return it, log it through `ctx.log`, write it to memory or a file, or send it to any allowed host, and nothing checks the value ([Risk tiers](#risk-tiers-without-a-human), rule 5). Scrubbing the exact values issued to a run from those sinks is p3.

### Cross-skill leakage in a shared worker

A task's processes, and the memory holding its inputs and ctx results, are gone before the next task on the worker starts; the supervisor that every task forks from never reads either (see [State reset between tasks](#state-reset-between-tasks-confirmed)). Successive tasks on one worker share the container filesystem: `/tmp`, `$HOME`, and the `/skill-venvs` cache, which tasks can write.

Accepted at personal scale because skills are Cogmo-authored and reviewed. Upgrade paths if the threat model changes:

- **Worker-per-skill-identity** — pool keyed by `(tier, skill_name)`. Skill X and Y never share a worker.
- **Recycle every task** — a fresh container per invocation: 1–2 s on sysbox, and the warm pool's benefit is gone.
- **microVM per task** — full cleanup, highest overhead.

### Secret exposure and egress control `[proposed]`

The pull model hands a skill the real secret. `ctx.secrets.get(name)` returns plaintext, gated only by the manifest's own `secrets:` list — the skill declares its own permissions — and skill bodies are LLM-authored. Today's table puts a tier-1 skill with no effects, no `network:` block and one or two declared secrets at `auto`, which the tier-1 cap ([Tiers](#tiers)) lowers only to `notify` while `tier1Hardened` is unset: either way it deploys with nobody reading it.

Reading a secret is half of an exfiltration; the other half is a route off the machine, which is what `ctx.http` supplies. Neither half is wrong alone, and both are wanted. This section is the plan for holding them together safely.

**What the field does.** Credential injection at an egress boundary: the workload holds an opaque placeholder, and a component outside it substitutes the real value on requests to the bound destination ([Modal](https://github.com/modal-labs/credential-injection), [Cloudflare Sandbox](https://blog.cloudflare.com/sandbox-auth/), [LangSmith's Auth Proxy](https://www.langchain.com/blog/how-auth-proxy-secures-network-access-for-langsmith-agent-sandboxes), [Nous's iron-proxy](https://hermes-agent.nousresearch.com/docs/user-guide/egress/iron-proxy); Anthropic's [Managed Agents vaults](https://platform.claude.com/docs/en/managed-agents/vaults) support no environment-variable credentials in self-hosted sandboxes, because substitution needs egress the platform controls). With it goes default-deny egress under a per-workload allowlist, enforced below the application and connecting to the address it checked; OWASP's Agentic Top 10 names allowlisting a precondition for running model-authored code (ASI05).

**Why one proxy.** `ctx.http` enforces the allowlist only for traffic that chooses it. Tier 1 reaches `js.fetch`, and tier 2 has raw sockets through `httpx`, so neither tier is bound by its manifest's `network:` block today. A placeholder that fails harmlessly over a raw socket protects the secret but leaves the allowlist unenforced. One egress proxy, the only route out for both tiers, enforces the allowlist, substitutes bound secrets and audits every request.

**Stages.**

| Stage | What | Status |
|-|-|-|
| 1 | Declared egress, default deny, on `ctx.http` | `[confirmed]`: built; tier 1's `js.fetch` and tier 2's raw sockets bypass it |
| 2 | Egress proxy: the one route out for both tiers, per-run credentials, pinning to the checked address, audit | `[proposed]` |
| 3 | Bound secrets as placeholders, substituted at the proxy, with token exchange | `[proposed]`; `binding` parses and is ignored today, so a deploy that needs it is `blocked` (`binding_unenforced`), which Override refuses ([Risk tiers](#risk-tiers-without-a-human), rule 2) |

**Stage 1 — declared egress, default deny.** A `network:` block in `SKILL.md` names the hosts a skill may reach; without one, `ctx.http` refuses every destination. An entry is a hostname, or `*.` and a zone, which admits any host under the zone at any depth but not the apex; a lone `*` does not parse. A wildcard over a zone that carries third-party labels admits them too, so name hosts exactly where a zone is shared. Matching runs on the hostname before resolution, so an unnamed destination never becomes a DNS query; the address guard then refuses a named host that resolves inward.

The allowlist is the load-bearing control: it bounds where a credential can travel even while the skill holds it in plaintext, which is why the proxy enforces it for both tiers before it substitutes anything. **Residual:** on a host many tenants share (api.github.com, hooks.slack.com, `*.googleapis.com`), the attacker chooses an account or a path on an allowed host instead of a host. A path-prefix allowlist for `raw_secret` and `reads_and_egress` skills is p3.

#### Egress proxy `[proposed]`

One enforcement point for every byte a skill sends off the machine: a token-injecting forward proxy inside `cogmo serve` (`src/skills/egress/`). Placeholder minting is the primitive it shares with `ctx.secrets.get`. It carries stages 2 and 3: allowlist, pinning, substitution, token exchange and audit live here, for both tiers.

**One path.**

- Tier-2 workers run on an internal Docker network (`Internal: true`), which has no default route. That is the enforcement: no `iptables`, and nothing to bypass by unsetting `HTTP_PROXY`, `HTTPS_PROXY` or `NO_PROXY`, which are set for convenience. Verify sessions and register's import session join the same network under the verify credentials (below). Two other surfaces a worker reaches are settled before the classifier reads `tier2EgressEnforced = true`:
  - **The Docker API proxy socket**, which every Local-Docker session mounts today, and through which a skill could start a container off the internal network (`sandbox/supervisor.ts`; [sandbox.md → Proxy Design](sandbox.md#proxy-design)). Workers, verify sessions, the import session and reviewer sessions ([Review stage](#review-stage) → Reviewer sandbox) are created with `SessionSpec.dockerSocket: false`, which the Docker API proxy's slice 2 (ownership) adds, so S7 depends on it.
  - **Cogmo's other listeners.** Cogmo is attached to the internal network, so every listener in its process that binds all interfaces answers there: the web UI (`WEB_HOST`, `WEB_PORT`, default `0.0.0.0:9090`, behind session auth) and, under `INNGEST_MODE=serve`, the Inngest serve endpoint (`INNGEST_SERVE_PORT`, behind the signing key, which `INNGEST_DEV` turns off). **Residual:** a tier-2 skill reaches both, gated only by their auth; `tier2EgressEnforced` is false under `INNGEST_DEV` with `INNGEST_MODE=serve`.

  An integration test connects directly from a worker and from a reviewer session, with the proxy variables unset, to an outside address, to the Docker socket path and to each of Cogmo's ports, and requires each attempt but the egress listener to fail or be refused by that listener's auth. The flag is set only on a build where it passes.
- `ctx.http`, which the host performs for tier 1 and for tier 2's RPC, is a forward-proxy client of the same listener: a plain absolute-URL request carrying the run's credential, forwarded upstream under the scheme the call named, so the client needs no trust in the Cogmo CA. Allowlist, pinning, substitution, shadow and audit have one implementation, and the proxy writes the call's `skill_egress` row; `ctx.http` writes no `skill_context_calls` row for it. The client keeps its per-call rules: the response shape, the 5 MiB cap, the timeout, `redirect: manual`, and the mapping of the proxy's own replies to `CtxErrorKind`, by the reason in the `x-cogmo-egress` header every synthesised reply carries: `shadowed` is a value, returned as `{status, headers, body}`; `host_not_allowed`, `blocked_address` and `not_http` raise `blocked_destination`; `too_large` on a request raises `request_too_large`, added to `CtxErrorKind`; `credential_revoked`, `credential_unavailable` and `upstream_error` raise `network_error`. A connection the tunnel cuts reaches the client as a reset, `network_error`, unless the client's own decoded-body cap or timeout fired first. mockttp's own `502` for an upstream connection error carries no reason header, so `ctx.http` returns it as a value, like an upstream's `502`; its audit row says `upstream_error`.
- Dependency populate, the lockfile compile and the verify session reach the package index through the proxy under their own credential classes (below).
- mockttp binds every interface. When `cogmo serve` runs in a container, that is the internal network and the compose network, with nothing published. On the host it is every interface, reachable from the LAN and the tailnet, so the listener starts there only under `COGMO_SKILLS_EGRESS_HOST_LISTENER=1`; without it the proxy does not start, the classifier reads `egressListener = false` and `tier2EgressEnforced = false`, a `network:` block of either tier is `blocked` at register while `reviewPanel` is on, since rule 2 exists only with the panel ([Risk tiers](#risk-tiers-without-a-human)), and `ctx.http` has no route and fails every call `network_error`. **Residual** while `reviewPanel` is off, which a deployment without a second family is for good: a flagless host deploys `network:` skills and `ctx.http` fails their runs. todo.md → Skills autonomy S7 confirms the host case under rootless and rootful Docker and asks mockttp upstream for a bind address, which retires the flag.
- **Unauthenticated load, in every deployment.** A client that reaches the listener without a credential (any tier-2 task or verify session in a container deployment; the LAN and the tailnet behind the host flag) completes TLS handshakes before its `407`, has the proxy mint a leaf certificate for each name it sends, and holds up to the request cap in memory per connection. S6 bounds it, and its integration test pins each bound: the leaf cache is an LRU of fixed size; a name on no live allowlist (an enabled skill's, the package index hosts, an open verify attempt's spec) gets no leaf, so its handshake fails; connections are capped per credential and in total; and the tunnel's DNS lookup and connect each time out. The proxy shares the agent's process and event loop by the owner's choice ([Decisions](#decisions)), so these bounds protect the agent too.
- Non-HTTP protocols have no route ([Decisions](#decisions) → Non-HTTP egress).
- Tier 2 runs on local Docker only ([Warm pool](#warm-pool-confirmed)). A managed backend Cogmo cannot attach to an internal network has no egress control, so the classifier reads `tier2EgressEnforced = false` there: bound secrets are unavailable and a `network:` block is `blocked`, until the provider offers an egress hook the proxy can sit behind.

**Per-run identity.** No credential, no egress.

- The credential is `<class>.<subject fields>.<mac>`: the class, its subject fields in the order the credential-classes table lists them, and `mac`, HMAC-SHA256 of everything before it, every subject field, the draftless register's expiry among them, under a key derived from the master key (HKDF, purpose `skill-egress`, [infrastructure.md](infrastructure.md)). Fields are dot-separated and none holds a dot: UUIDs, integers, enum values, a sha, an epoch-second expiry, and a skill name, which `SkillManifestSchema` keeps to `[a-z][a-z0-9_-]*`. The rules parse the class to pick a rule; admission verifies the MAC for the class claimed, then checks the subject against durable state. Every subject is durable (a `skill_runs` row, a draft's attempt or round, or a draftless register's name, tip and expiry), so nothing stores the credential and a restarted proxy needs no map.
- The relay puts it in the task process's environment and proxy URL, never in the container's. The URL is mockttp's metadata form, `http://metadata:<base64url({"tags":["<credential>"]})>@<proxy>`, which httpx and requests send as `Proxy-Authorization` on each `CONNECT`, and on each plain-`http` request (Implementation, below). A pool worker's next task gets the next run's credential.
- A `run` request is admitted only while its run is at `recovery_point = 'dispatched'`, a `populate` request only while it is at `started`, before dispatch (`dispatched` is S3's, [Run failures](#run-failures) → Stuck runs). The proxy then loads the run's skill at the run's `git_sha` for its allowlist and bindings. `transitionToExecuted` revokes the credential by moving the row, and the proxy refuses the run's next request. A request already in flight carries no further secret, since substitution is in the request line and headers, already sent; it ends when its client socket closes, which the task process's exit does and `ctx.http` does by aborting its request when the run ends, and at the tunnel's class timeout at the latest. mockttp drops the upstream connection as soon as the client's closes. Admission is cached per class: a `run` admission until `deadline_at` and a `populate` admission until dispatch, each invalidated in-process by the run's next transition, the sweeper's included; a verify-class admission never, so every verify request re-reads its attempt's phase in one indexed read.
- A new run means a new credential. The task process can read its own credential; that is the trade for pool workers that need no per-task network setup, and it is bounded because a credential opens only its own run's allowlist, and only while the run is in flight.

**Credential classes.**

| Class | Subject fields | Admitted while | Allowlist | Limits |
|-|-|-|-|-|
| `run` | `<runId>` | the run is at `dispatched` | the skill's `network.allow` at the run's `git_sha` | 5 MiB + 64 KiB per response and 130 s per connection, enforced by the tunnel as the backstop behind `ctx.http`'s 5 MiB decoded-body cap and 120 s timeout, which fire first, and as the only limit on tier-2 sockets |
| `populate` | `<runId>`; the class keeps it apart from the run's `run` credential | the run is at `started` | the configured package index hosts | 512 MiB per response, 10 min, enforced by the tunnel |
| `verify_install` | in a draft, `draft.<draftId>.<round>.<attempt>.<phase>.<generation>` (`verify_resets`); for a register outside a draft, `register.<skillName>.<tipSha>.<phase>.<expiresAt>` | the attempt is at the token's phase and generation: `install` with the draft `verifying` at that attempt, or `register_install` with it `registering`; for a draftless register, until the register call revokes it in-process before the import, or its 10-minute expiry. **Residual:** a restart forgets the in-process revocation, so the token is live again until it expires | the configured package index hosts, forwarded | 512 MiB per response, 10 min, enforced by the tunnel |
| `verify_code` | as `verify_install` | the attempt is at the token's phase and generation: `code` with the draft `verifying`, or `register_code` with it `registering`; for a draftless register, until its expiry | the spec's hosts (a draftless register: the manifest's), answered in shadow and never forwarded; nothing else | none: nothing is forwarded |
| `review` | `<draftId>.<round>.<reviewer>`, for a reviewer session ([Review stage](#review-stage) → Reviewer sandbox) | the draft is `reviewing` at the token's round, for that reviewer | the backend's model API hosts only, forwarded | none beyond the review session's 10-minute wall clock |

Before S10 the verify classes admit only a draftless register's in-process phases ([Verify phases](#verify-phases)).

A verify sample call has no run: its recording `ctx` ([Verify stage](#verify-stage)) answers `ctx.secrets.get` with a fixed placeholder, so the placeholder needs no `runId`.

**TLS.** The proxy terminates TLS for `CONNECT` with a Cogmo CA, which S6 mints at setup, or at boot when none exists (`generateCACertificate`), and keeps in the secrets store, and hands to mockttp as its `https` key and certificate.

- The skills image is public, so the CA cannot be baked into it. Each worker gets the system bundle plus the CA as a read-only mount, with `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE` pointing at it, which httpx and requests both honour.
- mockttp mints a leaf certificate per host on first use and caches it, in a bounded LRU (One path → Unauthenticated load).
- Upstream, the proxy sends the hostname as SNI and verifies the destination's real certificate against that hostname and Node's root store.
- A client that pins its own CA fails closed, as it should.

**CA rotation** `[proposed]`, S6's. The unit is a CA generation: an `egress_ca_generations` row with an `egress_ca_status` (`active | retiring | retired`; at most one `active` and one `retiring`), and its key and certificate in a secrets row. mockttp signs with the generation that was `active` when the listener started. A worker or session mounts a bundle of the system roots plus every generation not `retired`, written to a new file per set of generations, so earlier mounts keep theirs.

| Transition | Guard | Writes |
|-|-|-|
| none → `active` | setup, or boot, holding the bootstrap lock ([setup.md → Concurrent runs](setup.md#concurrent-runs)) before its transaction; no generation exists | generation 1 and its secret, in one transaction |
| `active` → `retiring`, and a new generation → `active` | `cogmo skills rotate-egress-ca`; no `retiring` row | the new generation, its secret and the old row's status, in one transaction |
| `retiring` → `retired` | `cogmo serve` boot, before the listener and the pool start | the status |

A rotation takes effect at the next `cogmo serve` start, which the command says. Until then the listener signs with the old CA, and a worker started meanwhile trusts both. The restart's shutdown drains the pool and the verify sessions under the serve shutdown bounds, and the new process starts on the new key with an empty leaf cache and only new workers.

| Failure mode | State left | Why it is safe, or the residual |
|-|-|-|
| Setup and boot mint at once | one generation | both hold the bootstrap lock, a session lock taken before the transaction, so the second's snapshot holds the first's generation and it mints nothing; without it the second would hit `generation` UNIQUE with a `23505` the transactor does not retry |
| The command fails before its commit | unchanged | one transaction |
| `cogmo serve` crashes after the commit | new `active`, old `retiring` | the next boot completes the rotation, as a planned restart does |
| A boot crashes after retiring the old row, before the listener starts | old `retired` | the next boot starts the listener on `active`; nothing still running trusts only the old CA |
| A second rotation before the restart | refused | its guard: a `retiring` row exists |
| The master key rotates | each generation's secret re-encrypted with the rest | [infrastructure.md → Master-key rotation](infrastructure.md#master-key-rotation-proposed) |

**Implementation.** [mockttp](https://github.com/httptoolkit/mockttp), the intercepting engine behind HTTP Toolkit, runs in-process. It owns the wire: leaf certificates under the Cogmo CA, `CONNECT`, TLS on both sides, HTTP/1.1 and chunked bodies. Cogmo owns the policy and the upstream connection, in TypeScript against its own stores, split as the Docker API proxy is ([sandbox.md → Proxy Design](sandbox.md#proxy-design)):

- **One passthrough rule per credential class**, matched on the class the credential names and marked `always()`, then a last rule that answers `407`. Each class rule's `beforeRequest` calls a pure policy function of the request and the admission state and returns either the request to forward (placeholders substituted, `Connection: close` added so one upstream connection carries one request, whatever credential the downstream connection carries next) or a reply sent without forwarding: `407`, `403`, `413`, a shadow reply, each with an `x-cogmo-egress` header naming its reason. No rule sets a response hook, so every response streams to the client. mockttp buffers a copy of each request body for its matchers and hooks, and of each response body for its events, up to `maxBodySize`, which is set to the request cap (5 MiB); Per request step 2 refuses what that copy cannot hold. No WebSocket rule exists, so mockttp refuses an upgrade with `503`; `http2` is off, so the listener speaks HTTP/1.1; `passthrough` and `tlsPassthrough` stay unset, so an unknown protocol on the listener is refused; `recordTraffic` is off.
- **The pin tunnel.** mockttp never resolves a destination. Each class rule names, as its upstream proxy (`proxyConfig.proxyUrl`), an in-process `CONNECT` server on loopback, with the class as the URL's user name and a per-boot random token as its password; a `CONNECT` without the token is refused, so no other local process can use the tunnel. For each `CONNECT host:port` the tunnel resolves the host with `dns.promises.resolve4` and `resolve6` (the resolver, not `getaddrinfo`: no threadpool, no `/etc/hosts`), requires every address to pass `isBlockedAddress` (an IP literal is checked as itself), connects to one of them, and pipes bytes while counting them in both directions, TLS overhead and headers included, the upstream-to-client count against the class's response cap, and timing the connection against its limit. A connection over either is cut with a TCP reset (`resetAndDestroy`), so the client sees `ECONNRESET` and never a complete-looking close-delimited body. A refused host is answered `403` with `x-cogmo-egress: blocked_address`, which reaches the client intact. SNI and certificate validation happen in mockttp, against the hostname, through the tunnel. The tunnel keeps a short in-memory log of its refusals, cuts and byte counts, by class, host and time, for the audit.
- **The rest.** Admission and its caches, the `skill_egress` audit, and custody of the CA.

The credential rides in mockttp's metadata channel: `Proxy-Authorization: Basic <base64("metadata:" + base64url({"tags":["<credential>"]}))>`, read from the `CONNECT` for a tunnel or from a plain absolute-URL request, stripped before forwarding, and handed to the rules as the tag `socket-metadata:<credential>`. mockttp (Apache-2.0, Node ≥ 20, `@peculiar/x509` underneath) is the module's one runtime dependency, signed off under AGENTS.md → Autonomy. Its optional native dependency `tls-impersonate` stays unbuilt, out of `onlyBuiltDependencies`.

**Alternatives.** `mitmdump` as a child process, with a Python addon and a Unix-socket bridge, is the fallback if mockttp fails the integration test that drives the real listener (todo.md → Skills autonomy S6). A hand-rolled interceptor on `undici` and an X.509 library would rebuild the wire layer mockttp has run in production for years, Go or Rust MITM libraries add a second language and the same bridge, and Squid `ssl_bump` is configuration-driven, which makes per-run substitution awkward.

**Per request**, in order:

1. A request carrying anything other than exactly one `socket-metadata:` tag, or a credential that is missing or unadmitted, is refused with `407` when the request arrives: after the `CONNECT` and the client-side TLS handshake for a tunnel, on the request itself for plain `http`; no upstream connection is opened. **Residual:** a client without a credential can complete a TLS handshake and have a leaf minted (One path → Unauthenticated load); it reaches no upstream.
2. A request whose declared length exceeds the request cap, or whose buffer is empty under a `content-length` or `transfer-encoding` that announced a body, is refused `413` as `too_large`. An empty chunked body is refused with it, a residual for clients that send one.
3. A tunnel whose destination is not the request URL's host, the two compared after normalisation (lower case, no trailing dot, IPv6 brackets off), is denied as `host_not_allowed`: a `CONNECT` to an IP literal with another name in `Host`. The policy always returns the URL it checked, so mockttp connects to that host and no other.
4. For a `verify_code` credential, a request to one of the spec's hosts is recorded `shadowed` and answered with the shadow reply, before the allowlist check and before resolution; any other host is denied.
5. A host outside the credential's allowlist is denied before resolution, so it never becomes a DNS query.
6. The tunnel resolves the host and connects only to an address that passed `isBlockedAddress`, so the checked address is the connected one, and SNI and certificate validation use the hostname. This closes DNS rebinding for `ctx.http` and the proxy alike.
7. The scheme check (`http` and `https` only; [v1 surface](#v1-surface)) in the policy; the proxy never follows a redirect. The class's response cap and timeout are the tunnel's, on the one connection the request owns; a connection cut for either reaches the client as a reset and the audit row as `too_large` or `timeout`. An upstream connection error reaches the client as `502` and the row as `upstream_error`, from mockttp's `passthrough-error` tag.
8. Substitution, below.
9. Audit, below.
10. In a shadow run, a request the shadow rule covers ([Write requests](#write-requests-proposed)) is recorded `shadowed` and answered `202` with a fixed shadow body. Other requests are forwarded.

**Substitution.** Cogmo never hands a bound secret's plaintext to the worker: `ctx.secrets.get(name)` returns a placeholder, `cogmo-secret:<hmac(runId, name)>`, unique to the run.

- The binding names its `destination` (a URL pattern within the allowlist) and its `location`, an enum: `header` (the default: a named header, or the existing `header:` template) or `query` (one parameter). A request body is never a substitution site ([Decisions](#decisions) → Substitution sites). The proxy replaces the placeholder only in that location, only on a request to that destination.
- A placeholder anywhere else — another host, another location — is passed through unchanged, so it reaches the destination as an opaque string, and audited as `binding_misuse`.
- An unbound secret keeps the pull model and classifies as `raw_secret` ([Risk tiers](#risk-tiers-without-a-human)). It is the fallback for credentials no binding can place, such as a signing key the skill computes with.
- **Residual:** an upstream can reflect the substituted value back, a query parameter echoed in an error body or a `Location` header, and the response streams to the skill unmodified, since no rule sets a response hook. Redacting it would need one, which would end streaming, so it is p3 at most.

**OAuth refresh** `[proposed]`, specified here before S8 builds it. `exchange: oauth_refresh` makes the proxy trade the stored refresh token for an access token at substitution time, so no long-lived credential reaches the request.

- The secret's value holds the refresh token and what the exchange needs: the token endpoint, the client id and secret. The access token is cached in process, keyed by the secret's name and its row's nonce, so updating the secret invalidates it, and used until 60 s before its expiry.
- A refresh holds a lock per secret name, in process (one `cogmo serve` per database runs the proxy), across the exchange and the write-back. A request that needs the same secret waits, then uses the token the holder cached.
- A response carrying a new refresh token, from a provider that rotates on use, is written back to the secret, re-encrypted, and committed before the access token is cached or used.
- A refused grant (`invalid_grant`, or a 400 or 401 from the endpoint), an unreachable endpoint, a 5xx, a timeout, or a failed write-back refuses the request `502` with `x-cogmo-egress: credential_unavailable`, audited with that `failure_reason`; a refused grant also tells the owner to re-authorise the secret. A run that ends in error with such a row ends `credential_unavailable`, a pausing kind ([Run failures](#run-failures)).

| Failure mode | State left | Why it is safe, or the residual |
|-|-|-|
| Two requests need a refresh at once | one exchange | the lock; the waiter uses the holder's token |
| A crash after the provider rotated the refresh token, before the write-back commits | the stored token is the old one, which a rotating provider has revoked | the next refresh is refused `invalid_grant`, and the owner re-authorises. **Residual** |
| The write-back fails | the request refused | the new refresh token is lost as above; using the access token without storing its pair would only hide the loss until it expires |
| The secret is updated mid-run | the next request refreshes from the new value | the cache key includes the row's nonce |

**Audit.** Every proxied request writes one `skill_egress` row: its subject, exactly one of `run_id` (`run` and `populate`), `draft_round_id` (verify and review classes inside a draft) or the register subject `(register_skill_name, register_tip_sha)` (verify classes for a register outside a draft), and `credential_class`; `method`, `origin`, `path` (never the query string), request and response bytes, `status`, `outcome` (`forwarded | shadowed | denied | failed`), `failure_reason` (`skill_egress_failure_reason`, set iff `denied` or `failed`: `host_not_allowed`, `blocked_address`, `credential_revoked`, `credential_unavailable`, `not_http`, `too_large`, `timeout`, `upstream_error`, `client_aborted`), and `bindings` (`EgressBindingsSchema`: each secret name with `substituted` or `misuse`). The row is inserted before the request is forwarded and completed from mockttp's `response` and `abort` events: the status from the event, request and response bytes from the tunnel's counts, and for a cut connection the reason from the tunnel's log, matched by class, host and the request's lifetime (**residual:** two concurrent requests of one class to one host, from any runs, are told apart only by time, so their byte counts and cut reasons can swap; refusals are unaffected, since their reply names its reason); `client_aborted` for an `abort` with no error of its own; a request whose insert fails is refused, failing closed as `secrets.get` does. A `ctx.http` call gets its row from the proxy like any other request. Only a request with no valid credential has no subject; it is logged, not stored.

**Credential lifecycle.** A credential has no state of its own; its liveness is read from durable state. A `populate` credential is live while its run is at `started`, a `run` credential while it is at `dispatched`. A verify credential inside a draft is live while the draft is in the state, and the attempt in the phase and generation, the credential names. A draftless register's verify credential is live until its 10-minute expiry, or until the register call revokes the install credential in-process, which a restart forgets. The proxy holds only caches it can rebuild.

| Failure mode | State left | Why it is safe, or the residual |
|-|-|-|
| The proxy is down or restarting | requests fail to connect; the run continues | fails closed: no route exists around it. When a run ends in error, the runner checks the proxy's health and records `egress_unavailable`, a pausing kind, if it is down, whatever the skill raised. A restart re-derives admission from `skill_runs` |
| A run ends with a request in flight | the request ends with its client socket: the task process's exit, or `ctx.http`'s abort on run end; the tunnel's class timeout is the backstop | mockttp has no per-request abort, but drops the upstream when the client's socket closes; the request line and headers, the only places a secret is substituted, were sent before the run ended |
| A run is swept from `started` or `dispatched` ([Run failures](#run-failures)) | the credential is revoked with it | the sweeper's transition is the same revocation |
| CA rotation | applied at the next `cogmo serve` start | TLS → CA rotation |
| A leaf certificate cache lost | re-minted on first use | it is a cache |
| The pin tunnel is down, or refuses the host | the `CONNECT` fails; the request fails with `403` or `502` | fails closed: a class rule has no upstream but its tunnel, and mockttp resolves nothing itself |
| An upstream streams past the class cap, or past its time limit | the connection is reset; the client sees `ECONNRESET` | the tunnel counts and times the stream; the only copy mockttp keeps is capped by `maxBodySize`; the row records `too_large` or `timeout` |
| A client sends a body over the request cap | refused `413`, never forwarded | mockttp drops the copy past `maxBodySize`, and the policy refuses the request rather than forwarding a truncated body. **Residual:** an unauthenticated client holds up to the cap per connection before the `407` |
| A `CONNECT` to an IP literal naming an allowlisted host in `Host` | denied `host_not_allowed`; nothing connects | the policy compares the tunnel's destination with the URL's host, and returns the checked URL so mockttp connects by name, never by the tunnel's address |
| A WebSocket upgrade, or a non-HTTP protocol on the listener | refused: `503` for the upgrade, a closed connection otherwise | no WebSocket rule and no passthrough option exists |
| A mockttp major changes the rule or hook API | the integration test fails | it drives the real listener against a local TLS upstream (pinning, a wrong certificate, a `CONNECT` to an IP literal, `407`, `403`, `413`, the byte cap on a close-delimited body, one request per connection, a refused upgrade), so a bump that breaks the policy wiring cannot merge green |
| The proxy crashes between forwarding and completing the audit row | the row with `status` and response bytes null | the request is recorded as sent with its result unknown, never missing |
| The audit insert fails | the request refused `502` with `x-cogmo-egress: upstream_error` | fails closed; `ctx.http` raises `network_error` |
| The master key rotates | `cogmo serve` stopped first ([infrastructure.md → Master-key rotation](infrastructure.md#master-key-rotation-proposed)) | no run holds a credential; a run the stop left at `started` or `dispatched` is swept |
| A tier-2 skill needing raw TCP | no route | the skill fails: non-HTTP egress is denied ([Decisions](#decisions)) |

## Contracts `[proposed]`

Each contract has one source; every other copy is generated from it and checked in CI.

**Skill inputs and outputs: pydantic in `skill.py`.**

```python
from pydantic import BaseModel
from cogmo_ctx import Ctx, SkillError

class Input(BaseModel):
    since: datetime | None = None

class Output(BaseModel):
    summary: str
    count: int

async def run(inputs: Input, ctx: Ctx) -> Output: ...
```

- At register, and at verify, the runner imports `skill.py` in the tier's own runtime (inside the sandbox the lockfile compile already starts, or the Pyodide child). It emits `Input.model_json_schema()` and `Output.model_json_schema()`, which become `skills.inputs` and `skills.outputs`: the LLM tool schema and the host's pre-flight ajv check. Until S7 puts register's session behind the proxy, the session leaves its network after the compile and the install and before the import, so agent-authored module code, approve-tier code included, runs with no network; a backend that cannot drop it keeps the legacy schema path ([Verify stage](#verify-stage)).
- The frontmatter carries no `inputs` or `outputs`, which keeps `SKILL.md` closer to Anthropic's standard. A skill with no `Input` model still needs frontmatter `inputs`, so live skills keep working.
- The runner validates with `Input.model_validate(inputs)` before `run`, so pydantic applies defaults (a cron fire's `{}`) and formats. After `run` it applies `Output.model_validate(result).model_dump(mode="json")`.
- pydantic belongs to the runtime, not to skills: the tier-2 runtime venv and tier 1's built-in packages pin one version each. A skill declaring another version is rejected, and the lockfile compile runs with `--constraint` on the runtime's pin, so no dependency pulls a different one in transitively.

**`ctx`: one Python package, `cogmo_ctx`.** Both tiers ship it with a pluggable bridge, the tier-1 `MessagePort` and the tier-2 relay pipe. It replaces tier 1's untyped `ctx.py` and the copy inside `runner.py`. Its typed surface — argument and result models, `CtxError` with a `kind` enum — and the worker protocol frames are generated from the TS Zod schemas (`z.toJSONSchema`) by a codegen script. CI fails when the generated `.pyi` and JSON Schemas are stale, and pytest validates the Python side's frames against them, which catches drift such as a field one side sends and the other strips. `SKILL_EFFECTS` and `SkillManifestSchema` reach the authoring prompt and `CLAUDE.md` by interpolation, never by hand.

**`ctx.run()`** returns `{ id, key }`: the run id, and the logical key of the invocation — the caller's (tool call or cron fire) when there is one, else the run id. A cron re-fire's run row is keyed `…:retry`, but its `key` is the original fire's, so the retry's writes carry the same `Idempotency-Key` as the attempt that may already have acted. A skill sends `key` as `Idempotency-Key` on external writes, so no repeat of one invocation acts twice at a destination that honours it.

### Run failures

`skill_runs.error_kind` (`skill_run_error_kind`) is set iff `status = 'error'`, beside the `error` message. Each kind has one class, a pure function of the kind:

| Class | Kinds | Counts toward auto-disable | Retried |
|-|-|-|-|
| defect | `skill_raised` (an uncaught exception), `output_invalid`, `load_failed` (syntax, import, missing `run`), `wall_clock_exceeded`, `memory_exceeded` | yes | no |
| expected | `skill_failed` (`SkillError(kind, message)`), `input_invalid` (pydantic refused what ajv passed) | no | no |
| pausing | `skill_retryable` (`SkillError(..., retryable=True)`), `runtime_unavailable` (pool, sandbox, supervisor, worker init), `dependency_unavailable`, `egress_unavailable`, `credential_unavailable` (the proxy could not produce a bound credential), `host_lost` (swept before dispatch) | no | once, for a cron fire |
| lost | `result_lost` (swept after dispatch, so the body may have acted) | no | no |
| legacy | `unknown`: only the migration writes it, on error rows from before the column | no | no |

- A failure before the skill executed is a `SkillInvokeRejection`, as today. A cron fire throws on `sandbox_unavailable`, so Inngest's retries apply; every other rejection is skipped, as today.
- A run that executed is never re-run on its own key. A cron run ending in a pausing kind is re-fired once, after a backoff, under `skill-cron:<skillId>:<scheduledFor>:retry`.
- `output_invalid` keeps what the skill returned, so the run is debuggable and the model is told its effects happened: `chk_skill_runs_outcome` admits `output` on an error verdict only with that kind.
- A non-JSON output (`NaN`, a `set`) is `output_invalid`, decided in the worker before `transitionToExecuted`, so a host-side parse never strands the row at `started`.

**Events.** Every run that finishes with an error emits `skills/run.failed` `{ skillId, runId, trigger, errorKind }`. Cron and event runs notify their run-as user: the skill, the error, the last success, and Disable. Tool runs reach the user through the model. The same subscriber applies the auto-disable rule ([Notifications and undo](#notifications-and-undo)), and `skills.disabled_reason` (`awaiting_first_deploy | operator | deregistered | error_rate`, set iff `disabled`) records why a skill is off, naming the activation states that `disabled` alone encodes. The emit follows the commit that finishes the run, so a crash between them loses it. **Residual:** that notification is lost, though the run shows in `cogmo skills runs` and the activity view; auto-disable reads `skill_runs` at the live sha, not a counter, so it counts the failure at the next one.

**Stuck runs** `[proposed]`, S3's. Dispatch is a transition: immediately before it sends `task_invoke`, every runtime moves the row `started → dispatched` by conditional UPDATE, writing `deadline_at` (now, plus `wall_clock_s`, plus 60 s for the kill and the result frame). Zero rows means the sweeper took the run, and the task is not sent. `skill-runs-sweeper` runs every 5 min and moves a stuck row to `finished`, writing `finished_at`, `resource_usage` (`wallClockMs` from `created_at`, `peakMemoryBytes` null) and the `error` text, as `chk_skill_runs_executed_payload` and `chk_skill_runs_outcome` require:

| Row | Swept when | `error_kind` | Re-fired |
|-|-|-|-|
| `started`, never dispatched | 15 min after `created_at`, which covers the 60 s worker init and populate (180 s; the `populate` class allows 10 min) and bounds the pool's queue, unbounded beyond `max` | `host_lost` | once, for a cron fire: nothing ran |
| `dispatched` | past `deadline_at` | `result_lost` | never: the body may have acted |

Each move is a conditional UPDATE on the row's recovery point, and revokes the run's egress credential with it. A late `transitionToExecuted` then matches no row and returns `swept`, logged with the output it discards, rather than throwing. A keyed retry replays the swept error instead of reading `inflight` forever. **Residual:** a row a build without `dispatched` left at `started` may have executed, and is swept as `host_lost`, so its cron fire re-fires once; this happens only across the deploy that ships S3.

**Audit columns.** `skill_runs` gains `git_sha`, `run_as_user_id`, `run_as_profile_id`, `shadow` and `deadline_at`. `skill_context_calls.error` becomes the `ctx_error_kind` pgEnum, and `secrets.get` fails closed when its audit row cannot be written. Backfills, in the migration of the slice that adds each column: with the run schema (todo.md → Skills autonomy S3), error runs get `error_kind = 'unknown'` and `shadow` is `false`; with the failure events (S12), context-call errors map each known `CtxErrorKind` string to its value and anything else to `unknown`, and disabled skills get `awaiting_first_deploy` when their sha has no live deploy, else `unknown`, since nothing recorded whether an operator or `deregister` turned them off.

## Observability `[proposed]`

The database answers what an operator asks of a skill:

| Question | Source |
|-|-|
| What did X do last week, as whom, at which version | `skill_runs` by skill and `created_at`: trigger, `git_sha`, run-as, status, `error_kind`, `shadow`, `resource_usage` |
| Which hosts, with which verbs, and how much data | `skill_egress` by run: method, origin, path, bytes, status, denials |
| Which secrets, and where they went | `skill_context_calls` (`secrets.get`) and `skill_egress.bindings` (`substituted`, `misuse`) |
| What it wrote | `skill_context_calls` for memory and files; `skill_egress` for every proxied request, with its method |
| What it cost | `resource_usage` (wall clock, peak memory), and declared `cost_per_call_usd` summed per run |
| How it got here | `skill_deploys` (tier, reasons, `classifier_log`), and the draft: spec card, rounds, verify reports, reviews |

- **CLI.** `cogmo skills runs <name> [--since 7d] [--status error]`; `cogmo skills run-log <runId>` (its context calls and egress); `cogmo skills activity <name> [--since 7d]` (hosts, secrets, writes, error kinds, cost); `cogmo skills drafts [--open]`.
- **Web UI.** The same reads through oRPC (`skills.runs`, `skills.run`, `skills.activity`, `skills.drafts`) on the Skills page, which the notifications' Details link opens.
- **Chat.** `/skills` adds open and blocked drafts, with their buttons.

## Data model `[confirmed]`

Owned by `src/skills/store/` (`schema.ts`), which is the source of truth; this sketch omits indexes.

```sql
CREATE TYPE skill_tier AS ENUM ('wasm', 'container');
CREATE TYPE skill_risk_tier AS ENUM ('auto', 'notify', 'approve');
CREATE TYPE skill_run_status AS ENUM ('running', 'success', 'error');
CREATE TYPE skill_run_trigger AS ENUM ('manual', 'cron', 'event');
CREATE TYPE skill_deploy_status AS ENUM ('pending_approval', 'denied', 'live', 'rolled_back');
CREATE TYPE skill_run_recovery_point AS ENUM ('started', 'executed', 'finished');

skills (
  id                UUID v7 PK,
  name              TEXT NOT NULL UNIQUE,            -- matches dir name
  tier              skill_tier NOT NULL,
  risk_tier         skill_risk_tier NOT NULL,        -- computed by classifier at deploy
  effects           JSONB NOT NULL,                  -- SkillEffectsSchema (declared effects list)
  schedule          TEXT,                            -- nullable: cron expression; null = not scheduled
  next_run_at       TIMESTAMPTZ,                     -- nullable: set iff schedule is (chk_skills_next_run_at_iff_schedule); the ticker locks due rows and advances it
  last_fired_at     TIMESTAMPTZ,                     -- nullable: null until the first fire
  run_as_user_id    UUID REFERENCES users(id),       -- nullable: set iff schedule is set and the row enabled (chk_skills_run_as_iff_live_schedule).
  run_as_profile_id UUID REFERENCES profiles(id),    -- nullable: same. Who a cron fire runs as; see Run-as identity.
  git_sha           TEXT NOT NULL,                   -- commit hash of current live version
  lockfile_hash     TEXT,                            -- nullable: null when manifest.dependencies is empty.
                                                     -- sha256(requirements.lock @ git_sha). Drives venv cache
                                                     -- key + reachability GC; updated atomically with git_sha.
                                                     -- See Dependencies.
  inputs            JSONB NOT NULL,                  -- SkillInputsSchema: an object JSON Schema
  outputs           JSONB,                           -- nullable: side-effect-only skills have no structured output. SkillIoSchema when present.
  disabled          BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
)

skill_deploys (
  id              UUID v7 PK,
  skill_id        UUID NOT NULL REFERENCES skills(id),
  git_sha         TEXT NOT NULL,           -- commit being deployed
  prior_git_sha   TEXT,                    -- nullable: null for first deploy; used for rollback
  risk_tier       skill_risk_tier NOT NULL,
  status          skill_deploy_status NOT NULL,
  approved_by     UUID REFERENCES user_identities(id),  -- nullable: the identity that approved an approve-tier deploy for a user; null for auto/notify-tier and owner-CLI approvals
  classifier_log  JSONB NOT NULL,          -- ClassifierLogSchema (classifier output + static analysis findings)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,             -- nullable: set iff status is terminal (live / denied / rolled_back)
  CHECK ((status = 'pending_approval') = (resolved_at IS NULL)),          -- chk_skill_deploys_resolved_at_iff_terminal
  CHECK (approved_by IS NULL OR status = 'live')                           -- chk_skill_deploys_approved_by_only_live
)

skill_runs (
  id              UUID v7 PK,
  skill_id        UUID NOT NULL REFERENCES skills(id),
  trigger         skill_run_trigger NOT NULL,
  inputs          JSONB NOT NULL,           -- SkillInvocationInputsSchema (matches skill's declared input JSON Schema at invoke time; Zod layer is pass-through)
  status          skill_run_status NOT NULL,
  output          JSONB,                    -- nullable: null on error. SkillInvocationOutputSchema when present (matches skill's declared output JSON Schema).
  error           TEXT,                     -- nullable: null on success
  resource_usage  JSONB,                    -- nullable: SkillRunResourceUsageSchema. { wallClockMs, peakMemoryBytes }. Null while recovery_point = 'started'.
  idempotency_key TEXT,                     -- nullable: null for one-shot CLI/test invocations. UNIQUE(idempotency_key) — Postgres NULLs-are-not-equal default allows multiple null rows; see At-most-once invocation.
  recovery_point  skill_run_recovery_point NOT NULL DEFAULT 'started',  -- 'started' | 'executed' | 'finished' — drives the replay branches in runner.invoke.
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,              -- nullable: null while recovery_point = 'started'
  -- Per-state data (see At-most-once invocation → Per-state data):
  CHECK ((recovery_point = 'finished') = (status <> 'running')),          -- chk_skill_runs_status_iff_finished
  CHECK ((recovery_point = 'started') = (finished_at IS NULL)
     AND (recovery_point = 'started') = (resource_usage IS NULL)
     AND (recovery_point <> 'started' OR (output IS NULL AND error IS NULL))),  -- chk_skill_runs_executed_payload
  CHECK (NOT (output IS NOT NULL AND error IS NOT NULL)
     AND (status <> 'success' OR error IS NULL)
     AND (status <> 'error' OR (error IS NOT NULL AND output IS NULL)))   -- chk_skill_runs_outcome
)

skill_context_calls (
  id         UUID v7 PK,
  run_id     UUID NOT NULL REFERENCES skill_runs(id),
  method     TEXT NOT NULL,                -- 'secrets.get' | 'memory.recall' | ...
  target     TEXT,                         -- nullable: the method's target (secret name, memory bank) — some ctx methods take no target (e.g. now()). NEVER the value.
  ok         BOOLEAN NOT NULL,
  error      TEXT,                         -- nullable: null on success
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

`skills` is derived state — authoritative source is the git repo. Row synced from `SKILL.md` on deploy. `skill_runs` is append-only audit trail. `skill_context_calls` records every `ctx.*` RPC from the worker, scoped to a run — secret names and memory-bank names only, never values.

**JSONB schemas validated at the store boundary** ([architecture-rules.md](../.agents/rules/architecture-rules.md)), each defined in `types.ts`: `skills.inputs` (`SkillInputsSchema`), `skills.outputs` (`SkillIoSchema`), `skills.effects` (`SkillEffectsSchema`), `skill_deploys.classifier_log` (`ClassifierLogSchema`), `skill_runs.inputs` and `output` (`SkillInvocationInputsSchema`, `SkillInvocationOutputSchema`: any JSON value, since ajv checks the skill's own schema at invoke) and `skill_runs.resource_usage` (`SkillRunResourceUsageSchema`, null while `recovery_point = 'started'`).

### Authoring, egress and audit additions `[proposed]`

```sql
ALTER TYPE skill_risk_tier ADD VALUE 'blocked';   -- auto | notify | approve | blocked
CREATE TYPE skill_draft_status AS ENUM ('specifying', 'authoring', 'verifying', 'reviewing', 'registering',
  'awaiting_approval', 'blocked', 'live', 'abandoned', 'failed');
CREATE TYPE skill_draft_blocked_reason AS ENUM ('author_unavailable', 'verifier_unavailable', 'reviewer_unavailable',
  'registrar_unavailable', 'reviewer_block', 'risk_blocked', 'rounds_exhausted');
CREATE TYPE skill_draft_end_reason AS ENUM ('user_abandoned', 'spec_timeout', 'blocked_timeout', 'approval_timeout',
  'denied', 'base_moved', 'step_error');
CREATE TYPE skill_review_verdict AS ENUM ('pass', 'revise', 'block');
CREATE TYPE skill_run_error_kind AS ENUM ('skill_raised', 'output_invalid', 'load_failed', 'wall_clock_exceeded',
  'memory_exceeded', 'skill_failed', 'input_invalid', 'skill_retryable', 'runtime_unavailable',
  'dependency_unavailable', 'egress_unavailable', 'credential_unavailable', 'host_lost', 'result_lost',
  'unknown');   -- 'unknown': migration backfill only
CREATE TYPE skill_disabled_reason AS ENUM ('awaiting_first_deploy', 'operator', 'deregistered', 'error_rate', 'unknown');
CREATE TYPE skill_egress_outcome AS ENUM ('forwarded', 'shadowed', 'denied', 'failed');
CREATE TYPE skill_egress_class AS ENUM ('run', 'populate', 'verify_install', 'verify_code', 'review');
CREATE TYPE skill_verify_phase AS ENUM ('install', 'code', 'register_install', 'register_code', 'done');
CREATE TYPE deployment_flag_reason AS ENUM ('calibration_passed', 'calibration_failed', 'recalibration_pending', 'model_drift',
  'no_second_family');
ALTER TYPE skill_deploy_status ADD VALUE 'blocked';   -- terminal: resolved_at set
CREATE TYPE skill_approval_class AS ENUM (/* SKILL_EFFECTS */ ..., 'raw_secret', 'reads_and_egress', 'sensitive_dependency');
CREATE TYPE skill_egress_failure_reason AS ENUM ('host_not_allowed', 'blocked_address', 'credential_revoked',
  'credential_unavailable', 'not_http', 'too_large', 'timeout', 'upstream_error', 'client_aborted');
ALTER TYPE skill_run_recovery_point ADD VALUE 'dispatched';   -- started | dispatched | executed | finished; no CHECK names it, so it shares their migration
CREATE TYPE egress_ca_status AS ENUM ('active', 'retiring', 'retired');
CREATE TYPE calibration_run_status AS ENUM ('running', 'passed', 'stale', 'failed');
CREATE TYPE calibration_failure_reason AS ENUM ('below_floor', 'step_error');
CREATE TYPE skill_shadow_fire_status AS ENUM ('owed', 'claimed', 'completed', 'superseded');

skill_drafts (
  id                 UUID v7 PK,
  skill_name         TEXT NOT NULL,
  base_git_sha       TEXT,                     -- nullable: null for a new skill; the live sha an edit starts from
  conversation_id    UUID REFERENCES conversations(id),   -- nullable: null for a CLI-started draft, whose card and notifications go to the owner
  requester_user_id  UUID NOT NULL REFERENCES users(id),
  requester_profile_id UUID NOT NULL REFERENCES profiles(id),      -- the deploy origin; an approve-tier deploy's schedule runs as its approver (Run-as identity)
  status             skill_draft_status NOT NULL,
  round              INT NOT NULL,
  attempt            INT NOT NULL,             -- coding task within the round; resets to 0 each round
  transition_seq     INT NOT NULL,             -- increments on every transition and claim; in every event id and gate key
  max_rounds         INT NOT NULL,             -- 3 at insert; Extend raises it, CHECK ≤ 6
  spec               JSONB NOT NULL,           -- SkillSpecSchema; written only in 'specifying'
  spec_version       INT NOT NULL,
  state              JSONB NOT NULL,           -- SkillDraftStateSchema, discriminated on status; CHECK state->>'status' = status;
                                               -- post-approval variants carry specApproval ('requester' | 'auto' | 'repair'),
                                               -- author_unavailable an optional cause 'admission', risk_blocked its reasons (SkillRiskReason[]),
                                               -- specifying and awaiting_approval the card { specVersion, text } their gate message showed
  blocked_reason     skill_draft_blocked_reason,  -- nullable: set iff status = 'blocked' (CHECK)
  end_reason         skill_draft_end_reason,      -- nullable: set iff status IN ('abandoned', 'failed') (CHECK)
  idempotency_key    TEXT UNIQUE,              -- nullable: null for CLI-started drafts; the draft_skill call's key
  transitioned_at    TIMESTAMPTZ NOT NULL,     -- set by every transition, claim and release; the reconcile cron's age, and in awaiting_slot,
                                               -- which no claim or release writes, the 24 h admission park's
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
  -- UNIQUE (skill_name) WHERE status NOT IN ('live', 'abandoned', 'failed')
)

skill_draft_rounds (
  id               UUID v7 PK,
  draft_id         UUID NOT NULL REFERENCES skill_drafts(id),
  round            INT NOT NULL,
  attempt          INT NOT NULL,
  coding_task_id   UUID NOT NULL UNIQUE REFERENCES coding_tasks(id),   -- keyed skill-draft:<draftId>:<round>:<attempt>
  findings         JSONB NOT NULL,           -- SkillFindingsSchema: what this round was asked to fix; [] at round 0
  tip_sha          TEXT,                     -- nullable: null until the attempt's coding task opens its PR
  verify_report    JSONB,                    -- nullable: SkillVerifyReportSchema; null until verify settles
  register_rejection JSONB,                  -- nullable: RegisterRejectionSchema; set iff the attempt's register returned a terminal-group rejection other than
                                             -- blocked, written by settle-register; CHECK register_rejection IS NULL OR verify_report IS NOT NULL
  verify_phase     skill_verify_phase NOT NULL,  -- which verify credential the proxy admits; transitions in Verify phases
  deps_hash        TEXT,                     -- nullable: the lockfile hash verify-install populated; null in 'install', and throughout for a skill with
                                             -- no dependencies; CHECK verify_phase <> 'install' OR deps_hash IS NULL
  verify_resets    INT NOT NULL,             -- 0 at insert; +1 per phase reset; in every verify credential; steps reset while < 2, owner taps past it
  panel            JSONB,                    -- nullable: ReviewPanelSchema { members, modelIds, checklistVersion, calibrationRunId }; set when the round enters reviewing,
                                             -- by the transition that writes verify_report: CHECK panel IS NULL OR verify_report IS NOT NULL
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (draft_id, round, attempt)
)

skill_draft_reviews (
  id                 UUID v7 PK,
  draft_id           UUID NOT NULL REFERENCES skill_drafts(id),
  round              INT NOT NULL,
  reviewer           coding_backend NOT NULL,   -- the reviewer's family: 'claude' | 'codex'
  model              TEXT NOT NULL,          -- upstream model id, as reported by the backend
  checklist_version  TEXT NOT NULL,
  verdict            skill_review_verdict NOT NULL,
  findings           JSONB NOT NULL,         -- SkillFindingsSchema
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (draft_id, round, reviewer)         -- written through ON CONFLICT DO UPDATE with a no-op SET
)

skills_repo_layout (
  id                 UUID v7 PK,
  singleton          BOOLEAN NOT NULL UNIQUE CHECK (singleton),  -- at most one row; written true by migrateSkillsLayout
  layout_commit_sha  TEXT NOT NULL,           -- the commit that moved skills to skills/<name>/; dual-path reads compare against it
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
)

deployment_flags (
  id          UUID v7 PK,
  name        TEXT NOT NULL UNIQUE,                    -- 'skills.review_panel'
  enabled     BOOLEAN NOT NULL,                        -- CHECK enabled = (reason = 'calibration_passed')
  reason      deployment_flag_reason NOT NULL,         -- the flag's state; transitions in Review-panel flag
  calibration_inputs JSONB,                            -- nullable: CalibrationInputsSchema { checklistVersion, promptDigests, configuredModels, cliVersions, modelIds }:
                                                       -- the inputs the flag is judged against; boot writes the first four, boot or a model drift modelIds;
                                                       -- a calibration run sets or clears the flag only by compare-and-set on them;
                                                       -- CHECK (calibration_inputs IS NULL) = (reason = 'no_second_family')
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)

skill_approval_classes (
  id          UUID v7 PK,
  class       skill_approval_class NOT NULL UNIQUE,   -- a class the owner holds for approval; no rows = approve never applies
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)

skill_egress (
  id              UUID v7 PK,
  run_id          UUID REFERENCES skill_runs(id),           -- nullable: the subject of run and populate requests
  draft_round_id  UUID REFERENCES skill_draft_rounds(id),   -- nullable: the subject of verify and review requests inside a draft
  register_skill_name TEXT,                                -- nullable: with register_tip_sha, the subject of a draftless register's verify requests
  register_tip_sha    TEXT,                                -- nullable: set iff register_skill_name is (CHECK)
  credential_class skill_egress_class NOT NULL,
  -- CHECK exactly one subject: run_id, draft_round_id, or the register pair
  -- CHECK credential_class IN ('run', 'populate') = (run_id IS NOT NULL)
  method          TEXT NOT NULL,
  origin          TEXT NOT NULL,
  path            TEXT NOT NULL,             -- never the query string
  request_bytes   INT NOT NULL,
  response_bytes  INT,                       -- nullable: null until the response completes the row
  status          INT,                       -- nullable: null when denied, failed before a response, or not yet completed
  outcome         skill_egress_outcome NOT NULL,
  failure_reason  skill_egress_failure_reason,  -- nullable: set iff outcome IN ('denied', 'failed') (CHECK)
  bindings        JSONB NOT NULL,            -- EgressBindingsSchema: [{ secret, event: 'substituted' | 'misuse' }]
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
)

calibration_runs (
  id              UUID v7 PK,
  inputs_digest   TEXT NOT NULL,             -- digest of inputs and the suite's fixture version
  inputs          JSONB NOT NULL,            -- CalibrationInputsSchema
  trigger         TEXT NOT NULL,             -- 'boot:<boot id>' | 'weekly:<scheduled time>' | 'drift:<review id>'
  status          calibration_run_status NOT NULL,
  failure_reason  calibration_failure_reason,  -- nullable: set iff status = 'failed' (CHECK)
  scores          JSONB,                     -- nullable: CalibrationScoresSchema, per backend and per class; set iff settled: passed, stale, or failed below_floor (CHECK)
  resolved_at     TIMESTAMPTZ,               -- nullable: set iff status is terminal (CHECK)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (inputs_digest, trigger)            -- written through ON CONFLICT DO UPDATE with a no-op SET
)

skill_shadow_fires (
  id          UUID v7 PK,
  deploy_id   UUID NOT NULL UNIQUE REFERENCES skill_deploys(id),   -- the deploy that owes the shadow fire
  skill_id    UUID NOT NULL REFERENCES skills(id),
  git_sha     TEXT NOT NULL,                 -- the owing deploy's sha; only a run at it pays the debt
  status      skill_shadow_fire_status NOT NULL,
  run_id      UUID REFERENCES skill_runs(id),   -- nullable: null at 'owed', set at 'claimed' and 'completed' (CHECK)
  resolved_at TIMESTAMPTZ,                   -- nullable: set iff status IN ('completed', 'superseded') (CHECK)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  -- UNIQUE (skill_id) WHERE status IN ('owed', 'claimed')
)

egress_ca_generations (
  id          UUID v7 PK,
  generation  INT NOT NULL UNIQUE,
  status      egress_ca_status NOT NULL,          -- partial unique indexes: one 'active', one 'retiring' at most
  secret_name TEXT NOT NULL UNIQUE,               -- the secrets row holding the CA key and certificate
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)

-- skill_runs gains:
  git_sha            TEXT,        -- nullable: null only on rows from before the column; every new row sets it
  run_as_user_id     UUID REFERENCES users(id),     -- nullable: as git_sha
  run_as_profile_id  UUID REFERENCES profiles(id),  -- nullable: as git_sha
  shadow             BOOLEAN NOT NULL,         -- written explicitly by every insert; the migration backfills false
  error_kind         skill_run_error_kind,  -- nullable: set iff status = 'error' (CHECK)
  deadline_at        TIMESTAMPTZ,  -- nullable: written at dispatch, so null at 'started' and set at 'dispatched'; past them, null only on a row never dispatched;
                                   -- CHECK (recovery_point <> 'started' OR deadline_at IS NULL)
                                   --   AND (recovery_point IN ('started', 'executed', 'finished') OR deadline_at IS NOT NULL)
  -- chk_skill_runs_outcome admits output on an error verdict only when error_kind = 'output_invalid'
  -- chk_skill_runs_executed_payload is rephrased on recovery_point IN ('executed', 'finished') in place of = 'started', so 'dispatched' carries
  -- no finished_at, resource_usage, output or error, as 'started' does. Neither CHECK names 'dispatched', so the ADD VALUE and both CHECKs share
  -- one migration (architecture-rules.md → splitting one migration into two)

-- skill_deploys gains:
  restores_git_sha   TEXT,        -- nullable: set iff status = 'rolled_back' (CHECK); backfill: the row's own git_sha, which an update-ref rollback restored

-- skills gains:
  disabled_reason    skill_disabled_reason,  -- nullable: set iff disabled (CHECK); backfill: 'awaiting_first_deploy' where the sha has no live deploy, else 'unknown'

-- skill_context_calls.error becomes ctx_error_kind (the CtxErrorKind set, plus 'unknown' for unmapped legacy text); http.request rows give way to skill_egress
```

`classifier_log` gains `reasons` (`SkillRiskReason[]`, [Risk tiers](#risk-tiers-without-a-human) → Reasons), `approvalClasses` (the `skill_approval_classes` an `opted_in` reason matched), `declared_network` and the capability flags it read, so a deploy records why it got its tier. `skill_deploys.approved_by` also holds an Override's owner.

## At-most-once invocation `[confirmed]`

`runner.invoke` takes an optional `idempotencyKey`. With one, the run follows a database-level state machine that executes the skill body at most once per key and returns the stored result to every later attempt, under any workflow engine. A first attempt that died after writing its row is refused as `inflight`, never re-executed: the guarantee is at-most-once execution with cached-result recovery. A cron re-fire after a pausing kind runs under a new key, and `ctx.run().key` is what keeps it from acting twice at a destination that honours `Idempotency-Key` ([Contracts](#contracts-proposed)). The pattern is Brandur Leach's [idempotency keys in Postgres](https://brandur.org/idempotency-keys): atomic phases and recovery points.

**State machine.** `skill_runs.recovery_point` is advanced by atomic UPDATEs inside `runInTx`; `dispatched` is `[proposed]` (S3, [Run failures](#run-failures) → Stuck runs):

```
INSERT recovery_point='started'  ← startOrRecoverRun, atomic
  ↓ [proposed] UPDATE recovery_point='dispatched', deadline_at  ← immediately before task_invoke
  ↓ execute skill body (non-idempotent, side-effecting)
UPDATE recovery_point='executed', output/error/resource_usage/finished_at  ← transitionToExecuted, atomic
  ↓ output validation (pure, deterministic)
UPDATE recovery_point='finished', status='success'|'error'  ← transitionToFinished, atomic
```

#### Per-state data `[confirmed]`

`recovery_point` is the phase and `status` the verdict; the other nullable columns are per-state data. Three CHECKs on the table pin, from every writer, which columns each phase has set, so the combinations no transition writes are unrepresentable and the readers (`finishedVerdictOf`, `executedOutcomeOf`) match the shapes exhaustively.

| Transition | Guard | Writes, in one statement | Outcome |
|-|-|-|-|
| insert → `started` | none; with a key, `ON CONFLICT (idempotency_key) DO UPDATE` with a no-op SET recovers the row the key already has | `skill_id`, `trigger`, `inputs`, `status = 'running'`, the key; `recovery_point` by default | the row, as `new` or `recovered` |
| `started` → `dispatched` `[proposed]` | `WHERE id = $1 AND recovery_point = 'started'` | `recovery_point`, `deadline_at` | `dispatched`; zero rows means swept, and the task is not sent |
| `started` → `executed`; from `dispatched` once that ships | `WHERE id = $1 AND recovery_point = 'started'`; `= 'dispatched'` once S3 ships | `recovery_point`, the worker's `output` or `error`, `resource_usage`, `finished_at` | a zero-row match throws today. `[proposed]`: it returns `swept`, logged with the output it discards, when the sweeper finished the row, and throws on any other state |
| `started` or `dispatched` → `finished`, swept `[proposed]` | the row's recovery point, and its age or `deadline_at` | `recovery_point`, `status = 'error'`, `error_kind` `host_lost` or `result_lost`, `error`, `resource_usage`, `finished_at` | `swept` |
| `executed` → `finished` | `WHERE id = $1 AND recovery_point = 'executed'` | `recovery_point`, `status`, and the verdict's `output` or `error` | `transitioned`; `already_finished` with the row another attempt settled; a row at `started` or missing throws |

| `recovery_point` | `status` | `output` / `error` | `resource_usage` | `finished_at` |
|-|-|-|-|-|
| `started` | `running` | both null | null | null |
| `dispatched` `[proposed]` | `running` | both null | null | null; `deadline_at` set |
| `executed` | `running` | what the worker produced: `output` (null when the skill returned nothing) with `error` null, or `error` with `output` null | set | set |
| `finished` | `success` | `output` (possibly null), `error` null | set | set |
| `finished` | `error` | `error` set, `output` null | set | set |

- `chk_skill_runs_status_iff_finished` (Data model): a terminal `status` exists exactly in the `finished` phase.
- `chk_skill_runs_executed_payload`: `finished_at`, `resource_usage` and the worker's `output` or `error` arrive with `executed` and are absent before it.
- `chk_skill_runs_outcome`: `output` and `error` are alternatives; an `error` verdict names its reason and keeps no output, a `success` verdict has no error.

The `executed` payload stays in its existing columns under CHECK, a deviation from [state-machines.md](../.agents/rules/state-machines.md)'s per-state JSONB blob: the columns are populated in production, the CHECK gives the same all-or-none invariant, moving them would cost a data migration with no reader to benefit, and `chk_skills_run_as_iff_live_schedule` is the same accepted shape. `error` is free text, so a worker failure and an output-schema rejection cannot be told apart by query; an `error_kind` enum is a residual, closed by [Run failures](#run-failures) (todo.md → Skills autonomy S3).

In code the transitions take values — `ExecutedOutcome` (`{ kind: "output", output } | { kind: "error", error }`) and `SkillRunVerdict` (`{ status: "success", output } | { status: "error", error }`) — which the store maps onto the columns, so no caller can write a half-payload. `finishedVerdictOf` reads a `finished` row back into its verdict and throws on a row outside the shape: an invariant the CHECKs hold, so a bug, not a value.

`0077_skill_run_and_deploy_state_checks` adds the CHECKs of both tables and, before the one that needs it, repairs the one shape a shipped build wrote that they reject — one transaction, so a failure leaves the repair unapplied too, boot fails naming the constraint, and the next boot retries the file.

| Failure mode | State left | Why it is safe, or the residual |
|-|-|-|
| rows that finished before `0042` added `resource_usage` | `recovery_point = 'finished'` with `resource_usage` null | the migration writes what the runner records: `wallClockMs` as the wall clock from `created_at` to `finished_at`, `peakMemoryBytes` null, the value the WASM tier reports |
| a row in a shape no shipped build wrote — past `started` without `finished_at`; `error` without a reason or with an output; `success` with an error; a terminal `status` outside `finished` | the file rolls back whole | refused, not repaired: every shipped writer set `finished_at` and a reason together with the verdict, and 0043 moved every terminal row to `finished`, so such a row has no faithful repair; the operator fixes it |
| a run in flight across the deploy | its row at `started` or `executed`, both legal | `ALTER TABLE` waits for the run's transaction to end and the run's next transition waits for the migration; the retiring build writes the same shapes |
| a keyed retry replays a `finished` row written by an earlier build | the row as that build left it | every shape an earlier build wrote passes the CHECKs once the file has run, so `finishedVerdictOf` reads it |
| a future writer violates a CHECK at runtime (`23514`) in `started → executed` | the row stays at `started`, the rejected write undone | the error surfaces as the throw it is — a bug in the writer, not a value. A keyed retry is refused as `inflight`, the conservative reading of a `started` row (Recovery branches); an unkeyed row stays at `started` for good |
| the same in `executed → finished` | the row stays at `executed` | a keyed retry recovers it as `finish`, re-runs `transitionToFinished` and hits the same `23514`: a repeating throw, not a refusal, until the writer is fixed |

**Recovery branches.** Every `runner.invoke({idempotencyKey})` calls `startOrRecoverRun` first. `invoke/start-run.ts` maps the row to a `RunStart` (`execute`, `finish`, `replay`, `inflight`), matched exhaustively. A warm-pool skill whose key has no row yet starts the pool before that write, so a pool that can't start leaves no row and the keyed retry runs the skill; a key that already has a row is settled from it without starting the pool.

| recovered row state | runner action |
|-|-|
| `kind='new'` (no prior row) | Standard flow: execute → executed → finished |
| `recovered`, `recovery_point='finished'` | Return cached `SkillRunResult` reconstructed from the row. Runtime never touched. |
| `recovered`, `recovery_point='executed'` | Skip execute, replay output validation against stored output, transition to `finished`. Persist-failure retries land here. When two attempts finish the same row, the second gets the result the first settled. |
| `recovered`, `recovery_point` `started` or `dispatched` | In flight: the prior attempt crashed mid-execute, or another worker is executing this key, and the row cannot tell which. Refused as `inflight`, naming the run, since re-executing risks repeating non-idempotent side effects; an operator inspects. A manifest flag `idempotent_invocation: true` could later opt into re-executing. `[proposed]` (S3): the sweeper moves such a row past its bound to `host_lost` or `result_lost`, after which the key replays that error ([Run failures](#run-failures)). |

**Caller key conventions** (deterministic per logical fire):

| Caller | Key shape |
|-|-|
| `skill-cron-fire` handler | `skill-cron:${skillId}:${scheduledFor}` — same shape as the event-bus dedup id |
| Agent-loop tool dispatch | `skill-tool:${ToolCallContext.idempotencyKey}` — the loop's key from the turn token, iteration, position and a digest of the tool name and canonical arguments (`toolCallKey`, `loop.ts`); it covers the crash between a run's commit and Inngest recording the durable tool step |
| CLI / one-shot tests | Omit (no retry context) |

**Race safety.** Concurrent attempts with one key are serialised by the plain UNIQUE `uniq_skill_runs_idempotency_key`; null keys (CLI, tests) coexist, since Postgres treats NULLs as distinct. `startOrRecoverRun` writes through `ON CONFLICT (idempotency_key) DO UPDATE` with a no-op SET ([inngest.md](../.agents/rules/inngest.md)): the row comes back from either arm, with its recovery point and cached payload, and `xmax = 0` tells `new` from `recovered`. The `started` refusal, not a row lock, keeps a concurrent attempt from executing. A plain UNIQUE gives the same semantics as a partial index on non-null keys, with no `WHERE` at each `ON CONFLICT` site.

**Why at the database, not in Inngest steps.** It survives an engine swap and crashes the engine cannot see, serves Inngest and bare CLI runs on one code path, and keeps `Jsonify<Awaited<T>>` off the result type.

## Module structure

`src/skills/` is organised by concern. Use `ls src/skills/` for the live file list; the groupings below describe what lives where and why.

| Group | Subdirectory / key entrypoints | Responsibility |
|-|-|-|
| Public interface | `index.ts`, `runner.ts` | `SkillRunner` contract; `SkillRunnerImpl` wires the source cache, warm pool and use cases below |
| Deploy pipeline | `deploy/` | One use case per RPC: `register.ts`, `approve.ts`, `deny.ts`, `rollback.ts`, `activation.ts` (enable + deregister); the lockfile check, the remote mirror, and the run-as `origin.ts` they share |
| Invocation | `invoke/` | `invoke.ts` (pre-flight, then the recovery-point state machine: `start-run.ts`, `execute-run.ts`, `finish-run.ts`), `runtime.ts` (planning + dispatch to the isolate, pool or one-shot container), `warm-pool.ts` (lazy pool start + shutdown) |
| Source cache + listing | `source-cache.ts`, `listing.ts` | Parsed manifests with compiled validators keyed by `(name, gitSha)`; `list` / `listAll` / `listToolDefs` |
| Manifest + classifier | `manifest.ts`, `classifier.ts`, `ast-classifier.ts`, `ast-rules.ts` | `SKILL.md` frontmatter parsing + risk-tier assignment (tree-sitter static analysis) |
| Dependency stack | `deps.ts`, `deps-reaper*.ts`, `pyodide-compat.ts` | Lockfile compile + verify at register, venv populate + activate at invoke, unreachable-venv reaper, tier-1 Pyodide compat check |
| Workers (tier 2) | `worker-sysbox/` | sysbox container host + in-container supervisor + warm pool |
| Workers (tier 1) | `worker-wasm/` | Pyodide isolate host + Node Worker entry + WASM-import lint; the worker's Python in `py/` (the `ctx` SDK, the dependency installer), which the entry reads at load and the build copies beside `worker-entry.js` |
| Worker channel + ctx RPC | `worker-state.ts`, `dispatcher.ts`, `ctx-handler.ts`, `protocol.ts` | Worker channel state machine and the shell that drives it, ctx RPC serving, Zod-validated frames |
| Cron scheduler | `cron-ticker.ts`, `cron-fire-handler.ts` | Per-minute Inngest tick + per-skill cron invocation |
| Git plumbing | `git-ops.ts`, `repo.ts` | Bare-repo bootstrap, remote configuration, plumbing wrappers |
| Remote configuration | `configure-remote*.ts` | Skills-repo remote setup and its prompts, shared by the setup wizard and `cogmo migrate-skills-remote` |
| Agent surface | `skills-tool.ts`, `skills-service.ts`, `skill-tool-builder.ts`, `skills-keyboard.ts` | Per-turn tool list registration, per-conversation service, Anthropic SDK descriptor build, Telegram approve/deny keyboard |
| Store | `store/` | DB schema + `SkillStore` interface (`skills`, `skill_deploys`, `skill_runs`, `skill_context_calls` tables) |
| Drafts `[proposed]` | `draft/` | The draft lifecycle: one use case per transition, the draft functions, the spec card |
| Review `[proposed]` | `review/` | `SkillReviewer`, its Claude Code and Codex backends, the checklist, the calibration job |
| Egress `[proposed]` | `egress/` | The egress proxy: the mockttp rules and policy, the pin tunnel, credentials, substitution, audit |

The public interface is `SkillRunner` (`src/skills/runner.ts`), summarized in [Where the classifier runs](#where-the-classifier-runs).

## Relationship to other modules

| Module | How it relates |
|-|-|
| [sandbox.md](sandbox.md) | Tier 2 workers are sysbox containers created via the `Sandbox` interface — same supervisor, proxy, reaper, cgroup parent. |
| [coding-delegation.md](coding-delegation.md) | A draft authors through coding tasks on the skills repo, a user-owned bare repo at `$COGMO_SKILLS_PATH`, on the same worktree and branch flow; every skill-repo coding task belongs to a draft. |
| [scheduling.md](scheduling.md) | Cron-triggered skills use Inngest cron. Manual/event skills use Inngest events. |
| [evolution.md](evolution.md) | Skill creation is stage 2+ evolution. A skill reaches `main` through the authoring pipeline's gates ([Authoring pipeline](#authoring-pipeline-proposed)); `approve` holds a deploy only for classes the owner opted into. |
| [integrations.md](integrations.md) | Voyager skill-library concept, SKILL.md standard, description-embedding retrieval, MCP tool registration. |
| [memory.md](memory.md) | Skills access memory via the `Service` interface. |

## Decisions

Where a section specifies a choice, the row links it; a rationale appears only where this table is its home.

| Decision | Choice | Rationale |
|-|-|-|
| Language | Python only | Models write it better for script-shaped tasks, and the libraries a skill reaches for are Python-first ([Language](#language-python-confirmed)) |
| Runtime tiers | WASM (Pyodide) + sysbox container | A middle tier would need its own dispatcher and state model ([Execution](#execution-two-tiers-confirmed)) |
| Container runtime | Sysbox (not plain runc) | Coding delegation already runs its daemons, and user namespaces keep container root unprivileged on the host ([Alternatives for tier 2](#alternatives-for-tier-2)) |
| microVM (Firecracker) | Deferred | Personal scale, trusted codegen. Overkill until trust boundary widens. |
| Warm pool | Reusable workers, the pool built on the first tier-2 invocation | A 1–2 s start on every invocation is user-visible; with `min = 0` by default only the first invocation after an idle period pays it ([Warm pool](#warm-pool-confirmed)) |
| Storage | A git-backed library in a user-owned local bare repo, mirrored to a required remote | Diffs, rollback and audit; the local repo is authoritative for `register`, the remote is the off-host copy ([Repo location](#repo-location)) |
| Cogmo as git server | No | [Repo location](#repo-location) → Where it does not live |
| Repo history | Append-only, no force push | Enforced by the bare repo's `pre-receive` hook and the remote's protection on `main`, which Cogmo's identity bypasses for the rollback mirror ([Repo invariants](#repo-invariants)) |
| Review model | Risk-tiered auto-apply (`auto` / `notify` / `approve` / `blocked`); agent reviewers in place of the human tap; `approve` opt-in per class | Nobody reads skill code, so the classifier makes what may auto-apply explicit, and mechanical gates and a cross-family panel stand where the tap was ([Risk tiers](#risk-tiers-without-a-human)) |
| Authoring lifecycle | Its own state machine (`skill_drafts`), reusing the pipelines' gate and loop patterns | Its stages are fixed code and fixed roles; the pipelines' loops and coding stage are unbuilt; its per-state data needs its own CHECKs. |
| Human interaction | One spec gate per draft, its card re-posted per revision; an edit that keeps the live manifest skips it | Purpose, I/O, effects, secrets, hosts and schedule are what a human can judge without reading code ([Spec phase](#spec-phase)) |
| Reviewers | The author's model in a fresh session plus the other family's; round 0 plus up to 3 revisions, 6 with Extend | Self-preference bias makes the author's family the weakest sole judge; self-repair is limited by critique quality ([Review stage](#review-stage)) |
| Prompt practices | Each has a mechanical twin in the verify stage | Prompts are advisory; gates are deterministic |
| Classifier execution | Branch + `register` RPC | A branch is not a deploy; register is atomic, synchronous and authoritative, with no repo watcher. A pre-commit hook waits until feedback lag hurts ([Where the classifier runs](#where-the-classifier-runs)) |
| Who advances `main` | Only Cogmo | [Repo invariants](#repo-invariants) |
| Concurrency on register | Advisory lock per skill name + pending-deploy check | [Deploy lifecycle](#deploy-lifecycle-confirmed) |
| LLM tool surface | One tool per skill, rebuilt each turn | [One tool per skill](#one-tool-per-skill) |
| Manifest | One `SkillManifestSchema` parsed from `SKILL.md` frontmatter | Register, the classifier, the populator, the dispatcher and the tool registrar read one schema, so no field drifts |
| State reset | Fresh processes per task from a pre-imported supervisor; per-skill `recycle` opt-out | Module state, threads and fds cannot cross tasks, at a few ms per task against a container's 1–2 s ([State reset between tasks](#state-reset-between-tasks-confirmed)) |
| Skill discovery | Progressive disclosure | [Skill discovery](#skill-discovery-at-llm-time) |
| Resource budgets | Declared in `SKILL.md`, within tier ceilings | [Resource budgets](#resource-budgets-proposed) |
| Cost | Measured per run; budget enforcement unbuilt | [Cost tracking](#cost-tracking-proposed) |
| Cron failure handling | `error_kind` classes | [Run failures](#run-failures) |
| Tier-1 boundary | Pyodide in a forked, permission-restricted child | [Tier-1 boundary](#tier-1-boundary-proposed) |
| Contracts | pydantic `Input` / `Output`; one generated `cogmo_ctx` | [Contracts](#contracts-proposed) |
| Inter-skill composition | Not in v1 | [Inter-skill composition](#inter-skill-composition) |
| `ctx` surface | What `CTX_METHODS` lists | [v1 surface](#v1-surface) |
| Invocation | Inngest events and cron | Durable execution, retry and scheduling, as the rest of Cogmo uses them |
| Output delivery | JSON in the tool result; binaries through `AttachmentStore` once `ctx.attachments` exists | The `generate_image` pattern |
| Host access | `ctx` projected over the task channel | Mirrors the TS `Service` for in-process tools |
| Secrets access | Pull model gated by the manifest; bound secrets as placeholders | The manifest gating its own access is the skill declaring its own permissions, which is why risk tiering and the egress allowlist carry the weight ([Secrets: pull model](#secrets-pull-model)) |
| Secrets storage | The encrypted `secrets` table | No external vault at personal scale ([infrastructure.md](infrastructure.md#secrets-confirmed)) |
| Egress enforcement | One token-injecting forward proxy, mockttp in `cogmo serve`; tier-2 workers on an internal network | In-process by the owner's choice, sharing the agent's event loop: no bridge and no second runtime; a `mitmdump` child is the fallback ([Egress proxy](#egress-proxy-proposed)) |
| Substitution sites | Header and query only; never a request body | The owner's decision: a credential that must travel in a body stays `raw_secret` |
| Non-HTTP egress | Denied: tier 2 gets no raw TCP route | The owner's decision: the proxy speaks HTTP/1.1, and a skill needing SMTP or a database protocol does not run |
| Dependencies | `pkg==version` pins, a hash-pinned `requirements.lock`, `uv` in the runtime image, compiled at register in a short-lived sandbox session | `uv` creates venvs fast, pins hashes natively and is the same binary at register and populate; a venv per lockfile, not an image per skill, keeps the warm pool's economics ([Dependencies](#dependencies-confirmed)) |
| Dep cache | A venv per lockfile hash under `/skill-venvs/`, storage per backend, published by `.ready` and `mv -T`, collected by reachability | [Cache layout](#cache-layout), [Populate](#populate), [Cache reachability](#cache-reachability) |
| Source distributions | Forbidden (`--only-binary=:all:`) | Sdists run install-time code and need a build toolchain; an opt-in escape hatch waits for a real driver, its tier decided then ([Populate](#populate)) |
| Venv overlay vs `--target` | A venv per lockfile | `--target` has namespace-package collisions ([pip #10629](https://github.com/pypa/pip/issues/10629)), inert `.pth` files and no console scripts |
| Tier 1 deps | `micropip.install` at worker init with a version check; `[proposed]` host-fetched, hash-checked wheels | [Tier 1 (WASM)](#tier-1-wasm), [Tier-1 boundary](#tier-1-boundary-proposed) |
| Private mirror, attestation verification | Deferred (`[research]`) | [Security posture](#security-posture) |

## Open questions

Calibration-grade — settle during real usage, not before implementation:

- **Risk classifier thresholds** — starting boundary between `notify` and `approve` is a first pass. Relax or tighten based on observed false positives / actual incidents.
- **Pool sizing** — `min=0 / max=3`, replace every 500 tasks, 30 min idle shutdown are starting values. `min` and `idleShutdownMs` are operator-tunable via `COGMO_SKILLS_POOL_MIN` / `COGMO_SKILLS_POOL_IDLE_SHUTDOWN_MS` (see Warm pool). Tune on real workload.
- **C extensions under per-task processes** — track which need `isolation: recycle`. If the list grows large, flip the default.
- **Retrieval-layer trigger** — when to add `search_skills()` (tool-list tokens > ~5k? selection accuracy drop?). Add metric first; threshold later.
