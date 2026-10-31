# Skills `[proposed]`

Execution runtime, storage, and invocation for agent-authored skills — small Python programs the agent writes to accomplish recurring tasks.

> *Sandbox API names below (`Sandbox interface`, "sysbox container spawn (via Sandbox interface)") reflect the current code. The canonical interface contract is [sandbox.md](sandbox.md) → Backend Architecture, where `SandboxClient` / `SandboxSession` is the in-flight refactor target. Tier-2 workers will switch to `SandboxClient.create()` when the refactor lands.*

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

Once the agent can evolve (evolution stage 2+), it writes small programs to handle recurring tasks: "fetch calendar and summarize", "check spending weekly", "post a reminder to Slack". These are *skills* — persisted code the agent invokes via a tool or schedule.

The question this doc answers: **what runtime executes them, and how?**

## Language: Python `[proposed]`

Skills are Python programs.

**Why Python, not TypeScript:**

- Larger codegen training distribution — LLMs write noticeably better Python than TS for script-shaped tasks.
- Full data/ML/scripting ecosystem (pandas, numpy, most vendor SDKs are Python-first).
- Stdlib covers more script territory out of the box (CSV, datetime, subprocess, `os.path`).
- MCP tooling and most agent tooling is Python-native.
- Reads like pseudocode — matters when the LLM composes it.

TS isn't ruled out forever; revisit if a concrete driver appears (host-registering typed tools, V8-isolate density). No near-horizon need.

## Execution: two tiers `[proposed]`

Skills execute in one of two sandboxes, chosen by skill metadata. No middle ground (no bare subprocess tier), no third tier unless a concrete need appears.

### Tier 1 — WASM (Pyodide)

**Used for:** skills that only need HTTP through `ctx`, stdlib, and pre-built / pure-Python packages.

**Why:** glue code without a container boot. Each invocation starts a fresh worker thread and Pyodide, about 5 s today, most of it micropip fetching dependencies from PyPI. Tier 1 is not an isolation boundary yet: the worker shares the host's environment and its `js` bridge reaches the host's globals ([Tier-1 boundary](#tier-1-boundary-proposed)).

**Constraints:**

- No `subprocess`, no shell-outs, no native binaries
- Packages limited to Pyodide's [pre-built list](https://pyodide.org/en/stable/usage/packages-in-pyodide.html) (~200+ including numpy, pandas, cryptography, sqlalchemy) plus pure-Python wheels installable via `micropip`
- The full CPython standard library is importable directly — `ssl`, `sqlite3`, `lzma`, `hashlib` and the rest ship inside `python_stdlib.zip` rather than as separately-loadable `cpython_module` entries, so a skill imports them with no `loadPackage` call and no manifest declaration
- No sockets. The stdlib imports fine (previous bullet), but the modules that open a connection — `urllib.request`, `http.client`, `ftplib`, `smtplib` — have nothing underneath them, so HTTP goes through `await ctx.http.get(url)`, performed by the host. `wasm-lint` rejects those specific modules at deploy time, turning what would be an error on first invocation into a clear rejection. Network-free parts of the same packages (`urllib.parse`, `urllib.error`) are unaffected
- No `os.fork`, limited threading

**Typical coverage:** REST calls through `ctx.http`, data transforms, JSON/CSV manipulation, plotting. Roughly the "glue code + data" slice of skills. Vendor SDKs (Anthropic, OpenAI, Slack, Google) belong in tier 2: they reach for `httpx`/`requests` internally, which need the sockets this tier does not have, and cannot be redirected through `ctx`.

### Tier 2 — Sysbox container

**Used for:** skills that need `subprocess`, native binaries, arbitrary pip wheels with C extensions, or full-OS isolation.

**Why:** full Python + OS ecosystem, hardened namespaces (user namespaces = root-in-container ≠ root-on-host), consistent with the runtime already chosen for coding delegation. Full [sandbox.md](sandbox.md) infrastructure reused. The `cogmo-skills:<version>` runtime image carries `uv` so register-time compile and first-invoke populate run the same resolver inside the sandbox — see [[Dependencies]].

**Constraints:**

- Higher resource overhead (~100–300 MB per worker for Python + imports)
- 1–2s cold start if not warm — addressed by the warm pool
- First task using a new lockfile hash pays a one-time populate cost (single-digit seconds for typical dep sets); shared across all subsequent tasks and skills with the same lockfile

### Why unify on sysbox (not plain runc) for tier 2

Sysbox was selected for coding delegation because Claude Code needs Docker-in-Docker. Skills don't need DinD, so plain `runc` would work. But:

- Sysbox-mgr and sysbox-fs daemons already run (~50 MB fixed cost).
- Per-container overhead vs `runc` is ~5–10 MB — negligible once the daemons exist.
- User namespaces give skills root-in-container ≠ root-on-host as a free security win.

So: unify on sysbox. One runtime to operate, consistent policy.

### Why not microVM (Firecracker)

Considered and deferred:

- Stronger isolation (separate kernel, HW virtualization) — but the threat model is "my agent's codegen misbehaves," not "untrusted adversary trying to escape." Sysbox namespaces are sufficient for that threat model.
- 128 MB minimum guest RAM per instance — meaningful overhead at personal scale.
- New toolchain (firecracker-containerd, rootfs images, virtio-fs volumes, TAP networking) — full ops story to rebuild.

Revisit if the trust boundary widens (public skill library, remote-triggered third-party skills).

### Resource budgets `[proposed]`

Per-skill caps on memory, CPU, wall-clock. Enforced at runtime, declared in `SKILL.md` frontmatter (optional — defaults apply if absent).

| Tier | Memory | Wall-clock | CPU | Mechanism |
|-|-|-|-|-|
| **WASM** | 128 MiB of linear memory | 30 s | n/a (single-threaded isolate) | No memory cap exists today: `Worker` `resourceLimits` cap only the JS heap, never the ArrayBuffer that WebAssembly memory is, and tier 1 sets none. The cap is the `WebAssembly.Memory.grow` hook in [Tier-1 boundary](#tier-1-boundary-proposed). The host's wall-clock timer writes the interrupt buffer; a tight loop that never reaches a JS↔WASM boundary ignores it, so the hard stop is terminating the worker. |
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

Overrides validated at deploy against a per-tier hard ceiling (e.g., ≤2 GB memory, ≤10 min wall-clock) to prevent runaway declarations.

### Tier-1 boundary `[proposed]`

**Today `[confirmed]`.** Tier 1 is not an isolation boundary. `host.ts` starts a `worker_threads` Worker with no `env`, `execArgv` or `resourceLimits`, so the thread holds a copy of the server's environment, the master key included. `worker-entry.ts` calls `loadPyodide` without `jsglobals`, so Python's `js` module is the thread's `globalThis`: `js.process.env`, an unguarded `fetch` the SSRF guard never sees, and `pyodide.http.pyfetch` on top of it. `pyodide_js.FS.mount(NODEFS, …)` mounts host paths. Every JS proxy's `.constructor` is the `Function` constructor, so JS code built from a string runs in the host's global scope. `wasm-lint` has no rule for `js`, `pyodide_js` or `micropip`. What holds is the CPU bound: the interrupt buffer raises `KeyboardInterrupt` within milliseconds at the next JS↔WASM boundary, and `worker.terminate()` ends a loop that never reaches one.

**Layers**, in the order they ship. Each closes a route the others leave open, and a test per layer turns the others off and shows its route closed.

1. **A forked child process per worker**, launched with `--permission`, `--allow-fs-read` for the Pyodide distribution and the worker's read-only wheel directory, `--allow-worker`, and `--disallow-code-generation-from-strings`. It is granted no `--allow-fs-write`, `--allow-child-process` or `--allow-net`, so `fetch` throws `ERR_ACCESS_DENIED` and `FS.mount(NODEFS)` reaches nothing outside the grant. The V8 flag makes the `Function`-constructor path throw `EvalError`; Pyodide evaluates no JS string once loaded. Pyodide runs on a worker thread inside the child, created with an `execArgv` that re-lists the child's flags (an explicit `execArgv` otherwise drops the grant), so the child's main thread can write the interrupt buffer. Emscripten's boot calls `process.binding("constants")`, which `--permission` denies, so the child shims it with `os.constants` before `loadPyodide`. The Node permission model's own docs say it does not stop malicious code: symlinks are followed out of granted paths, which is why the host writes the wheel directory without links, and inherited file descriptors bypass it, which is why the child inherits only the IPC channel. It is one layer of several, not the boundary on its own.
2. **`env: {}`** for the child.
3. **Minimal `jsglobals`**: a frozen null-prototype object holding only `setTimeout` and `clearTimeout`, which `webloop` needs for the asyncio loop that `ctx` RPCs await. `ctx` crosses through the registered `__cogmo_bridge__` module, which `jsglobals` does not affect.
4. **No network from the start.** The host fetches the lockfile's wheels from PyPI, checks each against its `requirements.lock` hash (closing micropip's missing `--require-hashes`), and writes them to a per-lockfile-hash directory the child can only read. The child installs from that copy. Before skill code runs, the child deletes `fetch`, `XMLHttpRequest` and `WebSocket` from its globals, so a hole in layer 1 still finds no network API. Pyodide's built-in packages (pydantic among them) come from a `packageCacheDir` the host fills with `checkIntegrity` on.
5. **Memory.** Worker `resourceLimits` cap only the JS heap, never ArrayBuffers, and WebAssembly memory is one: a measured worker with a 64 MB JS heap limit grew Pyodide to 3.2 GB. Before `loadPyodide`, the child patches `WebAssembly.Memory.prototype.grow` to throw past `resources.memory_mb` (128 MiB by default, re-measured with pydantic loaded); Python sees a `MemoryError` and the interpreter survives. A per-child cgroup is the process ceiling where the deployment delegates one (the same delegation [sandbox.md](sandbox.md#hierarchical-enforcement-via-cgroup-parent-confirmed-slice-naming--assignment--proposed-aggregate-budget-enforcement) defers). `RLIMIT_AS` is not used, since V8 reserves guard regions far larger than the heap.
6. **CPU**, as today: the interrupt buffer at `wall_clock_s`, then `SIGKILL` of the child, which a CPU loop with no JS↔WASM boundary cannot outlast.
7. **Lint**: `wasm-lint` rejects imports of `js`, `pyodide_js`, `pyodide.ffi`, `pyodide.code`, `pyodide.http` and `micropip`; the verify stage rejects dynamic code. Lint is the UX layer that tells an honest author why, not a boundary.

**What it still cannot promise.** Resource exhaustion the layers do not meter (file descriptors, recursion depth, timer churn) is bounded only by the wall clock, the kill and, where present, the cgroup. Side channels between processes on one host are out of scope. The interrupt buffer is a `SharedArrayBuffer` shared with the host; the host only writes it. An escape past all seven layers lands in an unprivileged Node process with no network, no writable path and no secrets in its environment.

**Cost.** Nothing per invocation beyond today's spawn: every layer is a launch argument or work done before `ready`. A child costs about 200 ms to start and 1 s to boot bare Pyodide, against the ~5 s a worker thread spends today, mostly on micropip fetching from PyPI. The pydantic wheels add about 190 ms per cold child.

**Pool.** A warm child serves one task and exits, so module state, `sys.modules` and MEMFS never cross tasks. Memory snapshots cannot carry dependencies: `makeMemorySnapshot` is private API, and snapshotting after `loadPackage` throws (`Unexpected hiwire entry`). So the pool pre-boots children rather than restoring them: per lockfile hash, keeping `min = 1` for the empty set and for recently used hashes, `max` shared with tier 2's, with dependency warmth from the wheel directory. A bare snapshot cuts boot from ~1 s to ~115 ms and is adopted only if Pyodide makes the API public.

## Warm pool `[confirmed]`

The container tier is warmed from day 1. A 1–2s cold start on every interactive skill invocation is user-visible latency. The dispatcher abstraction also removes the need for a sync/async tier split — one pool handles both uniformly.

Implementation lives across two trees. The TypeScript host in `src/skills/worker-sysbox/` (`pool.ts` for lifecycle, `worker.ts` wraps a long-lived `SandboxSession` running the python supervisor) and the Python runtime in `images/skills/` (a real `cogmo_skills_runtime` package with `pyproject.toml`, `uv.lock`, ruff + pyrefly + pytest, multi-stage Docker build that bakes the venv into `cogmo-skills:<version>` at `/opt/cogmo-skills/.venv`). The TS worker spawns the supervisor via `python3 -I -u -m cogmo_skills_runtime` — `__main__.py` calls `supervisor.main()`. The runner starts the pool on the first tier-2 invoke and `shutdown()` tears it down; see [Sizing](#sizing-confirmed) → Lazy pool init.

The worker needs a stdin-attached exec that streams both ways. Daytona's PTY exec buffers stdin until it ends (see [sandbox.md → Streaming exec](sandbox.md#streaming-exec-confirmed)), so the supervisor never starts there and worker creation fails at the handshake: the container tier runs on the local-Docker backend only.

### Shape `[confirmed]`

| Piece | Responsibility |
|-|-|
| **Pool manager** (`SysboxWorkerPool`) | Lease idle workers to tasks; queue beyond `max`. Scale between `min` and `max` on demand. Replace a dead worker at once, back up to `min`. Retire workers after N tasks or T ms age. Sweep idle workers above `min`. The shell around a pure state machine; see [Pool lifecycle](#pool-lifecycle-confirmed). |
| **Worker** (`SysboxSkillWorker`) | One sysbox container with a `SandboxSession`, reused across many tasks. Spawns the python supervisor process ONCE at create-time via `session.execStreaming` and refuses it unless it announces the host's protocol version. `invoke()` returns once the supervisor's `task_exited` confirms the task's processes are gone, or the worker dies. |
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

**Why not subinterpreters (PEP 734).** Researched in 2026-05; ecosystem isn't ready. NumPy and pandas don't support `Py_mod_multiple_interpreters` yet (numpy/numpy#24755 estimates "~a year of rewrite"); cross-interp asyncio bridging is hand-rolled (no stdlib recipe); zero production adopters. At ~50 ms per task against a few ms here, there is no latency win to justify the bridge complexity and ecosystem fragility. Revisit when (a) NumPy ships subinterp support, (b) at least one notable project ships it in production, (c) async-aware queue API lands in stdlib. Probably 3.16+ (late 2027).

**Why not recycle every task.** A container per task gives the same guarantees plus a clean filesystem, but costs a container start per invocation (1–2 s on sysbox) — the latency the warm pool exists to remove. The relay and the process-tree kill cost a few milliseconds per task and keep the pool.

**Why not `multiprocessing` / `pebble`.** Tried; rejected. `multiprocessing.process.BaseProcess._bootstrap()` unconditionally calls `util._close_stdin()` in every worker child regardless of `fork` / `forkserver` start method, and neither library kills a task's descendants or keeps the host channel out of the task's reach — the two properties the relay exists for. The hand-rolled supervisor is stdlib-only Unix code (`os.fork`, `os.pidfd_open`, `selectors`, `prctl` through `ctypes`).

**Per-skill opt-out** — `isolation: recycle` in `SKILL.md` retires the worker after the task runs, and the pool replaces it, so the next task gets a fresh container, filesystem included. The `isolation: subinterpreter` enum value is treated as the default; reserved for a future runtime that actually uses PEP 734.

| Mode | Today (shipped) | When to use |
|-|-|-|
| `subinterpreter` (default) | Process-per-task isolation; worker stays reusable. | Default for all skills — fork inherits the supervisor's pre-imports cleanly. |
| `recycle` | Process-per-task + worker retired after the task and replaced. | Skills that leave files the next task must not see (rare). |

**Not used:** logical reset (`importlib.reload` + globals clear). Too leaky — misses library state and monkey-patches. Present in the option space but never the right answer.

### Sizing `[confirmed]`

`DEFAULT_POOL_OPTIONS` in `src/skills/worker-sysbox/pool.ts`:

| Parameter | Default | Env override | Notes |
|-|-|-|-|
| `min` (always warm) | `0` | `COGMO_SKILLS_POOL_MIN` | Workers exist iff there's an active or recently-active task. Pool itself is lazy-constructed on first tier-2 invocation. Trade-off: first invoke per idle period pays a cold start (~1–2 s on sysbox). Set `1` for steady-state ~300 ms interactive latency at the cost of one always-running worker. |
| `max` (hard cap) | `3` | — | Personal scale — concurrent skill invocations rarely exceed. |
| Spawn-on-demand | up to `max` | — | When no idle worker is free, spawn one up to `max` rather than queuing. Personal-scale latency wins over backpressure economy. |
| `recycleAfterTasks` | 500 tasks | — | Bounds container drift (tmpfs, log accumulation, allocator fragmentation). |
| `recycleAfterMs` | 24 h | — | Wall-clock ceiling — catches workers that ran few tasks but sat warm forever. |
| `idleShutdownMs` | 30 min | `COGMO_SKILLS_POOL_IDLE_SHUTDOWN_MS` | Idle workers above `min` get reaped. With `min=0` the pool drops to zero idle workers; useful where a warm worker is a billable sandbox. |
| `idleSweepIntervalMs` | 1 min | — | Sweep cadence. |

**Lazy pool init.** The pool itself isn't constructed until the first tier-2 invocation — `cogmo serve` boots without spinning anything up on the configured sandbox. Concurrent first-callers share one in-flight construction; an init failure clears the in-flight reference so the next invocation retries. This keeps an unreachable sandbox from failing boot for deployments that may never invoke a tier-2 skill. `SkillRunnerImpl.shutdown()` waits for a construction in flight, disposes the pool, and refuses any tier-2 invoke after it; `cogmo serve` calls it on exit, before the sandbox shuts down ([infrastructure.md → Shutdown](infrastructure.md#shutdown-confirmed)).

Starting values; revisit with usage data. Skills that declare `resources.{cpu_shares,memory_mb}` overrides bypass the pool — they get a fresh, per-skill-resource-budget container, paying the cold-start every invoke. Most skills don't override and ride the warm path.

### Tier 1 pool `[proposed]`

WASM workers are not pooled today: each invocation spawns a fresh worker thread and boots Pyodide, about 5 s. The pool is pre-booted single-use children, specified with the boundary they run in ([Tier-1 boundary](#tier-1-boundary-proposed) → Pool).

## Skill storage `[proposed]`

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

**Why local-authoritative with synchronized remote (rather than remote-authoritative):**
- Filesystem `update-ref` is atomic and provider-agnostic. Routing `register` through a provider API (`octokit.git.updateRef`, Gitea API equivalent) would couple Cogmo to per-forge clients for the one operation we most want to keep crisp.
- A network blip during the post-`register` push degrades to "register succeeded locally, remote sync deferred" — the local DB row and bare repo are consistent; the next `register` or a manual `git push origin main` reconciles. No half-committed states.
- The original v1 design relied on filesystem `update-ref` for atomicity. Keeping that, plus the new push leg, preserves the invariant while unblocking the cloud-sandbox transport.

**Why a remote at all (even for local-Docker bind-mount users):** off-host backup of the agent's skill library. A single-host failure should not erase the operator's accumulated personalisation. The marginal setup cost is one URL during the wizard.

**Provider-agnostic in the steady state:** every code path past setup uses plain `git` — clone, push, fetch — with credentials supplied via the askpass helper. The only provider-specific surfaces are (a) the wizard's optional GitHub auto-provision step and (b) the PR opener (`design/coding-delegation.md` → Merge gate), which currently knows only GitHub; non-GitHub remotes still receive pushes, with the PR step degrading to "branch pushed, open the PR yourself."

**Why not inside the Cogmo repo:** skills are personal, per-deployment. Committing them to a fork of Cogmo creates merge conflicts on upstream pull, leaks private workflows through misconfigured remotes, and couples release cadences that naturally diverge.

**Why not a single shared `cogmo-skills` repo across users:** personal skills shouldn't sit in a shared public repo. The auto-provision flow creates a *private* repo under the operator's own account — the model is "each operator owns their own `cogmo-skills`," not "Cogmo project hosts a shared one."

**Why no git server in Cogmo:** most commits auto-apply directly to `main` (see risk tiering below), so there's no PR UI to build. Operators bring their own forge (GitHub, Gitea, etc.) — Cogmo doesn't reimplement that surface.

**Bundled base skills:** none initially. Agent bootstraps by authoring skills as needed. If patterns emerge that should ship with Cogmo, promote them to a `base-skills/` directory inside the Cogmo repo in a later iteration.

### Repo invariants

Hard rules enforced on the skills repo:

- **`main` is advanced only by Cogmo** — its `register` RPC, and the toolchain commit at boot ([Verify stage](#verify-stage)), which deploys no skill. Direct pushes to `main` from any other source (agent, human, tool, CI) are rejected unconditionally. Agents work on feature branches; the orchestrator is the sole merger. This makes "classified and live" atomic with "present on `main`" — no transient "committed but rejected" state can exist.

  **Primary enforcement: remote-side branch protection.** The operator configures `main` protection on the remote (GitHub branch protection rule; Gitea/Forgejo equivalent). The agent's sandbox-side pushes target feature branches (`cogmo/<idShort>`), so they never attempt `main`; Cogmo's `register`-side push uses an authenticated identity with bypass so the legitimate path still works.

  **Secondary enforcement: bare-repo `pre-receive` hook.** Installed by `bootstrapSkillsRepo` against direct `git push <bare-repo>` from a misconfigured CI script or operator typo. In normal operation the hook is bypassed — `register` uses filesystem `update-ref`, and `fetchFeatureBranch` uses `git fetch` (write-side ref update with no `receive-pack`). The hook is defense-in-depth, not the primary gate.

  `register` is a two-leg operation: `git update-ref refs/heads/main <sha>` on the bare repo's filesystem, then `git push origin <sha>:refs/heads/main` to the remote. Push failure surfaces to the operator and leaves the local advance in place; the next `register` (or a manual push) reconciles. The filesystem-write path is the sole merge mechanism and is available only to Cogmo.

- **No force push, no history rewrite on any branch.** `skill_deploys.git_sha` references point to specific commits — if history is rewritten, those SHAs dangle and the live skill becomes uninvocable. Enforced by:
  - The bare-repo `pre-receive` hook (non-fast-forward rejected on every branch).
  - Remote branch protection (GitHub "do not allow force pushes" / "require linear history"; Gitea/Forgejo equivalent).
  - Coding delegation's sandbox proxy refuses any `git push --force`, `git push -f`, or `git update-ref` that would rewrite a reachable commit on its worktree side too.

- **Append-only branches.** Every deploy is a commit added to a feature branch, then merged fast-forward into `main` by `register`. Rollbacks update `main` to a prior SHA (still fast-forward-compatible via `--force-with-lease` from the Cogmo side; to outside observers, main simply moves).

- **Signed commits (optional).** If the user configures commit signing, Cogmo verifies signatures on `register` and refuses unsigned commits. Not required v1.

### Per-skill structure

Follows the Anthropic SKILL.md standard for progressive disclosure (see [integrations.md](integrations.md)):

```text
skills/
  summarize-email/
    SKILL.md             — name, description, when-to-use (retrieval key)
    skill.py             — entrypoint
    requirements.lock    — `uv pip compile`-generated, hash-pinned; see [[Dependencies]]
    test_skill.py        — a test per spec example; the verify stage runs it
  check-spending/
    SKILL.md
    skill.py
    ...
```

### SKILL.md schema `[proposed]`

The canonical manifest. Every `SKILL.md` is parsed on `register` against `SkillManifestSchema` — a single Zod schema that's the source of truth for the deploy contract. Scattering field definitions across sections is how they drift; one schema prevents that.

**Industry reference points** for where the shape comes from:

| Source | Fields adopted |
|-|-|
| **Anthropic SKILL.md standard** (Dec 2025) | `name`, `description`, progressive-disclosure body structure. We're a superset — a plain Anthropic SKILL.md is a valid Cogmo manifest modulo the required `tier` / `inputs`. |
| **MCP tool manifest** | JSON-Schema-style `inputs` / `outputs`. |
| **OpenAI function calling** | `description` as the LLM-facing hook; input schema is what the model sees. |
| **AWS Lambda / Cloud Run** | `resources` shape (`memory_mb`, `wall_clock_s`, `cpu_shares`). |
| **Prefect / Airflow / Temporal** | Cron `schedule` semantics; append-only deploy history. |

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
isolation: subinterpreter          # subinterpreter | recycle — default subinterpreter

# Invocation — optional, all absent = manual-only
triggers: [manual, cron]
schedule: "0 9 * * *"              # required if 'cron' in triggers

# Contract — required (inputs empty {} allowed; outputs optional)
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

# Dependencies — optional; absent = stdlib only. See [[Dependencies]].
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

# Egress allowlist — absent means no network. See [[Secret exposure and egress control]].
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

**Zod schema sketch:**

```typescript
// src/skills/manifest.ts
export const SKILL_EFFECTS = [
  "reads_memory", "writes_memory",
  "reads_user_data", "writes_user_data",
  "sends_email", "sends_message", "posts_public",
  "deletes_external", "financial",
  "writes_filesystem", "spawns_subprocess",
] as const;

export const SkillManifestSchema = z.object({
  // Identity
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/).min(1).max(64),
  description: z.string().min(10).max(500),

  // Execution
  tier: z.enum(["wasm", "container"]),
  isolation: z.enum(["subinterpreter", "recycle"]).default("subinterpreter"),

  // Invocation
  triggers: z.array(z.enum(["manual", "cron", "event"])).default(["manual"]),
  schedule: z.string().optional(),   // cron expression; required if triggers.includes('cron')

  // Contract. inputs / outputs are JSON Schema objects, opaque to Zod at the
  // manifest layer — Zod only guarantees "it's a JSON object." Actual shape
  // validation at invoke time runs the declared JSON Schema against the input
  // via a real validator (ajv). outputs is optional because pure-side-effect
  // skills (cron jobs that post to Slack) have no structured return.
  inputs: z.record(z.unknown()),
  outputs: z.record(z.unknown()).optional(),

  // Dependencies — direct Python deps. Strict `name==version` only; see [[Dependencies]].
  // The regex rejects ranges, extras, URLs, git refs, and path specifiers at the
  // manifest layer. Transitive resolution lives in the generated requirements.lock.
  dependencies: z.array(
    z.string().regex(
      /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?==[a-zA-Z0-9.+!-]+$/i,
      "must be 'name==version' (no ranges, extras, URLs, or git refs)",
    ),
  ).default([]),

  // Permissions & effects
  effects: z.array(z.enum(SKILL_EFFECTS)).default([]),
  secrets: z.array(z.union([
    z.string(),                        // v1: by name only
    z.object({                         // stage 2: host-side substitution
      name: z.string(),
      binding: z.object({
        destination: z.string(),
        substitute: z.enum(["url"]).or(z.string().startsWith("header:")),
      }).optional(),
    }),
  ])).default([]),

  // Egress allowlist. Absent means no network: `ctx.http` refuses every
  // destination. Labels are bounded at 63 chars; `*.` admits subdomains at any
  // depth but not the apex; a lone `*` does not parse.
  network: z.object({
    allow: z.array(z.string().max(253).regex(
      /^(\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i,
    )).min(1),
  }).optional(),

  // Resource caps
  resources: z.object({
    memory_mb: z.number().int().positive().max(2048).optional(),
    wall_clock_s: z.number().int().positive().max(600).optional(),
    cpu_shares: z.number().int().positive().max(4).optional(),
  }).optional(),

  // Cost
  cost_per_call_usd: z.number().nonnegative().default(0),
  budget: z.object({
    daily_usd: z.number().positive().optional(),
    monthly_usd: z.number().positive().optional(),
    per_invocation_usd_cap: z.number().positive().optional(),
  }).optional(),
}).superRefine((manifest, ctx) => {
  // Cross-field validation
  if (manifest.triggers.includes("cron") && !manifest.schedule) {
    ctx.addIssue({ code: "custom", message: "schedule required when cron in triggers" });
  }
  if (manifest.isolation === "subinterpreter" && manifest.tier === "wasm") {
    ctx.addIssue({ code: "custom", message: "isolation only applies to tier=container" });
  }
});
```

**Compatibility with Anthropic's SKILL.md:** a minimal Anthropic SKILL.md with just `name` + `description` parses as an invalid Cogmo manifest (missing `tier` and `inputs`), but the *fields present* are interpreted the same. When mirroring to Anthropic's ecosystem (e.g., loading a Cogmo skill into Claude), the superset fields are ignored.

**Validation happens in five places — all reading the same schema:**

1. **`register` RPC** — parses manifest, rejects with `errors[]` on schema failure.
2. **Classifier** — reads validated manifest fields (`effects`, `secrets`, `tier`, `dependencies`) to assign risk tier.
3. **Dispatcher** — reads `inputs` schema to validate invocation arguments; reads `resources` to set cgroup/isolate caps; reads `budget` to check cost.
4. **Tool registrar** — reads `description` + `inputs` to build the LLM's per-skill tool entry.
5. **Dependency populator** — reads `dependencies` to verify the committed `requirements.lock` is current; reads it again at first-invoke to populate the venv. See [[Dependencies]].

Single schema, five consumers, zero drift.

## Risk tiering & auto-apply `[confirmed]`

Not every skill creation or edit needs human approval. Review-everything is friction the system doesn't need. Instead, each deploy is auto-classified into one of three tiers based on the manifest + a static-analysis pass; tier determines whether Cogmo merges directly, notifies, or waits for explicit approval. This section is what `computeRiskTier` does today; [Risk tiers without a human](#risk-tiers-without-a-human) replaces it once reviewers stand in for the approval tap.

### Tiers

| Tier | Matches when | Action |
|-|-|-|
| **Auto** | WASM tier, no secrets (or only read-only public-API secrets), no network, no `writes_*` / `sends_*` / `deletes_*` / `financial` effects, cost-capped | `register` fast-forwards `main` to the branch tip immediately on classification. Skill is live. No notification. |
| **Notify** | Reads user data, OR idempotent external writes (`writes_memory`, creating drafts, upserts), OR any secrets with scoped destinations, OR a `network:` allowlist without secrets | `register` fast-forwards `main` to the branch tip immediately on classification. No notification is sent today; [Notifications and undo](#notifications-and-undo) specifies one. |
| **Approve** | Container tier, any destructive effect (`deletes_external`, overwrite), external messaging (`sends_email`, `sends_message`, `posts_public`), `financial`, `spawns_subprocess`, broad permissions (3+ secrets, filesystem writes), **or any secret combined with network access at any count** | `register` leaves `main` untouched; the branch stays as-is. Through `register_skill`, Telegram gets an approval prompt with the name, declared effects, schedule and short sha, and approve/deny buttons; the auto-register path posts nothing. `main` is fast-forwarded only when `approveDeploy` fires. |

Secrets-plus-network is its own `approve` trigger rather than a count, because the count answers "how broad are this skill's permissions" while the pairing answers "can this skill read a credential and also reach somewhere to send it". `APPROVE_SECRETS_THRESHOLD` stays as the breadth signal for skills with no egress.

### Classifier

The classifier is deterministic and takes:

- **Declared effects** from `SKILL.md` frontmatter.
- **Declared secrets** + their destination bindings.
- **Execution tier** (WASM vs container).
- **Static analysis pass** — walks the Python AST for imports + call patterns the manifest didn't declare: imports of `subprocess` / `smtplib` / `stripe` / etc., calls to `os.remove` / `subprocess.run` / `open(..., "w")`, etc. Any undeclared match → `validation_errors` populated and the deploy is rejected; the author (agent or human) must declare the effect to proceed.

Output: one of `auto` / `notify` / `approve`. Recorded in the `skills.risk_tier` column and in the `skill_deploys` audit log.

#### Implementation

Static analysis runs via [tree-sitter](https://tree-sitter.github.io/) — concrete-syntax-tree parser, error-tolerant. We use the WASM build (`web-tree-sitter`) with `tree-sitter-python.wasm` vendored at `vendor/tree-sitter-python/` (extracted from `@vscode/tree-sitter-wasm` — VS Code's curated bundle). WASM over native to keep the deploy single-binary: pure-JS deps, no `node-gyp`, no prebuilt-binary-per-Node-major fragility. Cold start of the parser is tens of ms; steady-state parse of typical skill files is single-digit ms.

Detection rules live in `src/skills/ast-rules.ts` as pure data — two tables (`IMPORT_RULES` mapping top-level packages → effect, `CALL_RULES` mapping `(object?, attr)` patterns → effect with optional positional-arg predicates like `open_write_mode`). Adding a rule is one row; the walker in `src/skills/ast-classifier.ts` doesn't change.

**Threat model — UX gate, not security boundary.** A skill body can `getattr(__import__("os"), "system")(...)`, alias a module under a different name, or use a third-party SDK we don't have a rule for, and bypass detection. The actual security boundaries are sysbox isolation (tier-2), the `effects`-driven secret allowlist (P3.4), and the `approve` tier for risky skills. AST lint serves two narrower purposes: (1) force the manifest's `effects:` to track what the body actually does (drift catcher); (2) prove enough harmlessness to skip the human approval tap (tier promoter for `auto`). Don't try to harden it against adversarial authors — that's not its job.

**Failure mode.** Any throw from the AST path (parser load failure, walk panic, unexpected node shape) is caught at the `classifier.ts` boundary and routes through the declaration-only stub (`classifyManifestStub`). The audit log shifts `classifier_version` from `ast-1` to `stub-2-effect-aware` so an operator can spot the degradation; the deploy still completes with a conservative declaration-only tier. The stub caps its tier at `notify`. A null parse tree takes the declarations-only path instead, which can return `auto`; the verify stage's syntax gate rejects such a file before register.

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

The `register` RPC:

1. **Acquire advisory lock** `pg_advisory_xact_lock(hashtext("skill_register:" + name))`. Queues concurrent registers on the same skill name, but under REPEATABLE READ the checks below can still read state from before the winner's commit ([store-pattern rule](../.agents/rules/store-pattern.md); audit filed in `todo.md`).
2. **Fast-forward check.** Verify `main` is an ancestor of the branch tip. If not → return `{ status: "rejected", errors: ["non_fast_forward: rebase branch onto main and retry"] }`. Checked before the transaction to fail fast, and again just before `update-ref`, reading `main` afresh: the advisory lock is per skill name and `main` is shared, so a deploy of any other skill may have moved it. A deploy that moves `main` between that re-read and `update-ref` fails the compare-and-swap. Either way the transaction rolls back and the same rejection returns. `approveDeploy` does the same (`non_fast_forward_at_approve_time`); `rollback` requires `main` unchanged since its pre-transaction read, so it never rewinds past a deploy that landed meanwhile (`main_moved`).
3. **No-op check.** If `current skills.git_sha == branch tip sha` → return `{ status: "live", … }` with no side effects (idempotent).
4. **Pending-approval check.** If any `skill_deploys` row for this skill has `status = 'pending_approval'` → return `{ status: "rejected", errors: ["pending deploy exists; approve or deny first"] }`.
5. **Read + classify.** `git show <branch-tip>:SKILL.md` / `:skill.py`. Run classifier + static analysis. Validate manifest against `SkillManifestSchema`.
6. **Verify lockfile.** If `manifest.dependencies` is non-empty, `git show <branch-tip>:requirements.lock` must exist. Spawn a short-lived sandbox session, run `uv pip compile --generate-hashes --no-header` against `manifest.dependencies`, and byte-compare against the committed lockfile. Mismatch → `errors: ["requirements.lock is stale; re-run 'uv pip compile --generate-hashes --no-header' and recommit"]`. Resolver failure → `errors: ["dependency resolution failed: <stderr>"]`. The session is destroyed regardless of outcome. See [[Dependencies]].
7. **Branch by tier:**
   - `auto` / `notify` → `UPSERT skills` (including `lockfile_hash = sha256(requirements.lock)` or `NULL` if no deps), insert `skill_deploys` with `status = 'live'`, `git update-ref refs/heads/main <branch-tip>` (advances main); after the commit, best-effort, delete the feature branch and mirror. The audit trail lives in `skill_deploys.git_sha` — the branch pointer itself is not the record, so cleanup is unambiguous.
   - `approve` → insert `skill_deploys` with `status = 'pending_approval'`. `main` does not move and the branch **stays**: `approveDeploy` advances `main` onto it and `denyDeploy` leaves both; neither deletes the branch. Fire Telegram prompt.
   - Validation errors → return `errors[]`, nothing persisted.
8. **Commit** (releases lock). Return result synchronously.

RPC signature:

```typescript
interface SkillRunner {
  // `origin` (required) decides who a schedule the request puts live runs as —
  // see Run-as identity. `signal` cancels the deploy until its transaction starts.
  register(opts: {
    branch: string;
    origin: SkillDeployOrigin;
    signal?: AbortSignal;
  }): Promise<RegisterResult>;
  approveDeploy(opts: { pendingId: string; origin: SkillDeployOrigin }): Promise<RegisterResult>;
  denyDeploy(opts: { pendingId: string; reason?: string }): Promise<Result<void, DenyDeployError>>;
  rollback(opts: { name: string; toGitSha: string; origin: SkillDeployOrigin }): Promise<RegisterResult>;
  deregister(opts: { name: string }): Promise<DeregisterResult>;
  enable(opts: { name: string; origin: SkillDeployOrigin }): Promise<EnableResult>;
  list(): Promise<readonly SkillSummary[]>;
  listAll(): Promise<readonly SkillSummary[]>;  // includes disabled
  invoke(opts: { name: string; inputs: unknown; runAs: SkillRunAs }): Promise<Result<SkillRunResult, SkillInvokeRejection>>;
}

type SkillDeployOrigin =
  | { kind: "conversation"; userId: string; profileId: string }   // register_skill, auto-register
  | { kind: "user"; actor: SkillActor; conversation: SkillRunIdentity | null }  // approval tap, /enable
  | { kind: "owner" };                                              // CLI, conversation-less coding task

// Each variant also carries name, riskTier and gitSha.
type RegisterResult =
  | { status: "live" }                                              // gitSha: main's new tip
  | { status: "pending_approval"; pendingId: string; schedule?: string }  // gitSha: branch tip
  | { status: "no_op" }
  | { status: "rejected"; errors: readonly string[] };              // nothing written

type SkillRunResult =
  | { runId: string; status: "success"; output?: unknown }
  | { runId: string; status: "error"; error: string };

// Discriminated unions — typed `kind` instead of thrown `Error`s, so transport
// adapters can pattern-match without string-matching error messages.
type DeregisterResult =
  | { kind: "deregistered"; name: string }
  | { kind: "rejected"; name: string; reason: "not_found" };

type EnableResult =
  | { kind: "enabled"; name: string; gitSha: string }
  | { kind: "already_enabled"; name: string; gitSha: string }
  | { kind: "rejected"; name: string; reason: "not_found" | "no_live_deploy" };

// Why a deny resolved nothing; `status` is what the row holds instead.
type DenyDeployError =
  | { kind: "not_found"; pendingId: string }
  | { kind: "not_pending"; pendingId: string; status: SkillDeployStatus };

// Why `invoke` declined to run; nothing executed. A skill run that fails is
// not a rejection: it is a `SkillRunResult` with `status: "error"`.
type SkillInvokeRejection =
  | { kind: "not_found"; name: string }
  | { kind: "disabled"; name: string }
  | { kind: "invalid_inputs"; name: string; issues: readonly string[] }
  | { kind: "sandbox_unavailable"; name: string }
  | { kind: "inflight"; name: string; runId: string };  // see Exactly-once invocation
```

### Deploy lifecycle `[confirmed]`

The unit is a `skill_deploys` row, keyed by its id; its `status` is the `skill_deploy_status` enum. `live`, `denied` and `rolled_back` are terminal, and `live` means the deploy went live, not that it is current — the enable guard below reads it that way. While a deploy of an enabled skill is pending, its `skills` row keeps the skill's last live sha, so the live version stays live through the approval window. A first deploy has no live version: its `skills` row is inserted disabled at the pending tip and stays there if the deploy is denied, and the enable guard keeps that sha from going live without a review.

Activation is a second lifecycle this section does not model: `skills.disabled` together with whether a `live` row exists at the skill's current sha — a first deploy pending (disabled, no live row), a first deploy denied (the same), live (enabled), deregistered (disabled, live row), and the planned failure breaker — with `deregister`, `enable`, `approve` and `rollback` as its transitions. Naming it as its own state machine is a todo; until then it is an accepted residual, and the enable guard is its one explicit rule.

```
register (auto, notify) ──────────────────────────────▶ live
register (approve) ──▶ pending_approval ──approve──▶ live
                                        └──deny────▶ denied
rollback ─────────────────────────────────────────────▶ rolled_back   (a new row; the one it supersedes keeps `live`)
```

Register, approve and rollback take the skill name's `pg_advisory_xact_lock` inside the transaction. It queues them; it does not refresh the snapshot the queued transaction reads ([store-pattern](../.agents/rules/store-pattern.md)), so it is not a guard and the table below does not count it as one. Every check a use case makes before `runDeployTx` — step 2 above — belongs to the use case and is not in the table.

| Transition | Guard | Writes, in order, in one transaction | Outcome |
|-|-|-|-|
| `register` → `live` | no `pending_approval` row for the skill, read from the snapshot (stale under a concurrent register: failure modes); `main` fast-forwards to the tip | upsert `skills` at the tip; insert the row `live`; `update-ref main`. After the commit, best-effort: delete the feature branch, then mirror | `live`, `no_op`, `rejected`; a moved `main` rolls back as `non_fast_forward` |
| `register` → `pending_approval` | no `pending_approval` row for the skill (snapshot). `main` is not checked in the transaction: `applyFilesystem`, where it is re-read, runs only when the deploy goes live | insert `skills` disabled for a first deploy, else leave it; insert the row | `pending_approval` |
| `approve`: `pending_approval` → `live` | `UPDATE skill_deploys SET status = 'live' … WHERE id = $1 AND status = 'pending_approval'`, the transaction's first write; a pre-read of the row refuses one the snapshot already shows resolved before the lock is taken | the row (`approved_by`, `resolved_at`); then `skills` at the deploy's sha and manifest, `disabled = false`; then `update-ref main`. After the commit, best-effort: mirror | `live`; `rejected` with `deploy_not_found`, `skill_not_found`, or `deploy_not_pending: status is '<status>'`; a moved `main` rolls back as `non_fast_forward_at_approve_time` |
| `deny`: `pending_approval` → `denied` | `UPDATE … WHERE id = $1 AND status = 'pending_approval'`; a zero-row match re-reads the row | the row (`resolved_at`); `skills` and `main` untouched | `transitioned`; `not_found`; `not_pending` with the row's status |
| `rollback` → `rolled_back` | `main` unchanged since the pre-transaction read. The target is any commit whose manifest names the skill: no prior `live` row is required and nothing checks for a pending deploy — rollback is an owner-only CLI override of the approval gate (failure modes) | `skills` at the target sha; insert the row; `update-ref main` to the target, which rewinds past every commit after it, other skills' deploys included (failure modes). After the commit, best-effort: mirror with `--force-with-lease` | `live`, `no_op`, `rejected`; a moved `main` rolls back as `main_moved` |

Deny's outcomes are values its callers match exhaustively: `denyDeploy` returns `Result<void, DenyDeployError>`, `cogmo skills deny` exits 1 naming the miss, and a keyboard tap toasts `skill_deploy_not_found` or `skill_deploy_not_pending`. Nothing reports a resolution that did not happen. Approve and rollback carry a rejection as the `reason` string of `ExecuteRegisterResult`, which the use cases flatten into `RegisterResult.errors`: untyped, with no split between a failure that is terminal for the deploy (a manifest error) and one that only pauses it (PyPI unreachable during the lockfile compile), and the first-deploy `23505` race surfaces as a throw. `transport.skills.approveDeploy` recovers the two codes it can name by prefix and renders the rest as `skill_deploy_register_failed`. A residual (todo: tag the deploy rejection).

#### Per-state data `[confirmed]`

`resolved_at` and `approved_by` are per-state data, so two CHECKs tie them to `status` and no transition can leave a row between states.

| `status` | `resolved_at` | `approved_by` |
|-|-|-|
| `pending_approval` | null | null |
| `live` | set | the approver's identity when `approve` ran for a user; null when it ran for the owner from the CLI, and on a `register` row, which no human approved |
| `denied` | set | null |
| `rolled_back` | set | null |

- `chk_skill_deploys_resolved_at_iff_terminal` (Data model): `resolved_at` is set iff the row is terminal.
- `chk_skill_deploys_approved_by_only_live`: an approver only on a `live` row. One direction only: a `live` row without an approver is a `register` or an owner-CLI `approve`.

Each is a single field — a timestamp, a foreign key — so it keeps its natural type under CHECK rather than moving into a per-state JSONB blob ([architecture-rules](../.agents/rules/architecture-rules.md)). The `skill_deploy_status` enum holds the four states above. `0077_skill_run_and_deploy_state_checks` rewrites the type without `approved` and adds the CHECKs of both tables; its failure modes are under Exactly-once invocation → Per-state data and hold for this table too — every shipped writer (`executeRegister`, `executeApprove`, `denyPendingDeploy`, `executeRollback`) sets `resolved_at` with a terminal status and `approved_by` only with `live`. Deploy-specific:

| Failure mode | State left | Why it is safe, or the residual |
|-|-|-|
| a row holds `approved` when the migration runs | the cast to the rewritten type fails and the file rolls back whole | refused: no build has written `approved` |
| a deploy transaction in flight across the migration | its row `pending_approval` or terminal, both legal | the two `ALTER COLUMN … TYPE` steps rewrite `skill_deploys`, and a table rewrite is not MVCC-safe: a REPEATABLE READ transaction whose snapshot predates the rewrite and first reads `skill_deploys` after the migration commits sees it empty — register's pending guard sees no pending row (the duplicate-pending case under "two `register`s of one skill at once" below), approve's pre-read returns `deploy_not_found`, deny reports `not_found`. **Residual**, benign at single-user scale. `skill_runs` is altered in place and is unaffected |
| a future writer violates a CHECK at runtime (`23514`) | the deploy transaction rolls back before `applyFilesystem`, so `main` and `skills` are untouched | the error surfaces as the throw it is — a bug in the writer, not a value |

Who repeats a deploy: the Inngest auto-register caller runs `register` in one step with `retries: 0`. The `register_skill` tool is `durable: true` inside `handle-message`'s tool step (`retries: 2`); the loop hands it a `ToolCallContext.idempotencyKey`, which the handler drops, and `register` takes no key, so a crash after the commit and before Inngest records the step runs `register` again (failure modes). Every other repeat is an operator's.

| Failure mode | State left | Why it is safe, or the residual |
|-|-|-|
| `deny` of an unknown id, or of a row already `live`, `denied` or `rolled_back` (a second tap, a stale CLI call) | nothing written | the conditional UPDATE matches no row; the caller gets `not_found`, or `not_pending` with the status the row holds |
| `approve` racing a deny or another approve of the same row (two taps; a tap and the CLI) | one resolution wins and commits; the loser writes nothing | a resolution committed after the loser's snapshot raises `40001` at the loser's first UPDATE under REPEATABLE READ; the transaction rolls back and the transactor retries from a fresh snapshot, where approve's pre-read sees `denied` or `live`, and a losing deny's conditional UPDATE matches zero rows and returns `not_pending`. One committed before the snapshot is seen the same way. The guarded UPDATE being the first write is hardening: the zero-row match is a path REPEATABLE READ does not reach, and it provably writes nothing |
| two `register`s of one skill at once | mixed tiers: an approve-tier winner writes only a `skill_deploys` INSERT; a notify-tier loser's snapshot does not see it, its `skills` UPDATE conflicts with nothing and `main` has not moved, so the skill goes live at the loser's tip while the winner's row stays pending. Two approve-tier registers of an existing skill insert two `pending_approval` rows — nothing conflicts, and no index forbids it. Two first deploys hit `skills.name` UNIQUE with `23505`, which the transactor does not retry, so the loser throws. A register racing an approve or deny may read a stale `pending_deploy_exists` | the stranded pending row blocks register until it is denied; approving it goes live when it carries the tip `main` already holds (the fast-forward check passes) and is `non_fast_forward_at_approve_time` otherwise; the thrown `23505` is a call the operator repeats; the stale rejection is benign. **Residual** until the advisory-lock audit (todo): only taking the lock before the snapshot closes the mixed-tier case; a partial unique index on `(skill_id) WHERE status = 'pending_approval'`, written through `ON CONFLICT DO UPDATE`, closes only the duplicate pending rows, since the mixed-tier loser inserts a `live` row |
| `register_skill` run again by Inngest after the commit, before the step result was recorded | live tier: the second run is `no_op`, the tip being `main`. Approve tier: the second run is `pending_deploy_exists`, which the model reads as a rejection; and when the crash fell between the commit and the `skills/deploy/approval-requested` emit, no approval keyboard is posted | the database is consistent either way; the operator approves from the CLI. **Residual**: `register_skill` drops the `ToolCallContext.idempotencyKey` the loop supplies, `register` takes no key, and the emit is not part of any recovery (todo) |
| `main` moves between a deploy's checks and its `update-ref` (another skill's deploy landed) | nothing committed | `advanceMain` throws inside the transaction, which rolls back the row and the projection; the caller gets the rejection named in the transition table and retries |
| `update-ref main` succeeds inside `applyFilesystem`, then the commit fails or the process dies | `main` at the deploy's sha; the database as before the transaction — for an approve of an enabled skill, the row still `pending_approval` and `skills` at the old sha; register's feature branch still exists | the database decides what runs, so the code on `main` does not execute. Repeating converges for register and approve: `isAncestor(main, sha)` holds for the sha `main` already holds (a commit is its own ancestor), `update-ref` to it is a no-op, and register's branch is still there because it is deleted only after the commit. Rollback's database repeat converges too — `main` already equals the target, which satisfies its `unchanged` guard — but its mirror never does: the lease expects the remote at the target while the remote holds the pre-rollback sha, so every repeat's push is rejected until the manual force push below. **Residual**, against *`main` is authoritative* below: until then `refs/heads/main` and `skills.git_sha` disagree, and every other skill's branch based on the old `main` is `non_fast_forward`; if the operator denies instead — or a deny waiting on the row lock proceeds when approve's commit fails — deny writes only the row, so `main` keeps a commit whose deploy is `denied`, and the next deploy's mirror pushes it. Reconciliation is manual: rewind `main` to the sha it held before the failed transaction — the `skill_deploys.git_sha` with the newest `resolved_at` among `live` and `rolled_back` rows across all skills, or delete `refs/heads/main` if no deploy ever committed, since register handles an unborn `main` — before any further deploy; rewinding to this skill's `skills.git_sha` would drop other skills' later deploys |
| the feature branch delete after a committed register fails | the deploy is live; the branch lingers | logged as a warning; registering the branch again is `no_op` while its tip is `main`, and `non_fast_forward` once another skill has deployed — harmless either way; the branch can be deleted by hand |
| `mirrorMainToRemote` fails after the commit, or the process dies between the commit and the push | local `main` and the database agree; the remote lags | every failure in the mirror — reading `origin`, resolving the identity, the push — is caught and logged as a warning, and the deploy still returns `live`. After a register or approve the next deploy's push, or `git -C $COGMO_SKILLS_PATH push origin main`, reconciles (Repo invariants). After a rollback the remote is ahead of local `main` and every later fast-forward push is rejected; recovery is `git push --force-with-lease=refs/heads/main:<remote sha> origin main` by hand |
| `rollback` of one skill past another skill's later deploy | `main` loses the other skill's commits; its `skills.git_sha` is reachable from no ref once its feature branch was deleted; the force-with-lease mirror pushes the rewind | **Accepted residual** of the single linear `main`, against *`main` is authoritative* and the Repo invariant on dangling shas: the other skill stays invocable while git keeps the unreachable commit (whether gc against the bare repo prunes it is not established), and its next register on a branch based on the old `main` is `non_fast_forward` until rebased. Recovery is to re-register the other skill's tip from a branch rebased onto the rewound `main`. Keep-alive refs (`refs/deploys/<id>`) or a guard that refuses to drop another skill's live sha are a todo |
| `rollback` while a deploy of the same skill is pending | a `rolled_back` row and `main` at the target; the pending row stays pending, its `prior_git_sha` stale | accepted as the owner override it is: a later approve fast-forwards `main` back over the rollback when the target is an ancestor of the pending tip, and is `non_fast_forward_at_approve_time` otherwise until the tip is rebased; a deny leaves the rollback in place. A rollback to the pending tip itself puts unreviewed code live with the row still pending |
| `rollback` to a sha that never had a `live` row, then `deregister`, then `enable` | `enable` is refused with `no_live_deploy` | the enable guard matches `live` only and the rollback's row is `rolled_back`; accepted and stated at the guard, which is the one place that reads it. Counting `rolled_back` there is the alternative (part of the activation todo) |
| a `deregister` lands while a deploy is pending, then the deploy is approved (the planned failure breaker would land the same way; today `disableSkill` is called only by `deregister`) | approve writes `disabled = false`, so the skill comes back live | the order decides: a deregister committed first is in approve's snapshot and approve still flips the flag; one committed after approve disables the now-live skill, which is what it asked for. **Decision:** approve keeps `disabled` when the skill's current sha has a `live` row — the skill was disabled after this deploy was queued — and tells the approver; only a first deploy's approval enables. Until that is implemented (todo), a residual |

**Approval-gate guard on `enable`.** Re-enabling refuses (`reason: "no_live_deploy"`) when the skill's current `gitSha` has no `skill_deploys` row with `status = 'live'`. Without the guard, a denied first deploy (`skills.disabled = true`, `skill_deploys.status = 'denied'` at the rejected sha) could be smuggled past the approval gate via `/disable foo` then `/enable foo` — flipping `disabled = false` would activate code that never passed human review. A rolled-back skill passes when its target once had a `live` row, which remains in the append-only history; a rollback to a sha that was never live leaves `/enable` refused after a `/disable`, because the predicate matches `live` only (Deploy lifecycle → failure modes).

**Key properties:**

- **Branch ≠ deploy.** Agent can push any feature branch freely. Only `register` advances `main`.
- **`main` is authoritative.** Every enabled skill's `skills.git_sha` is on `main` — equal to it right after that skill's deploy, an ancestor once another skill has deployed; a pending or denied first deploy holds a sha that is not on `main`, and runs nothing. Row and ref are written in one transaction; the Deploy lifecycle names the crash points where they diverge and how to reconcile.
- **No race via direct push.** Pre-receive hook rejects non-Cogmo writes to `main`. Cogmo's own deploys of one skill queue on that skill's advisory lock, with the snapshot caveat in register step 1; deploys of different skills are settled by `advanceMain`'s re-read of `main` and its compare-and-swap.
- **Idempotent.** Registering a branch whose tip is already `main` is a no-op. Safe to retry on network timeouts.
- **Cancellable until the deploy transaction starts.** `register` checks its `signal` at its start and again just before the transaction, and the lockfile compile honours it throughout: a wait for the image ends, no session starts, and a running exec is disposed before its session is deleted. An abort seen by then stops the deploy, and `register` rejects with the signal's reason, not with a rejection the abort caused, leaving `main` and the branch untouched. These are checks, not a wall-clock cap: work between them that takes no signal (local git, the classifier, the Pyodide check's PyPI lookups) runs to its end first. Once the transaction has started, its wait on the advisory lock included, an abort only kills the mirror push to the remote, and the result stands. A skill-repo coding task's auto-register runs `register` under a 300 s deadline.
- **Git push is orthogonal.** Pushing branches to a user-configured remote (backup, multi-machine) neither triggers nor depends on registration.

## Authoring pipeline `[proposed]`

A request becomes a live tool without anyone reading its code. The human answers manifest-level questions once, on a spec card, and afterwards sees notifications. Between the approved spec and a live deploy everything is machine-checked: mechanical gates, then agent reviewers from two model families, then register's own checks as the floor no reviewer can override.

```
request ─▶ spec card ─approve─▶ author(r) ─▶ verify(r) ─▶ review(r) ─▶ register ─▶ live
                                   ▲             │            │            │
                                   └── findings ─┴────────────┴────────────┘   r < max_rounds
```

The agent's only authoring tool is `draft_skill`; `register_skill` leaves the agent surface (the CLI keeps `cogmo skills register` for the owner), and `delegate_coding` refuses `repo: "skills"`, so every skill-repo coding task belongs to a draft.

### Why its own machine

Pipelines ([pipelines.md](pipelines.md)) supply the patterns this lifecycle reuses: gates parked in the database with a bounded timeout, gate keys that refuse a stale tap, and code-owned back-edges with an iteration cap. It does not run on the pipelines engine:

- Its stages are fixed code (verify, register) and fixed agent roles, not user prose compiled into a versioned envelope.
- What it needs from the engine is unbuilt there: loops and coding delegation as a stage are pipelines slices 3 and 4.
- Its per-state data (approved spec version, round, findings, the tip under review) needs CHECKs that a generic `stage_outputs` blob cannot carry.
- A stage turn holds `pipeline` authority, which refuses `delegate_coding` ([agents.md → Turn Authority](agents.md#turn-authority-proposed)); a draft starts coding tasks from the user's tap, not from a stage.

Once pipelines can express it, the lifecycle can become a built-in definition, the same later refactor coding delegation has.

### Skill lifecycle

**Unit.** A `skill_drafts` row, keyed by its UUIDv7 `id`: one request to create a skill, or to change a live one, from the first spec to a terminal state. Its bounds are fixed when the row is inserted — the skill name, and for an edit the live `base_git_sha` — so nothing re-plans them. A round (`round`, from 0) is one authoring attempt; every write below the draft is keyed on `(draft_id, round)`, and a review on `(draft_id, round, reviewer)`.

**Rounds share a branch.** Every round's coding task works on the draft's branch, `cogmo/skill-<draftShort>`, starting from the previous round's tip and resuming its CLI session with the findings as its goal, so the draft has one PR that each round updates. Coding delegation needs two things for this: a task that starts from a given branch and session, and `open-pr` treating an existing PR on the branch as opened rather than failing on GitHub's 422.

**States** — `skill_draft_status`:

| State | Meaning | Waits on |
|-|-|-|
| `specifying` | Spec drafted, card posted; the user answers its open questions and approves it | the user, 7 d |
| `authoring` | Round r's coding task is writing the code on the draft branch | the coding task |
| `verifying` | Mechanical gates on round r's tip ([Verify stage](#verify-stage)) | a step |
| `reviewing` | The reviewer panel on round r's tip ([Review stage](#review-stage)) | steps |
| `registering` | Panel passed; the deploy is owed | a step |
| `awaiting_approval` | Register left a pending deploy, because an effect is in the owner's opt-in approve set | the owner, 14 d |
| `blocked` | An owner decision is needed; `blocked_reason` says which | the owner, 14 d |
| `live` | Terminal: the deploy went live | — |
| `abandoned` | Terminal: the user or a timeout ended the draft; `end_reason` says which | — |
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
     any non-terminal ──abandon / timeout──▶ abandoned          a draft function failing after retries ──▶ failed
```

**Transitions.** Each is a conditional `UPDATE … WHERE id = $1 AND status = <from> AND round = <r>` returning whether it happened ([state-machines.md](../.agents/rules/state-machines.md)), with the guard's other reads in the same transaction. One use-case file per transition under `src/skills/draft/`.

| Transition | Trigger | Guard | Writes |
|-|-|-|-|
| insert → `specifying` | `draft_skill` (user turn) | the spec parses `SkillSpecSchema`, else the tool returns its issues and writes nothing; no open draft holds the name (partial unique index on `skill_name` over non-terminal states, written through `ON CONFLICT DO UPDATE`) | the row, `spec_version = 1`; emit `skills/draft.spec-ready` |
| `specifying` → `specifying` (revise spec) | `draft_skill` naming a draft in `specifying` | status `specifying` | `spec`, `spec_version + 1`; the new card's gate key retires the old card's buttons |
| `specifying` → `authoring` (approve spec) | the card's Approve tap, by the requester; or automatically when the spec equals the live manifest and asks nothing | status `specifying`; the tap's gate key names the current `spec_version`; no open questions | `round = 0`, `state.approvedSpecVersion`; the round-0 `coding_tasks` row (`insertOrRecoverTask`, key `skill-draft:<id>:0`, `trigger_source = 'skill_draft'`), one transaction; then emit `coding/task/start` |
| `authoring` → `verifying` | `coding/task/pr-opened` for round r's task | status `authoring`, round r | the round's `tip_sha`; emit `skills/draft.verify` |
| `authoring` → `authoring` (r+1) | `coding/task/failed` with a terminal reason | round r < `max_rounds` | the next round and its coding task, with the failure as a finding |
| `verifying` → `reviewing` | `settle-verify`, report has no `revise` finding | status `verifying`, round r | the report on the round row; emit `skills/draft.review` |
| `reviewing` → `registering` | `settle-review` | every panel member's row for round r reads `pass` | emit `skills/draft.register` |
| `registering` → `live` | `settle-register` | a `live` `skill_deploys` row at the round's tip | `state.deployId`; emit `skills/draft.settled` |
| `registering` → `awaiting_approval` | `settle-register` | a `pending_approval` row at the tip | `state.deployId` |
| `awaiting_approval` → `live` / `abandoned` | `approveDeploy` / `denyDeploy` of that row, or the waiter's timeout (which denies) | the row's resolution | `end_reason = denied` or `approval_timeout` on `abandoned` |
| `verifying`, `reviewing`, `registering` → `authoring` (r+1) | findings: verify `revise`, any reviewer `revise` (none `block`), or a register rejection | round r < `max_rounds` | the next round and its coding task, carrying every finding of round r |
| any working state → `blocked: rounds_exhausted` | the same, at r = `max_rounds` | status, round | `blocked_reason`, `state.resumeTo` |
| `authoring`, `verifying`, `reviewing` → `blocked: *_unavailable` | a pausing failure: a coding task failing `rate_limited` or `credentials_unavailable`, a verify sandbox or a reviewer still unreachable after the step's retries | status, round | `blocked_reason`, `state.resumeTo` |
| `reviewing` → `blocked: reviewer_block` | any reviewer `block` | status, round | the verdicts stay on their rows |
| `registering` → `blocked: risk_blocked` | register classifies `blocked` ([Risk tiers](#risk-tiers-without-a-human)) | status, round | the reasons on the round row |
| `blocked` → `state.resumeTo` (retry) | the notification's Retry tap | reason is `*_unavailable`; gate key | re-emits the resumed state's event |
| `blocked` → `registering` (override) | Override tap | reason is `reviewer_block` or `risk_blocked`, or `rounds_exhausted` with round r's verify passed; gate key | `state.overriddenBy`; register accepts a `blocked` tier only with it |
| `blocked: rounds_exhausted` → `authoring` (extend) | One-more-round tap | `max_rounds` < 6 | `max_rounds + 1`, the next round |
| any non-terminal → `abandoned` | Abandon tap or tool; the waiter's timeout in `specifying` or `blocked` | not terminal | `end_reason`: `user_abandoned`, `spec_timeout`, `blocked_timeout` |
| any non-terminal → `failed` | a draft function's `onFailure` | not terminal | `end_reason = step_error`, the error text in `state.detail` |

Transitions not in the table are illegal. A tap is honoured only from the requester, with a gate key `${draftId}:${status}:${round}:${spec_version}` encoded as the pipelines' 8-hex token.

**Per-state data.** `state` is `SkillDraftStateSchema`, a Zod union discriminated on `status`, and a CHECK ties `state->>'status'` to the column. `blocked_reason` (`skill_draft_blocked_reason`) is set iff `blocked`; `end_reason` (`skill_draft_end_reason`: `user_abandoned`, `spec_timeout`, `blocked_timeout`, `approval_timeout`, `denied`, `step_error`) iff `abandoned` or `failed`. `spec` changes only in `specifying`; after approval `state.approvedSpecVersion` names the version every later check reads, and the spec card that version rendered is stored on the row.

**Functions.** Event-chained, one per working state, each with concurrency 1 keyed on the draft id. The first step claims the state (the conditional UPDATE, returning `claimed` or `stale` with the row's status); the bare body branches only on memoized results ([inngest.md](../.agents/rules/inngest.md)).

| Function | Trigger | Steps and replay cost |
|-|-|-|
| `skill-draft-on-coding` | `coding/task/pr-opened`, `coding/task/failed` for a `skill_draft` task | one step that transitions and, for a new round, inserts its coding task; the emit is a second step |
| `skill-draft-verify` | `skills/draft.verify` | `claim`, `run-verify` (one sandbox session and one tier-runtime run), `settle-verify`: the body runs up to four times, none of it billable |
| `skill-draft-review` | `skills/draft.review` | `claim`, one `review-<reviewer>` step per panel member in parallel, then `settle-review` reading the review rows, since code after a parallel group runs only in fully memoized invocations |
| `skill-draft-register` | `skills/draft.register` | `claim`, `register`, `settle-register`, which reads the deploy at the tip rather than trusting the register result, so a repeat that returns `no_op` or `pending_deploy_exists` settles the same way |
| `skill-draft-waiter` | `skills/draft.parked` | sleeps out the state's bound with two reminders, then emits the timeout; `skills/draft.settled` cancels it |
| `skill-draft-reconcile` | cron, every 10 min | re-emits the owed event for a draft whose working state is older than 30 min (`transitioned_at`); the claim makes a duplicate a no-op |

Events carry `{ draftId, round }` and the bus-dedup id `skill-draft-<id>-<status>-<round>`.

**Failure modes.**

| Failure mode | State left | Why it is safe, or the residual |
|-|-|-|
| The approve-spec transaction commits, the `coding/task/start` emit is lost | `authoring`, its coding task `queued` | a second tap on the same card re-emits (the `planGateEmission` rule, [coding-delegation.md](coding-delegation.md#plan-gate-confirmed)); otherwise the reconcile cron does. The bus id and the task's `queued → planning` guard collapse duplicates |
| A coding task fails | `authoring` at r+1, or `blocked` | a terminal reason costs a round; a pausing one parks without spending it |
| `pr-opened` delivered twice, or after the draft moved | unchanged | the claim on `authoring` and round r reads `stale` |
| `run-verify` crashes before Inngest records it | `verifying` | the step re-runs; verify writes nothing outside the step's result, so a repeat costs one more sandbox session |
| A reviewer step bills its model, then crashes before recording | `reviewing` | the retry bills once more; the review row (unique on draft, round, reviewer, `ON CONFLICT DO UPDATE` with a no-op SET) keeps the first verdict that committed. **Residual:** one re-billed review per crash |
| A reviewer stays unreachable or returns a malformed verdict after retries | `blocked: reviewer_unavailable` | never a pass on a partial panel; Retry resumes `reviewing` and re-runs only the missing member, whose row is absent |
| `register` commits, then the step result is lost | `registering` | the retry's `register` is `no_op` (live tip) or `pending_deploy_exists`; `settle-register` reads the deploy at the tip either way |
| Register rejects the tip (validation, lockfile, spec drift, `non_fast_forward`) | `authoring` at r+1, or `blocked: rounds_exhausted` | the rejection becomes a finding, so the author fixes what the floor refused. **Residual:** drafts of two skills race the single `main`; the loser's `non_fast_forward` costs it a round |
| Rounds run out | `blocked: rounds_exhausted` | the cap bounds cost; Extend grants one round at a time up to 6, Override registers only a tip that passed verify |
| A cron fire of the skill while a revision is in flight | the live version runs | a draft writes nothing to `skills` until register; each run records the `git_sha` it ran |
| A run in flight across a deploy that changes these functions | each step replays its stored result | new data rides new steps reading committed rows, never an earlier step's return value |
| Two taps, or a tap and a timeout, on one gate | one transition wins | conditional UPDATE; the loser reads `stale` and is told only if its decision did not stand |
| `draft_skill` re-run by Inngest after its commit | the same row | the tool's idempotency key (`ToolCallContext.idempotencyKey` plus a digest of the skill name) recovers it through `ON CONFLICT DO UPDATE` |
| A skills-repo coding task started before the draft machine shipped reaches `pr-opened` | no draft row | the subscriber registers it as the auto-register subscriber does today, for one release, then the path is removed |
| The requester has no reachable channel for the card | `specifying` | it times out to `abandoned: spec_timeout`; `cogmo skills drafts` lists it meanwhile |
| A draft function fails after its retries | `failed: step_error` | reported to the requester with the error; a new draft can start, since the name is free again |

**Cost bounds.** A draft runs at most `max_rounds + 1` coding tasks (default 3 + 1, ceiling 6 + 1 with Extend), each under the skills repo's `taskTokenBudget`; at most two reviews per round; and one verify sandbox session per round. Nothing loops without a round, and every wait is bounded.

### Spec phase

The spec is the contract the user approves: the manifest without code. `draft_skill` takes it from the agent, and `SkillSpecSchema` validates it — `SkillManifestSchema`'s fields, with `inputs` and `outputs` as field lists (name, type, required, description), plus at least one `examples` entry and the agent's `open_questions`. Cogmo adds the questions only it can ask: a declared secret missing from the secrets store, a tier-1 dependency Pyodide cannot load, a wildcard host on a shared zone, who a schedule runs as.

The card shows what the skill will be allowed to do, never code:

- name, description, trigger and schedule, and who a schedule runs as;
- inputs and outputs as a table, and the examples;
- effects, hosts, secrets (each bound or raw, present or missing) and direct dependencies with their category;
- the tier, and the risk tier the declarations alone predict, with its reasons;
- the open questions.

Approve appears only when no question is open; Abandon always does. The user answers in the chat, and the agent revises the spec with `draft_skill`. That conversation is the only human interaction before deploy. An edit whose spec equals the live manifest, a bug fix, skips the card.

**Drift is a rejection.** The author receives the approved spec rendered as `SKILL.md` frontmatter and may change only the body below it. Verify and register both compare the branch against `state.approvedSpecVersion`: frontmatter byte-equal to the rendering; the JSON Schema generated from `Input` and `Output` ([Contracts](#contracts-proposed)) matching the spec's field lists; hosts, secret names and effects found in the code within what the spec declares. A difference is a `spec_drift` finding naming the field. Widening a skill takes a new spec, which the user approves.

### Verify stage

Mechanical checks, run by Cogmo on the round's tip before any reviewer sees it, from configuration the author cannot edit. A failure is a `revise` finding with the check's id; every prompt-level practice in the skills repo's `CLAUDE.md` has a check here.

| Check | Mechanism | Practice it enforces |
|-|-|-|
| Owned paths | the branch changes only `SKILL.md`, `skill.py`, `requirements.lock`, `test_skill.py` | toolchain files are Cogmo's |
| Syntax | `python -I -m py_compile`; a tree-sitter `ERROR` node also fails | — |
| Entrypoint | AST: `async def run(inputs: Input, ctx: Ctx) -> Output` at module level | typed `run` |
| Contracts | AST: `Input` and `Output` subclass `pydantic.BaseModel`; their JSON Schemas generate in the tier's runtime and match the spec | pydantic contracts |
| Types and lint | `pyrefly check` against the `cogmo_ctx` stubs; `ruff check` with `E`, `F`, `B`, `BLE`, `S` (the flake8-bandit port, which stands in for bandit), `ASYNC` | failures as values: no bare or swallowing `except`, `SkillError` for expected failures |
| Imports | each import root is stdlib, `pydantic`, `cogmo_ctx`, or a module a declared dependency's wheel provides (its `top_level.txt`, read at lockfile compile) | dependencies declared for every import |
| Dynamic code | AST: `exec`, `eval`, `compile`, `__import__`, `importlib.import_module` or `getattr` on a module with a non-literal name | no code built at runtime |
| Tier-1 bridges | `wasm-lint` rows for `js`, `pyodide_js`, `pyodide.ffi`, `pyodide.code`, `pyodide.http`, `micropip` | tier 1 reaches the host only through `ctx` |
| Effects, hosts, secrets | the AST rules plus rows for `ctx.memory.*`, `ctx.files.*`, a non-GET `ctx.http`, literal `ctx.secrets.get` names and literal URL hosts, checked against the spec | the manifest says what the code does |
| Idempotency | a non-GET request without an `Idempotency-Key` from `ctx.run().key` is a `note` | external writes keyed |
| Tests | `pytest -q` passes `test_skill.py`, which has a test per spec example | tests for the examples |
| Sample call | each spec example runs through `run` in the skill's own tier runtime, with a recording `ctx`: reads return empty or fixture values, writes and egress are recorded, not performed; the output validates against `Output` and survives `json.dumps(allow_nan=False)` | output is the contract |
| Observed effects | the sample call's recorded hosts, secrets and writes are within the spec | — |
| Size | `skill.py` at most 400 lines | reviewers lose recall on large diffs, so skills stay small |
| Register dry run | `prepareRegister` without the write: manifest, ajv, lockfile compile, Pyodide compatibility | register's floor, met before review |

Static checks and `pytest` run under CPython in one short-lived `cogmo-skills` sandbox session per round, from a tools virtualenv (`/opt/cogmo-skills/tools`: ruff, pyrefly, pytest) outside the task's `sys.path`. The sandbox has no egress ([Egress proxy](#egress-proxy-proposed)). A tier-1 skill's sample call runs in the hardened Pyodide child ([Tier-1 boundary](#tier-1-boundary-proposed)), a tier-2 skill's on a warm worker. The report is `SkillVerifyReportSchema` on the round row: per check, its status and findings, plus the sample call's trace, which the reviewers and the notification read.

**The skills repo toolchain.** Bootstrap writes Cogmo-owned files to the repo root: `pyproject.toml` (Python 3.14, a `dev` group pinning the tools virtualenv's versions, ruff and pyrefly configuration), `CLAUDE.md` (the authoring convention, generated from `SkillManifestSchema` and `SKILL_EFFECTS` so it cannot drift from them), `cogmo_ctx/` stubs ([Contracts](#contracts-proposed)) and `skill.schema.json`. A Cogmo release that changes them commits them to `main` through `advanceMain` at boot, under the bootstrap lock: the one writer of `main` besides register, deploying no skill. The repo's `verifyCommand` is `uv run --locked --group dev scripts/verify`, which runs ruff, pyrefly and pytest inside the coding task so the author sees failures in its own session; Cogmo's verify stage is still the authority, since the author can edit nothing it runs.

### Review stage

Read-only reviewer agents replace the human approval tap. A panel reviews every round that passed verify:

- **The author's model**, in a fresh session with no access to the author's;
- **a model of the other family**: Codex reviews a Claude-authored draft and Claude a Codex-authored one. The author's family never reviews alone.

`SkillReviewer` is the interface (`review(input, signal): Promise<Result<SkillReviewVerdict, SkillReviewerError>>`), with a Claude Code backend (`claude -p --permission-mode plan`) and a Codex backend (`codex exec --sandbox read-only`), each in a sandbox holding the draft branch, so a reviewer can read the repo and run the tests, not just the diff. Its input: the approved spec card, the diff against the base, the verify report and trace, `classifier_log`, the previous rounds' findings, and the checklist.

**Checklist.** A fixed, versioned file (`src/skills/review/checklist.md`); its version is recorded on every review row. Each item is `revise` when it fails, and the four marked block are `block`:

1. The code does what the description and examples say, and nothing else.
2. Every external effect goes through `ctx` (or the proxy) and appears in the spec.
3. *(block)* No data leaves for a destination or purpose the spec does not state: memory, files or secrets reaching a host, a log, the output or a memory write.
4. *(block)* No destructive or irreversible act the spec does not name.
5. *(block)* No deception: code that behaves differently under test, at a date, or for an input the examples avoid.
6. *(block)* Secrets are used only at their bound destination and never transformed.
7. Inputs are validated by `Input`; expected failures raise `SkillError`; nothing swallows an exception into a success.
8. External writes carry `ctx.run().key` as an idempotency key; a retry cannot double-act.
9. Loops, pagination and retries are bounded, and requests carry timeouts.
10. Tests cover each example and at least one failure.
11. Earlier rounds' findings are resolved, not suppressed.

**Verdict.** `SkillReviewVerdict` is `{ verdict: "pass" | "revise" | "block", summary, findings: [{ item, severity: "block" | "revise" | "note", where, what, fix }] }`, validated with Zod. The verdict must equal its worst finding's severity (`note` alone is a pass); a mismatch or a parse failure is retried twice with the error fed back, then reported as `malformed_verdict`. `SkillReviewerError` is `{ kind: "unavailable"; cause } | { kind: "malformed_verdict" }`, and both park the draft at `blocked: reviewer_unavailable`. The panel passes only when every member passes. Any `block` blocks the draft; a `revise` with no `block` starts the next round with every finding. A `block` notification carries the reasons and a one-tap Override.

**Measured, not trusted.** A seeded-bug suite (`test/fixtures/skill-review/`) holds skills each carrying one defect class — an undeclared host, a secret in the output, a memory read posted out, a missing idempotency key, dynamic code, swallowed failures, an unbounded loop, an input the spec lacks — and clean controls, a third of the cases. A live-tier test runs every backend over it: each reviewer must reach the expected severity on at least 80% of seeded cases and the panel on 90%, with no `block` and at most 20% `revise` on controls. It runs when the checklist, a reviewer prompt, a model or a CLI version changes, never on PRs. Seeded defects are easier than real ones, so the floor guards against regressions; it does not measure real-world recall. A clean review is one layer, never a guarantee, which is why the egress proxy and the tier boundaries carry the security weight.

### Risk tiers without a human

`computeRiskTier` returns one of `auto`, `notify`, `approve`, `blocked`, plus the reasons (`SkillRiskReason[]`) that put it there, recorded in `classifier_log` and shown in every notification. Its inputs are the classifier log, the deployment's enforcement capabilities, and one owner setting.

| Tier | Effect at register |
|-|-|
| `auto` | Live; no message. Listed in `/skills` and the activity view. |
| `notify` | Live; a notification with undo. |
| `approve` | Pending until the owner taps Approve. Only for what the owner opted into. |
| `blocked` | Not deployed; a notification with the reasons and one-tap Override, which registers with `approved_by` set to the owner. |

`approve` is opt-in per class: `skills.approve_classes`, an owner setting holding any of `SKILL_EFFECTS` plus `raw_secret`, `reads_and_egress` and `sensitive_dependency`, empty by default.

Rules, first match wins:

1. **Rejected**, no tier: validation errors, as today.
2. **`blocked`**: the manifest needs enforcement this deployment lacks — a bound secret before the proxy substitutes, a `network:` block on a tier-2 backend without the egress proxy's network, an sdist.
3. **`approve`**: a declared or detected effect, or a reason, in `approve_classes`.
4. **`auto`**, when all hold: an edit whose manifest does not widen the live one (a first deploy always notifies); the tier's boundary is enforced (tier 1 hardened; tier 2 behind the proxy network); no write, send, delete, financial or subprocess effect; every secret bound; no read effect alongside `network:`; every dependency on the allowlist; `cost_per_call_usd = 0`.
5. **`notify`**: everything else, each reason listed. A raw secret (`raw_secret`) lands here at most, never `auto`: its plaintext is in the skill's memory, so it can leave through any allowed host, a memory write or the output, and no check sees the value. A read effect with `network:` (`reads_and_egress`) is the same pairing as a raw secret with egress.

The classifier reads capabilities as flags (`tier1Hardened`, `tier2EgressEnforced`, `bindingsSubstituted`, `reviewPanel`), never by inspecting the build, so the tier follows what is enforced while the pieces ship in order. Without `reviewPanel`, rules 2–5 give way to today's table ([Risk tiering & auto-apply](#risk-tiering--auto-apply-confirmed)), since no reviewer stands in for the tap; in either table `auto` needs the tier's boundary flag.

### Notifications and undo

One use case (`announceDeployOutcome`) serves every register caller and emits `skills/deploy/outcome` with `{ skillId, deployId, outcome, riskTier, reasons, conversationId }`; the transport renders it in the requester's conversation, or the owner's when there is none.

| Outcome | Message | Buttons |
|-|-|-|
| `live`, `notify` | `skill X is live` (new, or `abc1234 → def5678`), the description, the reasons, effects (declared and detected), hosts, secrets (bound or raw), dependencies, schedule and run-as, verify and panel verdicts with the round | Disable; Roll back for an edit, shown only while this deploy's sha is `main`'s tip, so it never rewinds another skill's deploy; Details |
| `pending_approval` | the same, and the opted-in class that holds it | Approve, Deny |
| `blocked` | the same, and the reasons | Override, Abandon |
| `rejected` | the findings, and the round it starts | — |

`auto` sends nothing. Disable is `/disable X`; Details links to the run view ([Observability](#observability-proposed)).

**Shadow first fire.** The first scheduled fire after a deploy that adds or widens a write effect runs in shadow: reads are live; `ctx` writes and every non-GET request through the proxy are recorded and answered with a fixed shadow reply instead of performed. The intents are notified (Looks right, Disable), and the run is recorded with `shadow = true`. A tool call is never shadowed: the user asked for the act in that turn and saw the deploy notification. A shadow run that fails on a shadow reply is reported and does not count toward auto-disable.

**Auto-disable.** Defect-class failures ([Contracts → Run failures](#run-failures)) at the live sha — three in a row, or half of the last ten with at least five — disable the skill with `disabled_reason = 'error_rate'` and notify with the last error: Enable, Roll back, Repair. Repair opens a draft whose spec is the live manifest, so it skips the card, with the failures as round 0's findings.

## Dependencies `[proposed]`

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

The trade-off on `per-sandbox`: each pool worker pays one cold populate per `(lockfile-hash, py-abi)` pair it sees over its lifetime (typically seconds — `httpx`-class deps are ~5 MB). With `min=1, max=3` workers and `recycleAfterTasks=500`, the worst case is N skills × 3 workers × first-invoke populate, amortised over thousands of subsequent invokes. At personal scale this is in-line with the existing Daytona snapshot warm-up cost. Cross-sandbox dep dedup (snapshot-per-lockfile bake, or per-hash pool restructure) is the future move when pool sizing changes or empirical populate cost demands it; tracked in `todo.md`. The `skill-venvs-reaper` Inngest cron similarly checks the capability and no-ops on `per-sandbox` backends — each sandbox's `/skill-venvs/` is already disposed with its container.

> **Coverage gap to rebuild if a POSIX-volume Daytona tier ever materialises.** The previous design exercised the wire surface for the `volumes` field on `daytona.create` + the `volume.get` resolve via the `wrapper-volume-mount` conformance scenario (`src/test/daytona-conformance.integration.test.ts`, `test/fixtures/daytona/wrapper-volume-mount.json`). Both were deleted alongside the production code path — no point recording fixtures for a code path that throws. If Daytona later offers a non-S3 volume tier (block-storage, EBS-style, anything POSIX-clean) and we re-enable `depsCacheSharing: "shared-volume"` on the Daytona backend, that conformance coverage needs to be rebuilt from scratch: a fresh scenario that creates two sessions, writes a sentinel in one, deletes it, and reads the sentinel back from the other. The unit-level test in `src/sandbox/daytona/client.test.ts` is not a substitute — it mocks the SDK and so misses contract drift on the real wire (field rename, `volume.get` 4xx semantics, mount-path quirks).

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

`--only-binary=:all:` forbids source distributions by default — sdists require a build toolchain in the sandbox and run arbitrary `setup.py` code at install. A skill declaring a package available only as sdist fails at register. Sdist support is a future opt-in (`allow_sdist: true` in the manifest, automatic `approve` tier) when a real driver appears.

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

Worker init (Pyodide load + micropip install + version verify) is capped at 60s by default — a hung micropip resolve against a slow PyPI surfaces as `worker_init_timeout` instead of wedging the worker. A per-lockfile-hash wheel cache for micropip-fetched wheels is deferred — Pyodide's built-in `packageCacheDir` covers the runtime's bundled packages only, so a moderately-deps'd skill re-downloads from PyPI on every worker boot today (todo.md).

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
| **Approve** | `boto3`, `paramiko`, `psycopg`, `stripe`, `requests-oauthlib`, anything matching `*-credentials` / `*-aws-*` / `crypto*` patterns | Bumps to `approve` regardless of other signals. |

Dep additions to a previously-deployed skill are widening events — re-classified, may bump tier, may require approval. Same flow as effect widening per "Edit vs create".

### Security posture

> **Precondition: tier-2 skills are mutually trusted code by the operator.** The shared `/skill-venvs` volume is mounted RW on every tier-2 worker under the same UID; any skill can write under `/skill-venvs/<other-hash>-py<X.Y>/` and pre-stage entries the next populator activates. Hash pinning at install time doesn't protect against this because the trivial bypass is `.ready`-pre-staging (creating the marker file + a stub Python layout at the path the populator will check) which skips `uv pip sync` entirely. The runtime venv (`/opt/cogmo-skills/.venv`) is outside the precondition: it is root-owned and read-only to the task UID, so a task cannot swap its `bin/python3`, first on `PATH` for the populate and reap scripts, or its `cogmo_skills_runtime`. Nothing writes there at runtime: its bytecode is compiled at build. Cogmo's v1 deployment model is single-operator with operator-authored / operator-audited skills; this section enumerates the threats accepted under that precondition. **Multi-author skill libraries require per-skill UID isolation (or per-hash bind-mount made read-only after publish) before the precondition holds.** See the `[research]` items below for the upgrade path.

- **Hash pinning via `--require-hashes`** is non-optional **on the sysbox tier**. The lockfile carries SHA-256 per wheel; `uv pip sync` refuses to install anything unhashed.
- **WASM-tier dependency install trusts public PyPI without wire integrity verification.** `micropip.install` has no `--require-hashes` equivalent and fetches wheels from PyPI's JSON API over TLS with no per-wheel hash check. A flash-malicious release between register (when uv pinned the resolution) and the first WASM-tier invocation gets installed silently — the lockfile-hash byte-compare at register catches *staleness*, not *integrity at fetch time*. Mitigation today: post-install version verification (catches silent skips and bundled-vs-pin drift) plus narrow classifier tier-bumps for security-relevant deps so anything sensitive lands on `tier: container`. Real closure requires either upstream `micropip --require-hashes` support or a sidecar pre-fetch that hash-verifies wheels and primes the cache before Pyodide opens. `[research]`.
- **`--only-binary=:all:`** forbids sdists by default. Sdists run arbitrary install-time code and need a build toolchain — both are surface the auto tier should not provide.
- **Public PyPI for v1.** Hash pinning makes the index untrusted-but-verified. A private pull-through mirror (Devpi / Bandersnatch) is the obvious next step when (a) the user base widens beyond single-operator or (b) we want quarantine windows on new package versions to catch flash-malicious publishes. `[research]`.
- **PEP 740 / Sigstore attestation verification.** 132k+ packages had attestations by Mar 2026 via PyPI Trusted Publishing. Verification via `pypi-attestations` is "free defense in depth" once the mirror is in place. `[research]`.
- **Shared venv cache assumes mutual trust between skills on the same Cogmo instance** (`shared-volume` backends only). On Local-Docker the `/skill-venvs` volume is mounted RW on every tier-2 worker. A compromised skill running in worker A can pre-stage `/skill-venvs/<hash>/bin/python` + `<hash>/.ready` for a hash it expects skill B to use; B's populate sees `.ready`, skips `uv pip sync` entirely, and activates A's venv. Hash pinning at sync time doesn't help because the sync is bypassed. Single-user / single-author scale absorbs this. Multi-author skill libraries widen the threat boundary — the upgrade path is per-skill identity (process UID per skill, or a per-skill-hash bind-mount made read-only after publish), tracked under `[research]`. `per-sandbox` backends don't share `/skill-venvs/` across workers and the cross-skill pre-stage path doesn't exist there.
- **`COGMO_SKILLS_DEPS_VOLUME` is `shared-volume`-only and multi-instance deployments must override per-deployment.** The default `cogmo-skills-deps-cache` is right for single-tenant single-host installs. Two Cogmos on the same Docker host using the default name share one cache, so the "pre-stage a poisoned `<hash>/.ready`" scenario spans every instance instead of every worker. Multi-instance operators scope per-deployment (`...-staging` / `...-prod`). The variable is silently ignored on `per-sandbox` backends — each sandbox's cache is container-local, so multi-instance cache sharing isn't representable there in the first place. `[research]`.

## Cost tracking `[proposed]`

Two cost surfaces, measured separately:

**Compute** — `skill_runs.resource_usage` JSONB blob (`SkillRunResourceUsageSchema`) carries `wallClockMs` (always set, host-derived from `finishedAt - createdAt`) and `peakMemoryBytes` (nullable). Tier-2 populates `peakMemoryBytes` from `getrusage(RUSAGE_SELF).ru_maxrss * 1024` inside `runner.py` just before emitting `task_result` — Linux `ru_maxrss` is in kilobytes. Tier-1 (Pyodide WASM) leaves `peakMemoryBytes` null because `getrusage` is process-wide and would inflate under concurrent workers; tier-2 synthesised results (wall-clock kill, task process died, `task_exited_without_result`, host watchdog) also leave it null, since none sees the task process's rusage. Cheap to track, captures almost all "bad skill burned the machine" cases.

**External / $ cost** — anything Cogmo actually pays for:

- **LLM tokens** via `ctx.llm.complete()` — Cogmo meters tokens in/out per call, applies the model's pricing table, attributes to the `skill_run`. Direct SDK calls from skill code (`anthropic.Anthropic()`) are opaque to Cogmo — one more reason to route LLM access through `ctx`.
- **Paid third-party APIs** — declared per-skill: `cost_per_call_usd: 0.003` in `SKILL.md`. Summed across invocations per `skill_run`.
- **Bandwidth / storage** — not tracked v1; negligible at personal scale.

**Enforcement at dispatcher:**

Before dispatching any task, check cumulative cost against the skill's budget (also declared in `SKILL.md`, e.g., `budget: { daily_usd: 1.00, monthly_usd: 20.00 }`). If over → refuse dispatch + notify user. Budget overrun on a cron skill auto-suspends until the window rolls over.

**Relationship to risk tiering:** the `auto` tier requires `cost_per_call_usd == 0` and `llm_calls == 0` — pure compute, no paid APIs. Once a skill hits any paid surface it's at least `notify`.

### Edit vs create

Orthogonal axis — lowers friction for iteration:

- **New skill** — classify from scratch. Defaults at least to `notify`.
- **Edit to existing skill** — if `effects ∪ secrets` hasn't widened, keep current tier. Bug-fix churn stays low-friction.
- **Edit that widens permissions / effects** — re-classify; may bump up into `approve`.

### Recovery

If an auto-applied skill misbehaves:

- **`/disable <skill>`** — channel command disables immediately (sets `skills.disabled = true`; running tasks finish, no new invocations accepted). Idempotent on already-disabled rows.
- **`/enable <skill>`** — re-activates a previously disabled skill. Refuses with a "no live deploy" message if the skill was never live at its current sha (denied-on-first-deploy guard above).
- **`/skills`** — operator inventory: lists every registered skill (enabled + disabled, with marker), tier, risk tier, short git sha. Discovery surface for the other two commands.
- **`/rollback <skill>`** — revert to prior git SHA, re-sync.
- **Automatic kill-switches** — auto-disable on defect-class failures ([Notifications and undo](#notifications-and-undo)); a skill over its cost budget is refused dispatch (Cost tracking).

### Mapping to existing design

- **[evolution.md](evolution.md) graduation model** — start strict, auto-apply patterns that prove safe. The risk classifier is the "what's safe" function made explicit.
- **[integrations.md](integrations.md) permission tiers** — read-only / read-write auto / read-write approval. Same tiering, specialized to skills.

## Invocation `[proposed]`

Skills are invoked via Inngest events:

| Trigger | Source | Handling |
|-|-|-|
| **Manual (agent tool)** | LLM calls the skill's own tool (one tool per skill — see below) | The tool handler calls `runner.invoke` inside its durable tool step → dispatcher → worker → result returned to the LLM |
| **Cron** | Inngest cron, one per scheduled skill | Dispatcher → worker. Result handled by skill itself (posts to channel, writes memory, etc.) |
| **Event-driven** (future) | Inngest event subscription | Same path as cron |

Manual invocations are synchronous from the LLM's perspective — tool result returned before the next turn. Cron invocations are fire-and-forget; skill output is whatever side effects the skill itself emits.

### Run-as identity `[confirmed]`

Every run acts for a user: `ctx.user()` returns them, and `ctx.memory` / `ctx.files` go through a scoped `Service` built for them (`SkillRunner.invoke({ runAs })`). `ctx.memory` gets exactly what the agent's own memory tools get — the profile's `memoryScope`, the restricted-class exclusion, and writes staged in `pending_memories` for the Observer. `ctx.files` is the deployment-wide workspace (see [File workspace](#file-workspace-confirmed)).

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

Each registered skill appears as its own entry in the LLM's tool list — the skill's `name` is the tool name, its `description` from `SKILL.md` is the tool description, its `inputs` schema is the tool's JSON Schema. No generic `invoke_skill` wrapper. This is what makes progressive disclosure work: the LLM sees `summarize_email` directly with its one-line description and knows to call it.

**Dynamic tool list per turn.** The orchestrator rebuilds the tool list at the start of each turn from `SkillRunner.list()`. Skills that registered since the last turn appear automatically; `/disable`d or rolled-back skills disappear. Same dynamism that already exists for the built-in tool registry — just driven by the DB state rather than a static module.

**Concrete shape:**

```typescript
// orchestrator, per turn
async function buildToolList(turn: { userId: string }): Promise<ToolSpec[]> {
  const builtIn = [...coreTools, ...webTools, ...imageTools];
  const skills = await skillRunner.list();  // DB read, live + enabled skills
  const skillTools = skills.map((s) => defineTool({
    name: s.name,                            // e.g. "summarize_email"
    description: s.tier1Description,          // from SKILL.md header + `description` field
    schema: s.inputsSchema,                   // parsed from manifest, z-compiled
    handler: async (input, service) => {
      const result = await skillRunner.invoke({
        name: s.name,
        inputs: input,
        runAs: { userId: turn.userId, service },  // the turn's scoped Service
      });
      return formatSkillResult(result);
    },
  }));
  return [...builtIn, ...skillTools];
}
```

Output delivery follows [image-generation.md](image-generation.md)'s pattern — JSON as tool result text; binary outputs uploaded to `AttachmentStore` with path references returned, extracted and delivered by the outbound path.

Tier-2 and tier-3 SKILL.md content (full instructions, scripts, reference assets) are fetched on demand — when the LLM selects a tool, the full `SKILL.md` body is swapped into the tool description for that turn's follow-up calls. Tier-3 assets are fetched by the skill code itself at runtime.

### Skill discovery at LLM time

**v1: progressive disclosure** — the SKILL.md standard from Anthropic (Dec 2025), referenced in [integrations.md](integrations.md):

- **Always loaded** (in the tool list every turn): skill name + one-line description, ~50 tokens per skill.
- **Loaded on selection**: when the LLM picks a skill, Cogmo injects the full `SKILL.md` body (~500 tokens) into the tool description for that turn.
- **Loaded on demand**: scripts, schemas, reference assets fetched by the skill itself at runtime.

At personal scale (<50 skills) this is enough on its own — the tool list stays under ~2.5k tokens.

**Later: retrieval layer.** Above ~100 skills, progressive disclosure alone bloats the tool list and degrades tool-selection accuracy. Add a semantic-search tool (`search_skills(query)`) that embeds the SKILL.md descriptions and surfaces top-k matches per turn. Voyager and most agent papers use this shape. Trigger threshold: when tool-list tokens exceed ~5k or selection accuracy drops on evals.

### Cron skill failure handling

A failed cron run is recorded with an `error_kind` whose class decides what follows: a pausing kind re-fires once, every failure notifies the run-as user, and defect-class failures auto-disable the skill ([Run failures](#run-failures)). Agent-led repair is the Repair button on the auto-disable notification, which opens a draft through the normal pipeline.

## Host context (`ctx`) `[proposed]`

Skills receive a host context object as the second argument to `run()`:

```python
# skill.py
def run(inputs: dict, ctx) -> dict:
    webhook = ctx.secrets.get("slack_webhook")
    ctx.memory.remember(...)
    path = ctx.attachments.upload(image_bytes, "image/png")
    ...
```

`ctx` is a thin Python SDK shipped into every skill worker: tier 1 runs `src/skills/worker-wasm/py/ctx.py` in the Pyodide globals the skill body shares, and tier 2's lives in `cogmo_skills_runtime/runner.py` in the image. Each method is an RPC back to the host over the channel that dispatched the task: tier 2's stdin/stdout pipe, tier 1's worker `MessagePort`. This mirrors the TS `Service` pattern used by in-process tools — same shape, projected over a pipe.

### v1 surface

| Method | Purpose |
|-|-|
| `ctx.secrets.get(name)` | Fetch a declared secret value (manifest-gated) |
| `ctx.memory.recall(query, ...)` | Semantic search of the run's user's memory, under the run's profile scope (see [Run-as identity](#run-as-identity-confirmed)) |
| `ctx.memory.remember(content, ...)` | Stage a fact in `pending_memories` (`source = 'skill'`) for the Observer to classify and retain; Hindsight's `metadata.skill` names the skill. The skill's name and tags reach the Observer as context, not as memory tags. |
| `ctx.attachments.upload(data, media_type)` | Upload to `AttachmentStore`, return path |
| `ctx.attachments.download(path)` | Fetch bytes |
| `ctx.files.read(path)` | Read UTF-8 text from the workspace (see [File workspace](#file-workspace-confirmed)) |
| `ctx.files.write(path, content)` | Create or overwrite workspace file |
| `ctx.files.list(prefix=None)` | List workspace entries |
| `ctx.llm.complete(prompt, model=...)` | LLM call via Cogmo's provider routing (cost-tracked, provider-fallback, prompt-cache aware) |
| `ctx.now()` | Canonical time (mockable in tests) |
| `ctx.user()` | The run's user — `id`, and the deployment's `timezone` (`USER_TIMEZONE`) |
| `ctx.notify(channel, message)` | Send a message to the user via their preferred channel (Telegram in v1) |
| `ctx.log.info(msg, **fields)` | Structured logging to `skill_runs.logs` |
| `ctx.http.request(method, url, ...)` | Outbound HTTP performed by the host; `get` / `post` wrap it. Tier 1's only network path — Pyodide has no sockets, so `httpx` and `requests` cannot run there. Present in tier 2 as well, so a skill does not break when adding a dependency moves it across the boundary; tier 2 may use `httpx` directly instead. Returns `{status, headers, body}`; a 4xx/5xx is a value, not an exception. Every destination must appear in the manifest's `network.allow` list, checked on the hostname ahead of resolution — a skill with no `network:` block reaches nothing. `http`/`https` only, capped at 5 MiB, and timed out under the skill's own `wall_clock_s` so a hung request stays catchable. Redirects are not followed — the 3xx comes back with its `location` so the next hop is a fresh, separately-checked call. Destinations resolving to a non-public address are refused (`isBlockedAddress` in `src/util/blocked-address.ts`, shared with `fetch_url`): `fetch` runs in the host process, so without it a skill would reach internal services (Hindsight takes no auth) that a tier-2 sandbox cannot see. Residual: `fetch` resolves the name again, so DNS rebinding between the check and the connection is open until connections are pinned to the checked address. Audited to `skill_context_calls` by origin and path, never the query string. The [Egress proxy](#egress-proxy-proposed) module takes over the allowlist, the address guard, pinning and the audit. |

Every RPC: validates against the skill's manifest (allowlists, permission scopes) → executes → logs to `skill_context_calls` → returns a result or raises a typed Python exception.

### Not in v1 (deferred with the reason)

| Method | Why deferred |
|-|-|
| `ctx.metrics.*` | Over-engineering at personal scale. `ctx.log` covers most visibility needs. |
| `ctx.skills.invoke(other_skill, ...)` | No inter-skill composition in v1 (see below). |
| `ctx.schedule(when, event)` | Scheduling handled externally via Inngest cron declared in `SKILL.md`. |

### File workspace `[confirmed]`

Skills share files across invocations through a workspace exposed as `ctx.files`. This is the v1 mechanism for skill-to-skill state — one skill writes `notes/draft.md`, the next polishes it. Backed by the same S3-backed `service.files` store the agent's in-process `read_file` / `write_file` / `list_files` tools use, so the LLM and skills see one workspace. That store is one deployment-wide workspace, keyed by the logical path with no user prefix; the per-user prefix below is the design, not yet built.

**Text-only.** The workspace stores UTF-8 text. Binary outputs (images, PDFs, generated artifacts) go through `ctx.attachments`. Two stores, two purposes:

| Store | Use when | Properties |
|-|-|-|
| `ctx.files` | Named, mutable, listable text — notes, drafts, CSV, summaries | Logical paths, S3-backed, per-user prefix; strong consistency at task boundaries (private substrate within a task) |
| `ctx.attachments` | Binary blobs, write-once outputs — PNG, PDF | Opaque path token, no listing, immutable once uploaded |

**Two access paths.** A skill reaches workspace files two ways, with the same ACL boundary underneath:

| Path | Surface | When skills use it |
|-|-|-|
| **POSIX** | stdlib `open("/files/notes.md")`, `pathlib`, `pandas.read_csv`, `os.listdir` | Default. Anything that takes a path. ~95% of skill code. |
| **RPC** | `await ctx.files.read(path)` / `write(path, content)` / `list(prefix=None)` | Live writes that need cross-task visibility, or large blobs that shouldn't be staged at task start. |

The RPC surface (`Service["files"]` mirrored to Python) is unchanged from prior iterations:

| Method | Returns |
|-|-|
| `ctx.files.read(path)` | `str` — raises `FileNotFound` if missing |
| `ctx.files.write(path, content)` | `None` — creates or overwrites |
| `ctx.files.list(prefix=None)` | `list[FileEntry]` with `path`, `size`, `last_modified` |
| `ctx.files.delete(path)` | `None` — idempotent; no error if the path is already absent |

Paths are logical (`notes/meeting.md`). The per-user prefix, once built, is where the host enforces ACL. The 100 KB read cap on `ctx.files.read` (matching the agent's `read_file` tool) is an LLM-output guardrail — its job is preventing a 50 MB string from landing in a tool result the LLM will then re-include in its context. POSIX `open()` does NOT inherit this cap and is bounded only by the substrate (Pyodide MEMFS by worker memory, sysbox tmpfs by mount size, Daytona Volume by quota); skills that need to materialise a large file end-to-end should use POSIX. Writes have no explicit cap on either path (bounded by S3 object limits).

#### Per-tier POSIX shim — stage + reconcile

Each tier exposes the workspace at `/files` via a private substrate populated at task start and reconciled to S3 at task end. The host owns the staging loop; the skill is unaware.

For each tier, "stage in" is `Service["files"].list(userPrefix)` to enumerate entries, then `Service["files"].read(path)` per entry to fetch content, then a substrate-specific write. The host records a `path → sha256(content)` map of the staged set. "Reconcile out" walks the substrate, computes the same map, and diffs:

- **Path in substrate, not in stage-in** → new file, push via `Service["files"].write`.
- **Path in both, hash differs** → modified, push via `Service["files"].write`.
- **Path in both, hash matches** → unchanged, skip (no S3 round-trip).
- **Path in stage-in, not in substrate** → deleted by the skill (`os.remove`, `pathlib.Path.unlink`), push deletion via `Service["files"].delete`.

Hashing on content (not mtime / size) avoids re-uploading large files the skill only `open()`-ed for read, and works uniformly across MEMFS (no real mtime), tmpfs, and Daytona Volumes. Hashes are computed once at stage-in (we have the bytes anyway) and once at reconcile (we have to read the substrate to write S3 anyway).

| Tier | Substrate | Stage in (substrate write) | Reconcile out (substrate read) |
|-|-|-|-|
| WASM (Pyodide) | Pyodide MEMFS | `pyodide.FS.writeFile(path, content)` per entry | Walk `pyodide.FS`, read changed paths via `pyodide.FS.readFile` |
| Sysbox local Docker | Host tmpfs bind-mounted at `/files` | `node:fs.writeFile(tmpfsPath, content)` per entry, before container start | Walk the host tmpfs after container stop, read changed paths via `node:fs.readFile` |
| Daytona remote | Daytona Volume + per-user `subpath` mounted at `/files` | `sandbox.fs.uploadFile(Buffer.from(content), path)` per entry | `sandbox.fs.listFiles` + `sandbox.fs.downloadFile` for changed paths |

The orchestration loop is one host-side function parameterised by a small `TierFs` interface (`stage(spec)` / `reconcile(spec)`); only the substrate adapter differs across tiers.

`/files` is a deliberate choice — `/workspace` is already the bind-mount for coding-delegation worktrees ([coding-delegation.md](coding-delegation.md)). Two distinct workspaces, two distinct paths.

**Why staging instead of FUSE / SAB everywhere.** The original [proposed] design called for `s3fs-fuse` in sysbox and a SharedArrayBuffer-backed Emscripten FS in Pyodide. Research (2026-05) ruled out one of those tiers entirely and made the others not worth their cost:

- **Daytona forces staging.** Daytona's sandbox runtime blocks `/dev/fuse` device creation (Sysbox limitation, [nestybox/sysbox](https://github.com/nestybox/sysbox/blob/master/docs/user-guide/limitations.md)); EPERM at mount time. We can't run any FUSE binary inside a Daytona sandbox. Daytona Volumes are the supported path, mounted by the control plane and populated host-side via `sandbox.fs.*` ([Daytona Volumes](https://www.daytona.io/docs/en/volumes)).
- **`s3fs-fuse` is fragile.** [#2156 OOM in container](https://github.com/s3fs-fuse/s3fs-fuse/issues/2156); [#607 random writes rewrite the entire object](https://github.com/s3fs-fuse/s3fs-fuse/issues/607); recurring memory-leak class bugs across releases. `goofys` is effectively unmaintained (no meaningful release since 2022).
- **`rclone mount --vfs-cache-mode full` is the credible "live" choice** but still costs `CAP_SYS_ADMIN` + `/dev/fuse` + AppArmor unconfined inside the sysbox container, and requires vending STS credentials into the container — a security regression vs. host-owned creds today. Adds a binary + sidecar process to manage.
- **WASM SAB + DriveFS** (the JupyterLite pattern via [pyodide-kernel#114](https://github.com/jupyterlite/pyodide-kernel/pull/114)) works today but needs a third worker thread (host / fs-proxy / pyodide), a hand-rolled SAB protocol, chunked reads for results larger than the SAB slot, and an Emscripten errno mapping table. Buys live S3 visibility mid-task — which we don't need at our scale.
- **Once one tier is forced into staging, paying for two architectures is unjustified at personal scale.** Stage+reconcile is one orchestration flow, one ACL boundary (`Service["files"]`), no creds in any sandbox, no kernel-privilege escalation, no SAB plumbing.

**Why both RPC and POSIX.** POSIX gives every Python path-based library full ergonomics — stdlib `open()`, `pathlib`, `pandas.read_csv` all just work. RPC is the live escape hatch: writes via `await ctx.files.write` go straight to S3 through the host service, visible immediately to the next task and any concurrent task using the RPC. Skills that want cross-task coordination, large-blob streaming, or "I just need to append one line to a 200 MB file" use the RPC; everything else uses `open()`. Both paths are gated by the same `reads_filesystem` / `writes_filesystem` effects in `SKILL.md` — one ACL boundary, two transports.

#### Semantics

- **Within a task:** stdlib write-then-read works exactly as POSIX expects — both ops hit the same private substrate. POSIX and RPC are isolated within a task: a POSIX write lands in the substrate and is invisible to a subsequent `await ctx.files.read` (which reads S3); an RPC write lands in S3 and is invisible to a subsequent stdlib `open()` (which reads the substrate). Skills should pick one path per file and stick with it for the duration of the task.
- **Deletion:** stdlib `os.remove` / `pathlib.Path.unlink` removes the path from the substrate; reconcile sees "in stage-in but not in substrate" and deletes the S3 object. `ctx.files.delete(path)` does the same via the RPC path, immediately, bypassing reconcile. Skills that delete a file then write to the same path within the same task get expected POSIX semantics (delete-then-write yields a write — the delete never reaches S3 because reconcile only sees the final substrate state).
- **Across tasks (sequential):** task A reconciles before task B's stage-in begins, so task B sees task A's POSIX writes and deletions. S3 strong read-after-write consistency makes this exact, not eventual — the boundary is the consistency point.
- **Across tasks (concurrent):** each task gets its own private substrate. Task B does not see task A's POSIX writes or deletions until A reconciles. If both modify the same path, last-reconcile-wins on the S3 mirror — and that includes the delete-vs-write case (a delete from one task can erase the other's write, or vice versa). Documented; mitigated by (a) the orchestrator's per-user concurrency throttle on most flows, and (b) the RPC escape hatch (`ctx.files.write` / `ctx.files.delete`) for skills that genuinely need live cross-task visibility.
- **Stage-in cost** is `O(workspace size)` per task — every task lists the user prefix and reads each entry into the substrate. At single-user / ~200 tasks/day with mostly small text files (~tens of KB each), this is well below the per-task latency budget. The workspace is bounded by skill discipline; once it crosses a few hundred MB total, partition by prefix (one stage-in scopes to the prefix the skill declares it touches) or move large blobs to RPC-only access. Not a v1 concern.
- **No file locking** — `ctx.files.write` is "create or overwrite", no append, no partial updates. Read-modify-write is racy and the caller owns the consequences. Skills coordinating on the same file should pass state through return values or `ctx.memory`, not file races.
- **Strongly consistent S3 reads** on AWS (since Dec 2020), MinIO distributed/standalone, and Cloudflare R2 — a reconciled write is visible to the next task's stage-in immediately.

#### Future paths

- **JSPI in Pyodide.** Pyodide's filesystem hooks are still synchronous in the Pyodide 314.x line (CPython 3.14); [#5720](https://github.com/pyodide/pyodide/discussions/5720) tracks moving FS to JSPI. When that lands AND Node ships JSPI default-on, the WASM tier could swap MEMFS staging for an async-FS adapter that resolves stdlib `open()` directly through `Service["files"]`. The `TierFs` interface is the swap point — skill code never changes.
- **Live mount opt-in.** If a class of skills materially needs live S3 visibility within a task (long-running cron skills observing a directory written by ad-hoc skills), the sysbox tier could grow a second `TierFs` implementation backed by `rclone mount` behind a manifest opt-in (`live_filesystem: true`). WASM and Daytona keep staging — they have no FUSE option.
- **Conflict detection at reconcile.** Cheap to add later: if a path's S3 etag changed since stage-in *and* the task wrote it, surface a conflict event rather than silently overwriting. Not in v1 (single-user, low concurrency), trivial to layer on without architectural change.

### Inter-skill composition

**Not in v1.** Skills are flat; the agent composes at the LLM level by calling one skill, getting the result, then calling another. Persistent state shared across skills lives in `ctx.files` and `ctx.memory`, not in synchronous skill-to-skill calls. This matches what Voyager and Anthropic Skills actually do in practice — runtime skill-to-skill invocation is a solution looking for a problem at personal scale.

**Future shape when added: `ctx.skills.invoke(name, inputs)` — orchestrator-mediated.** Via the host, never direct skill-to-skill imports:

- Skill calls `ctx.skills.invoke("other-skill", {...})` → RPC back to host.
- Host dispatches a new task through the pool (fresh subinterpreter; callee sees only *its own* declared secrets, not caller's).
- Host enforces recursion depth cap (initial: 3), cycle detection, audit every call in `skill_context_calls`.
- Permission propagation: the callee's effective permissions are the intersection of its own declared effects and the caller's — a caller in tier `auto` cannot transitively escalate to `approve`-tier actions.

Direct in-worker imports between skills are rejected — they break permission scoping and pool management.

Sharing *pure-Python helper code* between skills (no `ctx` access) is a different question, handled via a `skills/_shared/` directory or pinned pip packages, not via runtime composition.

### Secrets: pull model

1. `SKILL.md` frontmatter declares the allowlist:

   ```yaml
   secrets:
     - slack_webhook
     - github_token
   ```

2. At deploy time, every listed secret must exist in the `secrets` table (or be a declared dynamic type — OAuth, STS — when those land).
3. At runtime, `ctx.secrets.get(name)` checks the manifest → fetches from the encrypted `secrets` table → returns the value → logs the access.
4. Rotation is zero-touch for skill code — update the `secrets` row, next `get` call returns the new value.

Guarantees:

- Secrets never in env vars (`os.environ` dumps are safe).
- Secrets never in task `input` / `output` payloads (those are persisted in `skill_runs`).
- Secrets never in worker logs (ctx RPC responses not logged at the framing layer).
- Secrets only materialized in worker memory at point of use, not for the whole task.

### Cross-skill leakage in a shared worker

A task's processes, and the memory holding its inputs and ctx results, are gone before the next task on the worker starts; the supervisor that every task forks from never reads either (see [State reset between tasks](#state-reset-between-tasks-confirmed)). Successive tasks on one worker share the container filesystem: `/tmp`, `$HOME`, and the `/skill-venvs` cache, which tasks can write.

Accepted at personal scale because skills are Cogmo-authored and reviewed. Upgrade paths if the threat model changes:

- **Worker-per-skill-identity** — pool keyed by `(tier, skill_name)`. Skill X and Y never share a worker.
- **Recycle every task** — a fresh container per invocation: 1–2 s on sysbox, and the warm pool's benefit is gone.
- **microVM per task** — full cleanup, highest overhead.

### Secret exposure and egress control `[proposed]`

The pull model hands a skill the real secret. `ctx.secrets.get(name)` returns plaintext, gated only by the manifest's own `secrets:` list — the skill declares its own permissions — and skill bodies are LLM-authored. `computeRiskTier` returns `auto` for a tier-1 skill with no effects and fewer than `APPROVE_SECRETS_THRESHOLD` (3) declared secrets, so a skill naming one or two deploys with nobody reading it.

Reading a secret is half of an exfiltration; the other half is a route off the machine, which is what `ctx.http` supplies. Neither half is wrong alone, and both are wanted. This section is the plan for holding them together safely.

**What the field does.** Credential injection at an egress boundary: the workload holds an opaque placeholder and a component outside it substitutes the real value on requests to destinations the credential is bound to. [Modal](https://github.com/modal-labs/credential-injection) vends a short-lived JWT rather than the key; [Cloudflare Sandbox](https://blog.cloudflare.com/sandbox-auth/) keeps secrets in the Workers runtime the sandbox cannot read; [LangSmith's Auth Proxy](https://www.langchain.com/blog/how-auth-proxy-secures-network-access-for-langsmith-agent-sandboxes) and [Nous's iron-proxy](https://hermes-agent.nousresearch.com/docs/user-guide/egress/iron-proxy) front the sandbox with a proxy that injects. Anthropic's [Managed Agents vaults](https://platform.claude.com/docs/en/managed-agents/vaults) do this and are explicit about the boundary condition: environment-variable credentials are unsupported with self-hosted sandboxes, because substitution requires egress the platform controls.

The second, independent consensus is default-deny egress with a per-workload allowlist enforced below the application, and resolve-then-connect validation so the vetted address is the connected one. OWASP's Agentic Top 10 puts unexpected code execution (ASI05) in the top tier and names allowlisting as a precondition for running model-authored code at all.

**Why one proxy.** `ctx.http` enforces the allowlist only for traffic that chooses it. Tier 1 reaches `js.fetch`, and tier 2 has raw sockets through `httpx`, so neither tier is bound by its manifest's `network:` block today. A placeholder that fails harmlessly over a raw socket protects the secret but leaves the allowlist unenforced. One egress proxy, the only route out for both tiers, enforces the allowlist, substitutes bound secrets and audits every request.

**Stages.**

| Stage | What | Status |
|-|-|-|
| 1 | Declared egress, default deny, on `ctx.http` | `[confirmed]`: built; tier 1's `js.fetch` and tier 2's raw sockets bypass it |
| 2 | Egress proxy: the one route out for both tiers, per-run credentials, pinning to the checked address, audit | `[proposed]` |
| 3 | Bound secrets as placeholders, substituted at the proxy, with token exchange | `[proposed]`; `binding` parses and is ignored today |

**Stage 1 — declared egress, default deny.** A `network:` block in `SKILL.md` names the hosts a skill may reach; absent the block, `ctx.http` refuses every destination, so a skill opts into the internet per host rather than out of it. Entries are hostnames, optionally prefixed `*.` for subdomains — `*.example.com` admits any host under that zone, `a.b.example.com` as readily as `api.example.com`, but not the apex, which needs its own entry — and a lone `*` does not parse. Depth is deliberate: CDN and bucket hosts are routinely several labels deep, and a single-label rule would push authors toward listing a bare apex, which is broader. A wildcard over a zone carrying third-party sub-labels admits those too, which is a property of sharing the zone rather than of the depth, and a reason to name hosts exactly where the zone is shared. Matching happens on the hostname ahead of resolution, so a destination the manifest never named does not even become a DNS query; the address guard then runs on what a permitted name resolves to, which is a separate question and refuses a declared host pointing inward. `computeRiskTier` never returns `auto` for a skill combining network access with declared secrets, at any count: the threshold governs how many secrets count as broad permissions, which is not the same question as whether a skill can read a credential and also reach somewhere to send it. Network with no secrets lands at `notify`.

This is the load-bearing control, because exfiltration requires reaching a destination the attacker chose. An allowlist bounds where a credential can travel even while the skill still holds it in plaintext, which is why the proxy enforces it for both tiers before it substitutes anything.

#### Egress proxy `[proposed]`

One enforcement point for every byte a skill sends off the machine: a token-injecting forward proxy inside `cogmo serve` (`src/skills/egress/`). Placeholder minting is the primitive it shares with `ctx.secrets.get`. It carries stages 2 and 3: allowlist, pinning, substitution, token exchange and audit live here, for both tiers.

**One path.**

- Tier-2 workers run on an internal Docker network (`Internal: true`): no default route, and the only reachable address is the proxy's listener on that network. That is the enforcement, so there is no `iptables` and nothing to bypass by unsetting a variable. `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` are set for convenience. Sessions that run skill code without needing egress, such as the verify stage's, join the same network and get no credential.
- `ctx.http`, which the host performs for tier 1 and for tier 2's RPC, calls the same proxy module in-process. Allowlist, pinning, substitution and audit have one implementation.
- Dependency populate on a tier-2 worker reaches PyPI through the proxy, under a populate credential for the run it serves, with an allowlist of `pypi.org` and `files.pythonhosted.org` and no bindings.
- Non-HTTP protocols have no route. A tier-2 skill that needs raw TCP (SMTP, a database wire protocol) cannot run; this residual is an owner question.
- Tier 2 runs on local Docker only ([Warm pool](#warm-pool-confirmed)). A managed backend Cogmo cannot attach to an internal network has no egress control, so the classifier reads `tier2EgressEnforced = false` there: bound secrets are unavailable and a `network:` block is `blocked`, until the provider offers an egress hook the proxy can sit behind.

**Per-run identity.** No credential, no egress.

- The credential is `<runId>.<mac>`, where `mac` is HMAC-SHA256 of the run id under a key derived from the master key (HKDF, purpose `skill-egress`, [infrastructure.md](infrastructure.md)). It derives from the durable `skill_runs` row, so nothing stores it and a restarted proxy needs no map.
- The relay puts it in the task process's environment and proxy URL (`http://<credential>@<proxy>`), never in the container's. A pool worker's next task gets the next run's credential.
- Each request is admitted only while its run is `recovery_point = 'started'`. The proxy then loads the run's skill at the run's `git_sha` for its allowlist and bindings. `transitionToExecuted` revokes the credential by moving the row, and the proxy aborts that run's open requests and refuses new ones. A cached admission lives at most until the run's deadline.
- A new run means a new credential. A leaked one opens only its own run's allowlist, and only while the run is in flight.

**TLS.** The proxy terminates TLS for `CONNECT` with a Cogmo CA, minted by setup, kept in the secrets store, and rotated by `cogmo skills rotate-egress-ca`.

- The skills image is public, so the CA cannot be baked into it. Each worker gets the system bundle plus the CA as a read-only mount, with `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE` pointing at it, which httpx and requests both honour.
- Leaf certificates are minted per host on first use and cached in memory.
- Upstream, the proxy verifies the destination's real certificate against the system store.
- A client that pins its own CA fails closed, as it should.

**Implementation.** A Node module in-process, not a mitmproxy sidecar. It reuses the Docker API proxy's split ([sandbox.md → Proxy Design](sandbox.md#proxy-design)): a pure router and policy, a thin `http.Server` shell. It is one language and one deployment unit, and `ctx.http` calls it directly. A sidecar would add a Python deployment unit, its own CA lifecycle, and a run-correlation channel back to Cogmo for every request. The module needs two runtime dependencies, both under AGENTS.md → Autonomy: `undici`, for an `Agent` whose `connect.lookup` pins the vetted address, and an X.509 library to mint leaf certificates (`node:crypto` reads certificates but cannot issue them).

**Per request**, in order, with `ctx.http`'s limits:

1. A missing or unadmitted credential is refused with `407`.
2. A host outside the run's allowlist is denied before resolution, so it never becomes a DNS query.
3. The resolved address must pass `isBlockedAddress`, and the connection is pinned to that address. This closes DNS rebinding for `ctx.http` and the proxy alike.
4. `http` and `https` only; redirects are returned, not followed.
5. Request and response bodies are capped at 5 MiB, and every request is timed out by the run's remaining wall clock.
6. Substitution, below.
7. Audit, below.
8. In a shadow run, a non-GET method is recorded and answered `202` with a fixed shadow body.

**Substitution.** A bound secret never enters the worker. `ctx.secrets.get(name)` returns a placeholder, `cogmo-secret:<hmac(runId, name)>`, unique to the run.

- The binding names its `destination` (a URL pattern within the allowlist) and its `location`, an enum: `header` (the default: a named header, or the existing `header:` template), `query` (one parameter) or `body_json_path` (one JSON body field, for APIs that take a credential in the body). The proxy replaces the placeholder only in that location, only on a request to that destination.
- A placeholder anywhere else — another host, another location — is passed through unchanged, so it reaches the destination as an opaque string, and audited as `binding_misuse`.
- `exchange: oauth_refresh` makes the proxy trade the stored refresh token for a short-lived access token at substitution time, caching it until its expiry, so no long-lived credential reaches the request either.
- An unbound secret keeps the pull model and classifies as `raw_secret` ([Risk tiers](#risk-tiers-without-a-human)). It is the fallback for credentials no binding can place, such as a signing key the skill computes with.

**Audit.** Every proxied request writes one `skill_egress` row: `run_id`, `method`, `origin`, `path` (never the query string), request and response bytes, `status`, `outcome` (`forwarded | denied | failed`), `denied_reason` (`skill_egress_denied_reason`: `host_not_allowed`, `blocked_address`, `credential_revoked`, `not_http`, `too_large`, `timeout`, `upstream_error`), and `bindings` (`EgressBindingsSchema`: each secret name with `substituted` or `misuse`). `ctx.http` writes the same row, in place of its `http.request` context call. A request with no valid credential has no run to name and is logged, not stored.

**Credential lifecycle.** The credential has no state of its own: it is live exactly while its run is at `started`. The proxy holds only caches it can rebuild.

| Failure mode | State left | Why it is safe, or the residual |
|-|-|-|
| The proxy is down or restarting | requests fail to connect; the run continues | fails closed: no route exists around it. A run that ends on it records `egress_unavailable`, a pausing kind. A restart re-derives admission from `skill_runs` |
| A run ends with a request in flight | the request is aborted | revocation follows the row; the skill already has its result or error |
| A run is swept from `started` ([Run failures](#run-failures)) | the credential is revoked with it | the sweeper's transition is the same revocation |
| CA rotation | workers trust the old and new CAs until recycled | rotation drains the pool; the old CA is removed once no worker holds it |
| A leaf certificate cache lost | re-minted on first use | it is a cache |
| The master key rotates | credentials of in-flight runs stop verifying | those requests get `407`; the runs fail with `egress_unavailable`. **Residual**, benign at single-user scale |
| A managed tier-2 backend | no internal network | `tier2EgressEnforced = false`: bound secrets unavailable, `network:` blocked |
| A tier-2 skill needing raw TCP | no route | the skill fails; residual pending the owner's answer |

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

- At register, and at verify, the runner imports `skill.py` in the tier's own runtime (inside the sandbox the lockfile compile already starts, or the Pyodide child). It emits `Input.model_json_schema()` and `Output.model_json_schema()`, which become `skills.inputs` and `skills.outputs`: the LLM tool schema and the host's pre-flight ajv check.
- The frontmatter no longer carries `inputs` or `outputs`, which keeps `SKILL.md` closer to Anthropic's standard. A skill with no `Input` model still needs frontmatter `inputs`, so live skills keep working.
- The runner validates with `Input.model_validate(inputs)` before `run`, so pydantic applies defaults (a cron fire's `{}`) and formats. After `run` it applies `Output.model_validate(result).model_dump(mode="json")`.
- pydantic belongs to the runtime, not to skills: the tier-2 runtime venv and tier 1's built-in packages pin one version each. A skill declaring another version is rejected.

**`ctx`: one Python package, `cogmo_ctx`.** Both tiers ship it with a pluggable bridge, the tier-1 `MessagePort` and the tier-2 relay pipe. It replaces tier 1's untyped `ctx.py` and the copy inside `runner.py`. Its typed surface — argument and result models, `CtxError` with a `kind` enum — and the worker protocol frames are generated from the TS Zod schemas (`z.toJSONSchema`) by a codegen script. CI fails when the generated `.pyi` and JSON Schemas are stale, and pytest validates the Python side's frames against them, which catches drift such as a field one side sends and the other strips. `SKILL_EFFECTS` and `SkillManifestSchema` reach the authoring prompt and `CLAUDE.md` by interpolation, never by hand.

**`ctx.run()`** returns `{ id, key }`: the run id, and the run's idempotency key — the caller's (tool call or cron fire) when there is one, else the run id. A skill sends `key` as `Idempotency-Key` on external writes, so a recovered or repeated invocation of the same call cannot act twice at a destination that honours it.

### Run failures

`skill_runs.error_kind` (`skill_run_error_kind`) is set iff `status = 'error'`, beside the `error` message. Each kind has one class, a pure function of the kind:

| Class | Kinds | Counts toward auto-disable | Retried |
|-|-|-|-|
| defect | `skill_raised` (an uncaught exception), `output_invalid`, `load_failed` (syntax, import, missing `run`), `wall_clock_exceeded`, `memory_exceeded` | yes | no |
| expected | `skill_failed` (`SkillError(kind, message)`), `input_invalid` (pydantic refused what ajv passed) | no | no |
| pausing | `skill_retryable` (`SkillError(..., retryable=True)`), `runtime_unavailable` (pool, sandbox, supervisor, worker init), `dependency_unavailable`, `egress_unavailable`, `host_lost` (swept) | no | once, for a cron fire |

- A failure before the skill executed is a `SkillInvokeRejection`, as today, and a cron fire throws on it so Inngest's retries apply.
- A run that executed is never re-run on its own key. A cron run ending in a pausing kind is re-fired once, after a backoff, under `skill-cron:<skillId>:<scheduledFor>:retry`.
- `output_invalid` keeps what the skill returned, so the run is debuggable and the model is told its effects happened: `chk_skill_runs_outcome` admits `output` on an error verdict only with that kind.
- A non-JSON output (`NaN`, a `set`) is `output_invalid`, decided in the worker before `transitionToExecuted`. It no longer strands the row at `started`.

**Events.** Every run that finishes with an error emits `skills/run.failed` `{ skillId, runId, trigger, errorKind }`. Cron and event runs notify their run-as user: the skill, the error, the last success, and Disable. Tool runs reach the user through the model. The same subscriber applies the auto-disable rule ([Notifications and undo](#notifications-and-undo)), and `skills.disabled_reason` (`awaiting_first_deploy | operator | deregistered | error_rate`, set iff `disabled`) records why a skill is off, naming the activation states that `disabled` alone encodes.

**Stuck runs.** `skill-runs-sweeper` runs every 5 min and moves rows at `started` older than 15 min to `finished` with `error_kind = host_lost`. Fifteen minutes is longer than the 60 s worker init plus the 600 s wall-clock ceiling plus the grace period. The move is a conditional UPDATE on `recovery_point = 'started'`. A late `transitionToExecuted` then matches no row and returns `swept`, logged with the output it discards, rather than throwing. A keyed retry replays the error instead of reading `inflight` forever.

**Audit columns.** `skill_runs` gains `git_sha`, `run_as_user_id`, `run_as_profile_id` and `shadow`. `skill_context_calls.error` becomes the `CtxErrorKind` pgEnum, and `secrets.get` fails closed when its audit row cannot be written.

## Observability `[proposed]`

The database answers what an operator asks of a skill:

| Question | Source |
|-|-|
| What did X do last week, as whom, at which version | `skill_runs` by skill and `created_at`: trigger, `git_sha`, run-as, status, `error_kind`, `shadow`, `resource_usage` |
| Which hosts, with which verbs, and how much data | `skill_egress` by run: method, origin, path, bytes, status, denials |
| Which secrets, and where they went | `skill_context_calls` (`secrets.get`) and `skill_egress.bindings` (`substituted`, `misuse`) |
| What it wrote | `skill_context_calls` for memory and files; `skill_egress` for non-GET requests |
| What it cost | `resource_usage` (wall clock, peak memory), and declared `cost_per_call_usd` summed per run |
| How it got here | `skill_deploys` (tier, reasons, `classifier_log`), and the draft: spec card, rounds, verify reports, reviews |

- **CLI.** `cogmo skills runs <name> [--since 7d] [--status error]`; `cogmo skills run <runId>` (its context calls and egress); `cogmo skills activity <name> [--since 7d]` (hosts, secrets, writes, error kinds, cost); `cogmo skills drafts [--open]`.
- **Web UI.** The same reads through oRPC (`skills.runs`, `skills.run`, `skills.activity`, `skills.drafts`) on the Skills page, which the notifications' Details link opens.
- **Chat.** `/skills` adds open and blocked drafts, with their buttons.

## Data model `[proposed]`

Owned by `src/skills/store/`.

```sql
CREATE TYPE skill_tier AS ENUM ('wasm', 'container');
CREATE TYPE skill_risk_tier AS ENUM ('auto', 'notify', 'approve');
CREATE TYPE skill_run_status AS ENUM ('running', 'success', 'error');
CREATE TYPE skill_run_trigger AS ENUM ('manual', 'cron', 'event');
CREATE TYPE skill_deploy_status AS ENUM ('pending_approval', 'denied', 'live', 'rolled_back');

skills (
  id                UUID v7 PK,
  name              TEXT NOT NULL UNIQUE,            -- matches dir name
  tier              skill_tier NOT NULL,
  risk_tier         skill_risk_tier NOT NULL,        -- computed by classifier at deploy
  effects           JSONB NOT NULL,                  -- SkillEffectsSchema (declared effects list)
  schedule          TEXT,                            -- nullable: cron expression; null = not scheduled
  run_as_user_id    UUID REFERENCES users(id),       -- nullable: set iff schedule is set and the row enabled (chk_skills_run_as_iff_live_schedule).
  run_as_profile_id UUID REFERENCES profiles(id),    -- nullable: same. Who a cron fire runs as; see Run-as identity.
  git_sha           TEXT NOT NULL,                   -- commit hash of current live version
  lockfile_hash     TEXT,                            -- nullable: null when manifest.dependencies is empty.
                                                     -- sha256(requirements.lock @ git_sha). Drives venv cache
                                                     -- key + reachability GC; updated atomically with git_sha.
                                                     -- See Dependencies.
  inputs            JSONB NOT NULL,                  -- SkillIoSchema (opaque JSON Schema — see Manifest)
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
  idempotency_key TEXT,                     -- nullable: null for one-shot CLI/test invocations. UNIQUE(idempotency_key) — Postgres NULLs-are-not-equal default allows multiple null rows; see Exactly-once invocation.
  recovery_point  skill_run_recovery_point NOT NULL DEFAULT 'started',  -- 'started' | 'executed' | 'finished' — drives the replay branches in runner.invoke.
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,              -- nullable: null while recovery_point = 'started'
  -- Per-state data (see Exactly-once invocation → Per-state data):
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

**JSONB schemas validated at the store boundary** (per [architecture-rules.md](../.agents/rules/architecture-rules.md) — every JSONB column has a Zod schema parsed on read and write):

- `skills.inputs` / `skills.outputs` — `SkillIoSchema = z.record(z.unknown())`. Opaque at the Zod layer; the actual JSON Schema is enforced against task inputs/outputs at invoke time via `ajv`, not at the store boundary.
- `skills.effects` — `SkillEffectsSchema = z.array(z.enum(SKILL_EFFECTS))`.
- `skill_deploys.classifier_log` — `ClassifierLogSchema = z.object({ risk_tier, declared_effects, detected_effects, declared_secrets, validation_errors, classifier_version })`. Fully Cogmo-controlled, fully schema'd.
- `skill_runs.inputs` / `skill_runs.output` — `SkillInvocationInputsSchema` / `SkillInvocationOutputSchema`. Pass-through `z.unknown()` wrappers at the store layer; the per-skill schema is whatever the skill declared in its manifest and is validated at invoke (the store just needs "valid JSON").
- `skill_runs.resource_usage` — `SkillRunResourceUsageSchema = z.object({ wallClockMs: z.number().int().nonnegative(), peakMemoryBytes: z.number().int().nonnegative().nullable() })`. Written by `transitionToExecuted`; null while `recovery_point = 'started'`. Extensible to CPU / IO / fork counts via Zod-schema additions without a migration.

### Authoring, egress and audit additions `[proposed]`

```sql
ALTER TYPE skill_risk_tier ADD VALUE 'blocked';   -- auto | notify | approve | blocked
CREATE TYPE skill_draft_status AS ENUM ('specifying', 'authoring', 'verifying', 'reviewing', 'registering',
  'awaiting_approval', 'blocked', 'live', 'abandoned', 'failed');
CREATE TYPE skill_draft_blocked_reason AS ENUM ('author_unavailable', 'verifier_unavailable', 'reviewer_unavailable',
  'reviewer_block', 'risk_blocked', 'rounds_exhausted');
CREATE TYPE skill_draft_end_reason AS ENUM ('user_abandoned', 'spec_timeout', 'blocked_timeout', 'approval_timeout',
  'denied', 'step_error');
CREATE TYPE skill_reviewer AS ENUM ('claude', 'codex');
CREATE TYPE skill_review_verdict AS ENUM ('pass', 'revise', 'block');
CREATE TYPE skill_run_error_kind AS ENUM ('skill_raised', 'output_invalid', 'load_failed', 'wall_clock_exceeded',
  'memory_exceeded', 'skill_failed', 'input_invalid', 'skill_retryable', 'runtime_unavailable',
  'dependency_unavailable', 'egress_unavailable', 'host_lost');
CREATE TYPE skill_disabled_reason AS ENUM ('awaiting_first_deploy', 'operator', 'deregistered', 'error_rate');
CREATE TYPE skill_egress_outcome AS ENUM ('forwarded', 'denied', 'failed');
CREATE TYPE skill_egress_denied_reason AS ENUM ('host_not_allowed', 'blocked_address', 'credential_revoked',
  'not_http', 'too_large', 'timeout', 'upstream_error');

skill_drafts (
  id                 UUID v7 PK,
  skill_name         TEXT NOT NULL,
  base_git_sha       TEXT,                     -- nullable: null for a new skill; the live sha an edit starts from
  conversation_id    UUID NOT NULL REFERENCES conversations(id),   -- where the card and notifications go
  requester_user_id  UUID NOT NULL REFERENCES users(id),
  requester_profile_id UUID NOT NULL REFERENCES profiles(id),      -- the deploy origin, and who a schedule runs as
  status             skill_draft_status NOT NULL,
  round              INT NOT NULL,
  max_rounds         INT NOT NULL,             -- 3 at insert; Extend raises it, CHECK ≤ 6
  spec               JSONB NOT NULL,           -- SkillSpecSchema; written only in 'specifying'
  spec_version       INT NOT NULL,
  state              JSONB NOT NULL,           -- SkillDraftStateSchema, discriminated on status; CHECK state->>'status' = status
  blocked_reason     skill_draft_blocked_reason,  -- nullable: set iff status = 'blocked' (CHECK)
  end_reason         skill_draft_end_reason,      -- nullable: set iff status IN ('abandoned', 'failed') (CHECK)
  idempotency_key    TEXT UNIQUE,              -- nullable: null for CLI-started drafts; the draft_skill call's key
  transitioned_at    TIMESTAMPTZ NOT NULL,     -- when status last changed; the reconcile cron's age
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
  -- UNIQUE (skill_name) WHERE status NOT IN ('live', 'abandoned', 'failed')
)

skill_draft_rounds (
  id               UUID v7 PK,
  draft_id         UUID NOT NULL REFERENCES skill_drafts(id),
  round            INT NOT NULL,
  coding_task_id   UUID NOT NULL REFERENCES coding_tasks(id),
  findings         JSONB NOT NULL,           -- SkillFindingsSchema: what this round was asked to fix; [] at round 0
  tip_sha          TEXT,                     -- nullable: null until the round's coding task opens its PR
  verify_report    JSONB,                    -- nullable: SkillVerifyReportSchema; null until verify settles
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (draft_id, round)
)

skill_draft_reviews (
  id                 UUID v7 PK,
  draft_id           UUID NOT NULL REFERENCES skill_drafts(id),
  round              INT NOT NULL,
  reviewer           skill_reviewer NOT NULL,
  model              TEXT NOT NULL,          -- upstream model id, as reported by the backend
  checklist_version  TEXT NOT NULL,
  verdict            skill_review_verdict NOT NULL,
  findings           JSONB NOT NULL,         -- SkillFindingsSchema
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (draft_id, round, reviewer)         -- written through ON CONFLICT DO UPDATE with a no-op SET
)

skill_egress (
  id              UUID v7 PK,
  run_id          UUID NOT NULL REFERENCES skill_runs(id),
  method          TEXT NOT NULL,
  origin          TEXT NOT NULL,
  path            TEXT NOT NULL,             -- never the query string
  request_bytes   INT NOT NULL,
  response_bytes  INT NOT NULL,
  status          INT,                       -- nullable: null when denied or failed before a response
  outcome         skill_egress_outcome NOT NULL,
  denied_reason   skill_egress_denied_reason,  -- nullable: set iff outcome <> 'forwarded' (CHECK)
  bindings        JSONB NOT NULL,            -- EgressBindingsSchema: [{ secret, event: 'substituted' | 'misuse' }]
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
)

-- skill_runs gains:
  git_sha            TEXT,        -- nullable: null only on rows from before the column; every new row sets it
  run_as_user_id     UUID REFERENCES users(id),     -- nullable: as git_sha
  run_as_profile_id  UUID REFERENCES profiles(id),  -- nullable: as git_sha
  shadow             BOOLEAN NOT NULL DEFAULT false,
  error_kind         skill_run_error_kind,  -- nullable: set iff status = 'error' (CHECK)
  -- chk_skill_runs_outcome admits output on an error verdict only when error_kind = 'output_invalid'

-- skills gains:
  disabled_reason    skill_disabled_reason,  -- nullable: set iff disabled (CHECK); backfill: 'deregistered' where the sha has a live deploy, else 'awaiting_first_deploy'

-- skill_context_calls.error becomes ctx_error_kind (the CtxErrorKind set); http.request rows give way to skill_egress
```

`classifier_log` gains `reasons` (`SkillRiskReason[]`), `declared_network` and the capability flags it read, so a deploy records why it got its tier. `skill_deploys.approved_by` also holds an Override's owner.

## Exactly-once invocation `[confirmed]`

`runner.invoke` honours an optional `idempotencyKey: string` parameter. When set, the runner participates in a database-level state machine that gives **exactly-once execution** semantics across retries — without coupling to any specific workflow engine. Pattern is Brandur Leach's [Stripe-like Idempotency Keys in Postgres](https://brandur.org/idempotency-keys) (atomic phases + recovery points), chosen over framework-level step-splitting after [research across Temporal, Inngest, LangGraph, and the transactional-outbox literature](https://exactly-once.github.io/posts/side-effects/) concluded that DB-level idempotency is the canonical answer.

**State machine.** `skill_runs.recovery_point` ranges over three states, advanced by atomic UPDATEs inside `runInTx`:

```
INSERT recovery_point='started'  ← startOrRecoverRun, atomic
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
| `started` → `executed` | `WHERE id = $1 AND recovery_point = 'started'` | `recovery_point`, the worker's `output` or `error`, `resource_usage`, `finished_at` | a zero-row match throws: the row was not at `started`, which no retry path reaches |
| `executed` → `finished` | `WHERE id = $1 AND recovery_point = 'executed'` | `recovery_point`, `status`, and the verdict's `output` or `error` | `transitioned`; `already_finished` with the row another attempt settled; a row at `started` or missing throws |

| `recovery_point` | `status` | `output` / `error` | `resource_usage` | `finished_at` |
|-|-|-|-|-|
| `started` | `running` | both null | null | null |
| `executed` | `running` | what the worker produced: `output` (null when the skill returned nothing) with `error` null, or `error` with `output` null | set | set |
| `finished` | `success` | `output` (possibly null), `error` null | set | set |
| `finished` | `error` | `error` set, `output` null | set | set |

- `chk_skill_runs_status_iff_finished` (Data model): a terminal `status` exists exactly in the `finished` phase.
- `chk_skill_runs_executed_payload`: `finished_at`, `resource_usage` and the worker's `output` or `error` arrive with `executed` and are absent before it.
- `chk_skill_runs_outcome`: `output` and `error` are alternatives; an `error` verdict names its reason and keeps no output, a `success` verdict has no error.

The `executed` payload stays in its existing columns under CHECK, a deviation from [state-machines.md](../.agents/rules/state-machines.md)'s per-state JSONB blob: the columns are populated in production, the CHECK gives the same all-or-none invariant, moving them would cost a data migration with no reader to benefit, and `chk_skills_run_as_iff_live_schedule` is the same accepted shape. `error` is free text, so a worker failure and an output-schema rejection cannot be told apart by query; an `error_kind` enum is a residual (todo).

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
| `recovered`, `recovery_point='started'` | In-flight: either the prior attempt crashed mid-execute, or another worker is currently executing this same key. The runner can't tell those apart from the row state alone. Reject as `inflight`, naming the run — conservative refusal in both cases, since re-executing risks double-firing non-idempotent side effects (and in the concurrent case, the original is still running and will eventually finalize). Operator inspects. Future manifest flag `idempotent_invocation: true` would opt into optimistic re-execute. The stuck-run sweeper moves a `started` row past every possible execution time to `host_lost`, after which the key replays that error ([Run failures](#run-failures)). |

**Caller key conventions** (deterministic per logical fire):

| Caller | Key shape |
|-|-|
| `skill-cron-fire` handler | `skill-cron:${skillId}:${scheduledFor}` — same shape as the event-bus dedup id |
| Agent-loop tool dispatch | `skill-tool:${ToolCallContext.idempotencyKey}` — the loop's key from the turn token, iteration and position; it covers the crash between a run's commit and Inngest recording the durable tool step |
| CLI / one-shot tests | Omit (no retry context) |

**Race safety.** Concurrent attempts with the same key are serialised by the `uniq_skill_runs_idempotency_key` UNIQUE constraint on `skill_runs.idempotency_key`. Postgres's default unique-constraint semantics treat NULLs as not-equal — multiple null-key rows (CLI / tests) coexist freely while non-null keys are constrained to one row. `startOrRecoverRun` writes through `ON CONFLICT (idempotency_key) DO UPDATE` with a no-op SET ([.agents/rules/inngest.md](../.agents/rules/inngest.md)): a recovered row comes back with its recovery point and cached payload, and `xmax = 0` tells `new` from `recovered`. The `started` refusal above, not a row lock, keeps a concurrent attempt from executing. Plain UNIQUE was chosen over a partial unique index `(idempotency_key) WHERE idempotency_key IS NOT NULL` because both give identical semantics for this case but plain UNIQUE drops the `WHERE` predicate dance from every `ON CONFLICT` site — and from the comments explaining it. ([Postgres docs](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-UNIQUE-CONSTRAINTS) confirm the NULL-not-equal default.)

**Why DB-level over framework-level (Inngest step.run boundaries).** Framework-agnostic — survives engine swaps, works under Inngest today and bare `setTimeout` for CLI runs. Avoids Inngest's `Jsonify<Awaited<T>>` return-type friction. One code path for all callers. Survives crashes the framework can't see (LangGraph's specific critique). See PR #303 review thread and the [decision summary in todo](todo.md).

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

Public interface (canonical — see [Where the classifier runs](#where-the-classifier-runs) for the full RPC contract):

```typescript
interface SkillRunner {
  register(opts: { branch: string; origin: SkillDeployOrigin }): Promise<RegisterResult>;
  approveDeploy(opts: { pendingId: string; origin: SkillDeployOrigin }): Promise<RegisterResult>;
  denyDeploy(opts: { pendingId: string; reason?: string }): Promise<Result<void, DenyDeployError>>;
  rollback(opts: { name: string; toGitSha: string; origin: SkillDeployOrigin }): Promise<RegisterResult>;
  deregister(opts: { name: string }): Promise<DeregisterResult>;
  enable(opts: { name: string; origin: SkillDeployOrigin }): Promise<EnableResult>;
  list(): Promise<readonly SkillSummary[]>;
  invoke(opts: { name: string; inputs: unknown; runAs: SkillRunAs }): Promise<Result<SkillRunResult, SkillInvokeRejection>>;
}
```

## Relationship to other modules

| Module | How it relates |
|-|-|
| [sandbox.md](sandbox.md) | Tier 2 workers are sysbox containers created via the `Sandbox` interface — same supervisor, proxy, reaper, cgroup parent. |
| [coding-delegation.md](coding-delegation.md) | Skills are authored via the same worktree + branch flow. The skill library is a separate user-owned bare git repo at `$COGMO_SKILLS_PATH`, operated on by the existing `Sandbox` + coding-delegation machinery. |
| [scheduling.md](scheduling.md) | Cron-triggered skills use Inngest cron. Manual/event skills use Inngest events. |
| [evolution.md](evolution.md) | Skill creation is stage 2+ evolution. Approval gates apply to new skills before merge. |
| [integrations.md](integrations.md) | Voyager skill-library concept, SKILL.md standard, description-embedding retrieval, MCP tool registration. |
| [memory.md](memory.md) | Skills access memory via the `Service` interface. |

## Decisions

| Decision | Choice | Rationale |
|-|-|-|
| Language | Python only | Larger codegen corpus, full ecosystem, Python-native agent tooling, reads like pseudocode. TS revisit when a concrete driver appears. |
| Runtime tiers | WASM (Pyodide) + sysbox container | WASM covers glue/data skills cheaply; container handles the rest. No middle tier — avoids building multiple dispatchers and state models. |
| Container runtime | Sysbox (not plain runc) | Daemons already running for coding delegation. Per-container overhead negligible. User namespaces are a free security win. |
| microVM (Firecracker) | Deferred | Personal scale, trusted codegen. Overkill until trust boundary widens. |
| Warm pool | Day 1, not optimization | 1–2s cold start on every invocation is user-visible. Dispatcher abstraction also removes the need for a sync/async tier split. |
| Storage | Git-backed skill library | Diffs, rollback, audit — what self-evolution needs. |
| Storage layout | Configurable local bare repo, user-owned | Personal skills belong in a user-owned repo, not a Cogmo fork or shared public repo. Remote optional for multi-machine sync. |
| Cogmo as git server | No | Most commits auto-apply; no PR UI needed. Multi-machine sync (if/when) uses the user's own remote. |
| Repo history | Append-only, no force push | `skills.git_sha` points to specific commits — history rewrites would dangle live skills. Enforced at local bare repo + proxy + optional remote. |
| Review model | Risk-tiered auto-apply (`auto` / `notify` / `approve` / `blocked`); agent reviewers replace the human tap, and `approve` becomes opt-in per class | Nobody reads skill code. The classifier makes "what's safe to auto-apply" explicit; mechanical gates and a cross-family panel stand where the tap was; the human approves the spec, sees notifications, and keeps a gate only for the classes they opt into. |
| Authoring lifecycle | Its own state machine (`skill_drafts`), reusing the pipelines' gate and loop patterns | Its stages are fixed code and fixed roles; the pipelines' loops and coding stage are unbuilt; its per-state data needs its own CHECKs. |
| Human interaction | One spec card per draft: the manifest-level contract and its open questions | Purpose, I/O, effects, secrets, hosts and schedule are what a human can judge without reading code. Drift from the approved spec is a rejection. |
| Reviewers | The author's model in a fresh session plus the other family's; structured verdict; 3 rounds | Self-preference bias makes the author's family the weakest sole judge; rounds are bounded because self-repair is limited by critique quality. A seeded-bug suite is a regression floor, not a recall measure. |
| Prompt practices | Each has a mechanical twin in the verify stage | Prompts are advisory; gates are deterministic. |
| Classifier execution | Branch + `register` RPC | No repo-watching. Branch ≠ deploy. Atomic, synchronous, authoritative. Pre-commit hook deferred unless ~30s feedback lag becomes painful. |
| Who advances `main` | Only Cogmo's `register` RPC | Pre-receive hook rejects direct pushes to `main`. Makes "live on main" atomic with "classified and approved"; collapses transient "committed-but-rejected" states; structurally prevents force push. |
| Concurrency on register | Advisory lock + pending-deploy check | `pg_advisory_xact_lock` per skill name queues concurrent registers; it doesn't refresh the loser's snapshot (audit filed in `todo.md`). Refuse if a pending-approval deploy exists. Idempotent for no-op SHAs. Standard DB-backed state-machine pattern. |
| LLM tool surface | One tool per skill (dynamic per-turn tool list) | Matches progressive disclosure — skills appear in the tool list with their own name + description. No `invoke_skill` wrapper (would break discovery). Orchestrator rebuilds tool list each turn from `SkillRunner.list()`. |
| Manifest | Single `SkillManifestSchema` (Zod) parsed from `SKILL.md` frontmatter | Five consumers read it: register RPC, classifier, dependency populator, dispatcher, tool registrar. One schema prevents field drift. Superset of Anthropic SKILL.md. |
| State reset | Fresh processes per task forked from a pre-imported supervisor, behind a per-task relay; the task's process tree is killed before the worker is released; per-skill `recycle` opt-out | No in-memory state or process crosses tasks, at a few ms per task. Recycling every task also resets the filesystem, at a container start per invocation. |
| Skill discovery | Progressive disclosure (SKILL.md) | Matches Anthropic standard. At <50 skills, tool list stays manageable. Retrieval (`search_skills`) added later when tool-list tokens or selection accuracy forces it. |
| Resource budgets | Declared in SKILL.md; cgroup slice (container) / `WebAssembly.Memory.grow` hook plus a child-process cgroup (WASM) | Container tier reuses sandbox.md cgroup parent. `resourceLimits` cannot cap WASM memory, which is an ArrayBuffer. Per-skill override within tier hard ceilings. |
| Cost tracking | Wall-clock + peak memory + LLM tokens via `ctx.llm` + declared `cost_per_call_usd` | Measured per `skill_run`. Dispatcher enforces daily/monthly budget from SKILL.md. `auto` tier requires zero paid surface. |
| Cron failure handling | `error_kind` classes: a pausing kind re-fires once, every failure notifies, defects auto-disable | Infrastructure failures must not read as skill bugs, and a run that executed is never silently repeated. |
| Tier-1 boundary | Pyodide in a forked child under `--permission` and `--disallow-code-generation-from-strings`, minimal frozen `jsglobals`, `env: {}`, no network API, a `grow` hook | Measured: `jsglobals` alone leaves the `Function`-constructor path, `resourceLimits` does not cap WASM memory, and snapshots cannot preload dependencies. |
| Contracts | pydantic `Input` / `Output` in `skill.py` generate the tool schema; one `cogmo_ctx` generated from the TS schemas | One source per contract; every copy generated and checked in CI. |
| Inter-skill composition | Not in v1; future via `ctx.skills.invoke()` through orchestrator | Agent composes at LLM level. Direct skill imports rejected — break permission scoping. |
| `ctx` v1 surface | secrets, memory, files, http, now, user, log (attachments, llm, notify pending) | Covers what skills actually need. `http` is tier 1's only network path and is gated on the manifest's `network.allow`; metrics, composition and scheduling stay deferred. |
| Invocation | Inngest events | Durable execution, retry, scheduling — all free. Matches existing orchestration pattern. |
| Output delivery | JSON via tool result; binaries via `AttachmentStore` | Same pattern as `generate_image`. |
| Skill metadata | `SKILL.md` frontmatter | Matches Anthropic's progressive-disclosure standard, already referenced in [integrations.md](integrations.md). |
| Host access | `ctx` object projected over JSON-RPC | Mirrors TS `Service` pattern for tools — same shape, over a pipe. Covers secrets, memory, attachments uniformly. |
| Secrets access | Pull model — `ctx.secrets.get(name)` gated by manifest allowlist; bound secrets become placeholders the egress proxy substitutes | Materializes secrets only at point of use; per-access audit; zero-touch rotation. Reads naturally in Python. The manifest gating its own access is the skill declaring its own permissions, which is why risk tiering and the egress allowlist carry the weight rather than the allowlist alone. |
| Secrets storage | Existing encrypted `secrets` table (per [infrastructure.md](infrastructure.md)) | Cogmo already has a minimal self-hosted vault. No external service at personal scale. |
| Egress enforcement | One token-injecting forward proxy in `cogmo serve`; tier-2 workers on an internal network with no other route; `ctx.http` through the same module | The missing route is the enforcement, so unsetting a variable bypasses nothing; one implementation of allowlist, pinning, substitution and audit. In-process Node over a mitmproxy sidecar: one language, one deployment unit, no run-correlation channel. |
| Egress allowlist | Manifest `network:` block, default deny (stage 1) | Bounds where a credential can travel even while the skill holds it in plaintext, which is what makes it the release gate rather than substitution. Matches the default-deny-plus-allowlist consensus for running model-authored code. |
| Dep declaration | `dependencies: ["pkg==version", ...]` in `SKILL.md`; Zod regex rejects ranges/extras/URLs/paths | One Zod schema, five consumers — same drift-prevention as the rest of the manifest. Strict pinning prevents resolution drift between register and re-resolve. |
| Lockfile | `requirements.lock` next to `skill.py`, hash-pinned via `uv pip compile --generate-hashes`, author-committed | Transitive graph pinned; register byte-compares to catch staleness. Atomic with the rest of the skill from the operator's POV. |
| Resolver | `uv` (compile + sync) baked into `cogmo-skills:<version>` runtime image | Sub-100ms venv creation; hash pinning is first-class; resolver at register matches resolver at populate byte-for-byte. Already standardised across the codebase. |
| Where compile runs at register | Short-lived sandbox session via `SandboxClient` | No host-side `uv` dependency; same `uv` binary as runtime; ~1-2s register latency is acceptable for a once-per-skill-version op. |
| Dep cache shape | Per-lockfile-hash venv at `/skill-venvs/`; storage chosen per backend via `SandboxCapabilities.depsCacheSharing` (`shared-volume`: ext4 Docker volume, cross-worker dedup; `per-sandbox`: container-local ephemeral disk) | Avoids per-skill image rebuild (kills warm-pool economics). uv's hardlink + atomic-rename requirements only hold on POSIX backends; FUSE object storage (Daytona Volumes / mountpoint-s3) lacks them so the runner falls back to per-sandbox ephemeral and pays a cold populate per worker. Capability flag is the dispatch — wiring is backend-agnostic. |
| Cache atomicity | Populate to `<hash>.tmp.<workerId>/`, `.ready` marker, `mv -T` rename | uv has no directory-level atomicity guarantees under concurrent writers ([uv #15335](https://github.com/astral-sh/uv/issues/15335)). Marker file + `mv -T` rename is the portable answer on POSIX storage; the loser of a concurrent populate sees `.ready` on the target after its rename fails and exits success. On `per-sandbox` backends each worker has its own `/skill-venvs/`, so cross-worker concurrency on the same hash can't happen — the rename still runs but is single-writer. No Postgres advisory lock needed at this layer (advisory lock IS used for register concurrency, a separate concern). |
| Cache reachability | `skills.lockfile_hash` denormalised from git; reaper sweeps `<hash>/` with no live reference + 7-day grace | LRU evicts cold-but-live skills and pays multi-second cold start on next invoke. Reachability + grace period is correct. |
| Source distributions | Forbidden (`--only-binary=:all:`) | Sdists run arbitrary install-time code + need a build toolchain. Auto-tier never includes sdists. Opt-in escape hatch deferred to a real driver. |
| Venv overlay vs `--target` | Per-skill venv, not `--target` + PYTHONPATH | `--target` has well-known namespace-package collisions ([pip #10629](https://github.com/pypa/pip/issues/10629)), inert `.pth` files, missing console scripts; PYTHONPATH overlay shadows base-wins which is surprising. Venv creation is cheap enough that "always a venv" is defensible. |
| Tier 1 deps | `micropip.install(specs, keep_going=False)` at WASM worker init, post-install `importlib.metadata.version()` verify per declared dep | Pyodide-incompatible wheels fail at register (`src/skills/pyodide-compat.ts` reads `pyodide-lock.json` + checks PyPI for a pure-Python wheel). Hash pinning isn't possible (no `micropip --require-hashes`); a per-lockfile-hash micropip wheel cache + private mirror are deferred (`[research]`). |
| Private mirror | Deferred (`[research]`) | Public PyPI + hash pinning is fine at single-operator scale. Devpi/Bandersnatch becomes table stakes when scale widens or quarantine windows on new releases are wanted. |
| Attestation verification | Deferred (`[research]`) | PEP 740 attestations are emerging (132k+ packages by Mar 2026). Verification via `pypi-attestations` belongs alongside the mirror when that lands. |

## Open questions

Calibration-grade — settle during real usage, not before implementation:

- **Risk classifier thresholds** — starting boundary between `notify` and `approve` is a first pass. Relax or tighten based on observed false positives / actual incidents.
- **Pool sizing** — `min=0 / max=3`, replace every 500 tasks, 30 min idle shutdown are starting values. `min` and `idleShutdownMs` are operator-tunable via `COGMO_SKILLS_POOL_MIN` / `COGMO_SKILLS_POOL_IDLE_SHUTDOWN_MS` (see Warm pool). Tune on real workload.
- **Subinterpreter ecosystem** — track which C extensions need `isolation: recycle`. If the list grows large, flip default.
- **Body substitution** — whether a binding may place a secret in a JSON body field (`body_json_path`), or stays header- and query-only.
- **Raw TCP for tier 2** — whether a skill may ever request a non-HTTP route (SMTP, a database protocol), and through what.
- **Retrieval-layer trigger** — when to add `search_skills()` (tool-list tokens > ~5k? selection accuracy drop?). Add metric first; threshold later.
