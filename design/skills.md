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

Overrides validated at deploy against a per-tier hard ceiling (e.g., ≤2 GB memory, ≤10 min wall-clock) to prevent runaway declarations.

### Tier-1 boundary `[proposed]`

**Today `[confirmed]`.** Tier 1 is not an isolation boundary. `host.ts` starts a `worker_threads` Worker with no `env`, `execArgv` or `resourceLimits`, so the thread holds a copy of the server's environment, the master key included. `worker-entry.ts` calls `loadPyodide` without `jsglobals`, so Python's `js` module is the thread's `globalThis`: `js.process.env`, an unguarded `fetch` the SSRF guard never sees, and `pyodide.http.pyfetch` on top of it. `pyodide_js.FS.mount(NODEFS, …)` mounts host paths. Every JS proxy's `.constructor` is the `Function` constructor, so JS code built from a string runs in the host's global scope. `wasm-lint` has no rule for `js`, `pyodide_js` or `micropip`. What holds is the CPU bound: the interrupt buffer raises `KeyboardInterrupt` within milliseconds at the next JS↔WASM boundary, and `worker.terminate()` ends a loop that never reaches one.

**Layers**, in the order they ship. Each closes a route the others leave open, and a test per layer turns the others off and shows its route closed.

1. **A forked child process per worker**, launched with `--permission`, `--allow-fs-read` for the Pyodide distribution and the worker's read-only wheel directory, `--allow-worker`, and `--disallow-code-generation-from-strings`. It is granted no `--allow-fs-write`, `--allow-child-process` or `--allow-net`, so `fetch` throws `ERR_ACCESS_DENIED` and `FS.mount(NODEFS)` reaches nothing outside the grant. The V8 flag makes the `Function`-constructor path throw `EvalError`; Pyodide evaluates no JS string once loaded. Pyodide runs on a worker thread inside the child, created with an `execArgv` that re-lists the child's flags (an explicit `execArgv` otherwise drops the grant), so the child's main thread can write the interrupt buffer the two threads share. Emscripten side modules that define JS with `EM_JS` build it from strings at load, which the flag refuses; `pyodide-compat.ts` load-tests each native package in the lockfile under the flag, and one that fails to load makes the skill `tier: container`. Emscripten's boot calls `process.binding("constants")`, which `--permission` denies, so the child shims it with `os.constants` before `loadPyodide`. The Node permission model's own docs say it does not stop malicious code: symlinks are followed out of granted paths, which is why the host writes the wheel directory without links, and inherited file descriptors bypass it, which is why the child inherits only the IPC channel. It is one layer of several, not the boundary on its own.
2. **`env: {}`** for the child.
3. **Minimal `jsglobals`**: a frozen null-prototype object holding only `setTimeout` and `clearTimeout`, which `webloop` needs for the asyncio loop that `ctx` RPCs await. `ctx` crosses through the registered `__cogmo_bridge__` module, which `jsglobals` does not affect.
4. **No network from the start.** The host fetches the lockfile's wheels from PyPI, checks each against its `requirements.lock` hash (closing micropip's missing `--require-hashes`), and writes them to a per-lockfile-hash directory the child can only read. The child installs from that copy. Before skill code runs, the child deletes `fetch`, `XMLHttpRequest` and `WebSocket` from its globals, so a hole in layer 1 still finds no network API. Pyodide's built-in packages (pydantic among them) come from a `packageCacheDir` the host fills with `checkIntegrity` on.
5. **Memory.** Worker `resourceLimits` cap only the JS heap, never ArrayBuffers, and WebAssembly memory is one: a measured worker with a 64 MB JS heap limit grew Pyodide to 3.2 GB. Before `loadPyodide`, the child patches `WebAssembly.Memory.prototype.grow` to throw past `resources.memory_mb` (128 MiB by default, re-measured with pydantic loaded); Python sees a `MemoryError` and the interpreter survives. The hook covers Emscripten's growth path, which calls `grow` from JS; it does not cover a WebAssembly `memory.grow` instruction or code that reaches the original method another way. The hard ceiling is a per-child cgroup, which needs the delegation [sandbox.md](sandbox.md#hierarchical-enforcement-via-cgroup-parent-confirmed-slice-naming--assignment--proposed-aggregate-budget-enforcement) defers; without it there is no hard memory ceiling. `RLIMIT_AS` is not used, since V8 reserves guard regions far larger than the heap.
6. **CPU.** At `wall_clock_s` the host sends the child an IPC message, since a `SharedArrayBuffer` cannot cross `fork()`; the child's main thread writes the interrupt buffer, and after the grace window the host sends `SIGKILL`, which a loop with no JS↔WASM boundary cannot outlast.
7. **Lint**: `wasm-lint` rejects imports of `js`, `pyodide_js`, `pyodide.ffi`, `pyodide.code`, `pyodide.http` and `micropip`; the verify stage rejects dynamic code. Lint is the UX layer that tells an honest author why, not a boundary.

**What it still cannot promise.** Resource exhaustion the layers do not meter (file descriptors, recursion depth, timer churn) is bounded only by the wall clock, the kill and, where present, the cgroup. Side channels between processes on one host are out of scope. The interrupt buffer is shared only between the child's two threads, and only the main thread writes it. An escape past all seven layers lands in an unprivileged Node process with no network, no writable path and no secrets in its environment.

**Cost.** The layers are launch arguments or work before `ready`, so they add nothing per call. The child itself does: about 200 ms to start a process, which the pool hides. Booting bare Pyodide takes about 1 s, against the ~5 s a worker thread spends today, mostly on micropip fetching from PyPI. The pydantic wheels add about 190 ms per cold child.

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

- **`main` is advanced only by Cogmo** — its `register` RPC, and the commits it makes at boot under the bootstrap lock (the toolchain commit, [Verify stage](#verify-stage), and the one-time layout commit, [Per-skill structure](#per-skill-structure)), which deploy no skill. Direct pushes to `main` from any other source (agent, human, tool, CI) are rejected unconditionally. Agents work on feature branches; the orchestrator is the sole merger. This makes "classified and live" atomic with "present on `main`" — no transient "committed but rejected" state can exist.

  **Primary enforcement: remote-side branch protection.** The operator configures `main` protection on the remote (GitHub branch protection rule; Gitea/Forgejo equivalent). The agent's sandbox-side pushes target feature branches (`cogmo/<idShort>`), so they never attempt `main`; Cogmo's `register`-side push uses an authenticated identity with bypass so the legitimate path still works.

  **Secondary enforcement: bare-repo `pre-receive` hook.** Installed by `bootstrapSkillsRepo` against direct `git push <bare-repo>` from a misconfigured CI script or operator typo. In normal operation the hook is bypassed — `register` uses filesystem `update-ref`, and `fetchFeatureBranch` uses `git fetch` (write-side ref update with no `receive-pack`). The hook is defense-in-depth, not the primary gate.

  `register` is a two-leg operation: `git update-ref refs/heads/main <sha>` on the bare repo's filesystem, then `git push origin <sha>:refs/heads/main` to the remote. Push failure surfaces to the operator and leaves the local advance in place; the next `register` (or a manual push) reconciles. The filesystem-write path is the sole merge mechanism and is available only to Cogmo.

- **No force push, no history rewrite on any branch.** `skill_deploys.git_sha` references point to specific commits — if history is rewritten, those SHAs dangle and the live skill becomes uninvocable. Enforced by:
  - The bare-repo `pre-receive` hook (non-fast-forward rejected on every branch).
  - Remote branch protection (GitHub "do not allow force pushes" / "require linear history"; Gitea/Forgejo equivalent).
  - Coding delegation's sandbox proxy refuses any `git push --force`, `git push -f`, or `git update-ref` that would rewrite a reachable commit on its worktree side too.

- **Append-only branches.** Every deploy is a commit added to a feature branch, then merged fast-forward into `main` by `register`. Today `[confirmed]` a rollback rewinds `main` to a prior SHA, mirrored with `--force-with-lease`; the forward-commit rollback (Deploy lifecycle) `[proposed]` makes every move of `main` a fast-forward.

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

Today `[confirmed]` register reads `SKILL.md`, `skill.py` and `requirements.lock` at the repo root, one skill per branch. A directory per skill on `main`, as above, is `[proposed]`: it lets drafts of different skills merge `main` cleanly and makes rollback a forward commit.

**Moving to it.** `migrateSkillsLayout`, a bootstrap step after the skills repo is initialized, runs under the bootstrap lock and makes one layout commit:

- It copies the files of every `skills` row, disabled ones included, read at the row's `git_sha` from the repo root, to `skills/<name>/`, and deletes the root skill files in the same commit.
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
| **Auto** | Everything not matched below: tier `wasm`, no declared or detected effect, no `network:` block, at most two secrets of any kind, every dependency on the allowlist | `register` fast-forwards `main` to the branch tip immediately on classification. Skill is live. No notification. |
| **Notify** | A dependency on neither list, OR any other declared or detected effect (`reads_memory`, `writes_memory`, `reads_user_data`, `writes_user_data`, `reads_filesystem`), OR a `network:` block without secrets | `register` fast-forwards `main` to the branch tip immediately on classification. No notification is sent today; [Notifications and undo](#notifications-and-undo) specifies one. |
| **Approve** | First match: validation errors; a dependency on the approve list; an effect in `APPROVE_GATING_EFFECTS` (`deletes_external`, `sends_email`, `sends_message`, `posts_public`, `financial`, `spawns_subprocess`, `writes_filesystem`); tier `container`; **any secret together with a `network:` block**; three or more secrets | `register` leaves `main` untouched; the branch stays as-is. Through `register_skill`, Telegram gets an approval prompt with the name, declared effects, schedule and short sha, and approve/deny buttons; the auto-register path posts nothing. `main` is fast-forwarded only when `approveDeploy` fires. |

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

**Failure mode.** Any throw from the AST path (parser load failure, walk panic, unexpected node shape) is caught at the `classifier.ts` boundary and routes through the declaration-only stub (`classifyManifestStub`). The audit log shifts `classifier_version` from `ast-1` to `stub-2-effect-aware` so an operator can spot the degradation; the deploy still completes with a conservative declaration-only tier. The stub caps its tier at `notify`. A null parse tree takes the declarations-only path instead, which can return `auto`; the planned verify stage's syntax gate rejects such a file before register.

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

// [proposed]: `rejected` carries a sealed union in place of `errors`.
//   | { status: "rejected"; rejection: RegisterRejection }
type RegisterRejection =
  // terminal for this tip: the author, or the owner, must change something
  | { kind: "manifest_invalid"; issues: readonly string[] }
  | { kind: "lint_failed"; findings: readonly SkillFinding[] }
  | { kind: "classifier_rejected"; undeclared: readonly SkillEffect[] }
  | { kind: "lockfile_invalid"; detail: string }
  | { kind: "pyodide_incompatible"; packages: readonly string[] }
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
  | { kind: "registrar_unavailable"; cause: "index" | "sandbox" };

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

<a id="first-deploy-race"></a>**The first-deploy race** `[proposed]`. Two first deploys of one name both insert a `skills` row, and the loser's insert raises `23505` on `skills.name`, which the transactor does not retry. Register maps it at the store edge and retries once, in-process, in a fresh transaction whose snapshot holds the winner's row, so the retry meets the skill as an edit: `no_op` when the winner deployed the same tip, `pending_deploy_exists` when it left a pending deploy, otherwise a normal register. Only a retry that loses again returns `concurrent_first_deploy`. Nothing is wrong with the tip, so the rejection is pausing: a draft parks at `blocked: registrar_unavailable` on it and spends no round ([Skill lifecycle](#skill-lifecycle)).

### Deploy lifecycle `[confirmed]`

The unit is a `skill_deploys` row, keyed by its id; its `status` is the `skill_deploy_status` enum. `live`, `denied` and `rolled_back` are terminal, and `live` means the deploy went live, not that it is current — the enable guard below reads it that way. While a deploy of an enabled skill is pending, its `skills` row keeps the skill's last live sha, so the live version stays live through the approval window. A first deploy has no live version: its `skills` row is inserted disabled at the pending tip and stays there if the deploy is denied, and the enable guard keeps that sha from going live without a review.

Activation is a second lifecycle this section does not model: `skills.disabled` together with whether a `live` row exists at the skill's current sha — a first deploy pending (disabled, no live row), a first deploy denied (the same), live (enabled), deregistered (disabled, live row), and the planned failure breaker — with `deregister`, `enable`, `approve` and `rollback` as its transitions. Naming it as its own state machine is a todo; until then it is an accepted residual, and the enable guard is its one explicit rule.

```
register (auto, notify) ──────────────────────────────▶ live
register (approve) ──▶ pending_approval ──approve──▶ live
                                        └──deny────▶ denied
rollback ─────────────────────────────────────────────▶ rolled_back   (a new row; the one it supersedes keeps `live`)
register (blocked tier) ──────────────────────────────▶ blocked       [proposed]: terminal, writes nothing else
```

Register, approve and rollback take the skill name's `pg_advisory_xact_lock` inside the transaction. It queues them; it does not refresh the snapshot the queued transaction reads ([store-pattern](../.agents/rules/store-pattern.md)), so it is not a guard and the table below does not count it as one. Every check a use case makes before `runDeployTx` — step 2 above — belongs to the use case and is not in the table.

| Transition | Guard | Writes, in order, in one transaction | Outcome |
|-|-|-|-|
| `register` → `live` | no `pending_approval` row for the skill, read from the snapshot (stale under a concurrent register: failure modes); `main` fast-forwards to the tip | upsert `skills` at the tip; insert the row `live`; `update-ref main`. After the commit, best-effort: delete the feature branch, then mirror | `live`, `no_op`, `rejected`; a moved `main` rolls back as `non_fast_forward` |
| `register` → `pending_approval` | no `pending_approval` row for the skill (snapshot). `main` is not checked in the transaction: `applyFilesystem`, where it is re-read, runs only when the deploy goes live | insert `skills` disabled for a first deploy, else leave it; insert the row | `pending_approval` |
| `approve`: `pending_approval` → `live` | `UPDATE skill_deploys SET status = 'live' … WHERE id = $1 AND status = 'pending_approval'`, the transaction's first write; a pre-read of the row refuses one the snapshot already shows resolved before the lock is taken | the row (`approved_by`, `resolved_at`); then `skills` at the deploy's sha and manifest, `disabled = false`; then `update-ref main`. After the commit, best-effort: mirror | `live`; `rejected` with `deploy_not_found`, `skill_not_found`, or `deploy_not_pending: status is '<status>'`; a moved `main` rolls back as `non_fast_forward_at_approve_time` |
| `deny`: `pending_approval` → `denied` | `UPDATE … WHERE id = $1 AND status = 'pending_approval'`; a zero-row match re-reads the row | the row (`resolved_at`); `skills` and `main` untouched | `transitioned`; `not_found`; `not_pending` with the row's status |
| `register` → `blocked` `[proposed]` | the risk tier is `blocked` ([Risk tiers](#risk-tiers-without-a-human)) | insert the row `blocked`, terminal, its reasons in `classifier_log`; `skills` and `main` untouched | `rejected` with the `blocked` rejection, the only rejection that writes a row |
| `rollback` → `rolled_back` | `main` unchanged since the pre-transaction read. The target is any commit whose manifest names the skill: no prior `live` row is required and nothing checks for a pending deploy — rollback is an owner-only CLI override of the approval gate (failure modes) | `skills` at the target sha; insert the row; `update-ref main` to the target, which rewinds past every commit after it, other skills' deploys included (failure modes). After the commit, best-effort: mirror with `--force-with-lease`. `[proposed]`: a forward commit on `main` that restores `skills/<name>/` to its content at the target, so `main` only fast-forwards, no other skill's deploy is touched, and the mirror is a plain push; `skills.git_sha` is the new commit, and the row records `restores_git_sha`: the target, or, when the target is itself a restoring commit whose row is `rolled_back`, that row's `restores_git_sha`, so the value always names a commit that had its own deploy | `live`, `no_op`, `rejected`; a moved `main` rolls back as `main_moved` |

Deny's outcomes are values its callers match exhaustively: `denyDeploy` returns `Result<void, DenyDeployError>`, `cogmo skills deny` exits 1 naming the miss, and a keyboard tap toasts `skill_deploy_not_found` or `skill_deploy_not_pending`. Nothing reports a resolution that did not happen. Approve and rollback carry a rejection as the `reason` string of `ExecuteRegisterResult`, which the use cases flatten into `RegisterResult.errors`: untyped, with no split between a failure that is terminal for the deploy (a manifest error) and one that only pauses it (PyPI unreachable during the lockfile compile), and the first-deploy `23505` race surfaces as a throw. `transport.skills.approveDeploy` recovers the two codes it can name by prefix and renders the rest as `skill_deploy_register_failed`. A residual, closed by the tagged rejection union in todo.md → Skills autonomy S10.

#### Per-state data `[confirmed]`

`resolved_at` and `approved_by` are per-state data, so two CHECKs tie them to `status` and no transition can leave a row between states.

| `status` | `resolved_at` | `approved_by` |
|-|-|-|
| `pending_approval` | null | null |
| `live` | set | the approver's identity when `approve` ran for a user; null when it ran for the owner from the CLI, and on a `register` row, which no human approved |
| `denied` | set | null |
| `rolled_back` | set | null |
| `blocked` `[proposed]` | set | null; an Override registers again, and that row carries the owner |

- `chk_skill_deploys_resolved_at_iff_terminal` (Data model): `resolved_at` is set iff the row is terminal.
- `chk_skill_deploys_approved_by_only_live`: an approver only on a `live` row. One direction only: a `live` row without an approver is a `register` or an owner-CLI `approve`.

Each is a single field — a timestamp, a foreign key — so it keeps its natural type under CHECK rather than moving into a per-state JSONB blob ([architecture-rules](../.agents/rules/architecture-rules.md)). The `skill_deploy_status` enum holds the four states above, and `blocked` once it lands `[proposed]`. `0077_skill_run_and_deploy_state_checks` rewrites the type without `approved` and adds the CHECKs of both tables; its failure modes are under Exactly-once invocation → Per-state data and hold for this table too — every shipped writer (`executeRegister`, `executeApprove`, `denyPendingDeploy`, `executeRollback`) sets `resolved_at` with a terminal status and `approved_by` only with `live`. Deploy-specific:

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
| `register_skill` run again by Inngest after the commit, before the step result was recorded | live tier: the second run is `no_op`, the tip being `main`. Approve tier: the second run is `pending_deploy_exists`, which the model reads as a rejection; and when the crash fell between the commit and the `skills/deploy/approval-requested` emit, no approval keyboard is posted | the database is consistent either way; the operator approves from the CLI. **Residual**: `register_skill` drops the `ToolCallContext.idempotencyKey` the loop supplies, `register` takes no key, and the emit is not part of any recovery |
| `main` moves between a deploy's checks and its `update-ref` (another skill's deploy landed) | nothing committed | `advanceMain` throws inside the transaction, which rolls back the row and the projection; the caller gets the rejection named in the transition table and retries |
| `update-ref main` succeeds inside `applyFilesystem`, then the commit fails or the process dies | `main` at the deploy's sha; the database as before the transaction — for an approve of an enabled skill, the row still `pending_approval` and `skills` at the old sha; register's feature branch still exists | the database decides what runs, so the code on `main` does not execute. Repeating converges for register and approve: `isAncestor(main, sha)` holds for the sha `main` already holds (a commit is its own ancestor), `update-ref` to it is a no-op, and register's branch is still there because it is deleted only after the commit. Rollback's database repeat converges too — `main` already equals the target, which satisfies its `unchanged` guard — but its mirror never does: the lease expects the remote at the target while the remote holds the pre-rollback sha, so every repeat's push is rejected until the manual force push below. **Residual**, against *`main` is authoritative* below: until then `refs/heads/main` and `skills.git_sha` disagree, and every other skill's branch based on the old `main` is `non_fast_forward`; if the operator denies instead — or a deny waiting on the row lock proceeds when approve's commit fails — deny writes only the row, so `main` keeps a commit whose deploy is `denied`, and the next deploy's mirror pushes it. Reconciliation is manual: rewind `main` to the sha it held before the failed transaction — the `skill_deploys.git_sha` with the newest `resolved_at` among `live` and `rolled_back` rows across all skills, or delete `refs/heads/main` if no deploy ever committed, since register handles an unborn `main` — before any further deploy; rewinding to this skill's `skills.git_sha` would drop other skills' later deploys |
| the feature branch delete after a committed register fails | the deploy is live; the branch lingers | logged as a warning; registering the branch again is `no_op` while its tip is `main`, and `non_fast_forward` once another skill has deployed — harmless either way; the branch can be deleted by hand |
| `mirrorMainToRemote` fails after the commit, or the process dies between the commit and the push | local `main` and the database agree; the remote lags | every failure in the mirror — reading `origin`, resolving the identity, the push — is caught and logged as a warning, and the deploy still returns `live`. After a register or approve the next deploy's push, or `git -C $COGMO_SKILLS_PATH push origin main`, reconciles (Repo invariants). After a rollback the remote is ahead of local `main` and every later fast-forward push is rejected; recovery is `git push --force-with-lease=refs/heads/main:<remote sha> origin main` by hand |
| `rollback` of one skill past another skill's later deploy | `main` loses the other skill's commits; its `skills.git_sha` is reachable from no ref once its feature branch was deleted; the force-with-lease mirror pushes the rewind | **Accepted residual** of the single linear `main`, against *`main` is authoritative* and the Repo invariant on dangling shas: the other skill stays invocable while git keeps the unreachable commit (whether gc against the bare repo prunes it is not established), and its next register on a branch based on the old `main` is `non_fast_forward` until rebased. Recovery is to re-register the other skill's tip from a branch rebased onto the rewound `main`. The forward-commit rollback above `[proposed]` removes this residual |
| `rollback` while a deploy of the same skill is pending | a `rolled_back` row and `main` at the target; the pending row stays pending, its `prior_git_sha` stale | accepted as the owner override it is: a later approve fast-forwards `main` back over the rollback when the target is an ancestor of the pending tip, and is `non_fast_forward_at_approve_time` otherwise until the tip is rebased; a deny leaves the rollback in place. A rollback to the pending tip itself puts unreviewed code live with the row still pending |
| `rollback` to a sha that never had a `live` row, then `deregister`, then `enable` | `enable` is refused with `no_live_deploy` | the enable guard matches `live` only and the rollback's row is `rolled_back`; accepted and stated at the guard, which is the one place that reads it. `[proposed]`: the guard also accepts a `rolled_back` row whose `restores_git_sha` once had a `live` row, which still refuses this case, since the target never did |
| a `deregister` lands while a deploy is pending, then the deploy is approved (the planned failure breaker would land the same way; today `disableSkill` is called only by `deregister`) | approve writes `disabled = false`, so the skill comes back live | the order decides: a deregister committed first is in approve's snapshot and approve still flips the flag; one committed after approve disables the now-live skill, which is what it asked for. **Decision:** approve keeps `disabled` when the skill's current sha has a `live` row — the skill was disabled after this deploy was queued — and tells the approver; only a first deploy's approval enables. Until that is implemented (todo), a residual |

**Approval-gate guard on `enable`.** Re-enabling refuses (`reason: "no_live_deploy"`) when the skill's current `gitSha` has no `skill_deploys` row with `status = 'live'`. Without the guard, a denied first deploy (`skills.disabled = true`, `skill_deploys.status = 'denied'` at the rejected sha) could be smuggled past the approval gate via `/disable foo` then `/enable foo` — flipping `disabled = false` would activate code that never passed human review. A rolled-back skill passes when its target once had a `live` row, which remains in the append-only history; a rollback to a sha that was never live leaves `/enable` refused after a `/disable`, because the predicate matches `live` only (Deploy lifecycle → failure modes). `[proposed]` After a forward rollback, `skills.git_sha` is the restoring commit, whose row is `rolled_back`; the guard also accepts a `rolled_back` row whose `restores_git_sha` once had a `live` row.

**Key properties:**

- **Branch ≠ deploy.** Agent can push any feature branch freely. Only Cogmo's own writes advance `main`: `register` and `approveDeploy`, rollback, and, at boot, the layout move and the toolchain commit `[proposed]`.
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
- What it needs from the engine is unbuilt there: loops, and coding delegation as a stage.
- Its per-state data (approved spec version, round, findings, the tip under review) needs CHECKs that a generic `stage_outputs` blob cannot carry.
- A stage turn holds `pipeline` authority, which refuses `delegate_coding` ([agents.md → Turn Authority](agents.md#turn-authority-proposed)); a draft starts coding tasks from the user's tap, not from a stage.

### Skill lifecycle

**Unit.** A `skill_drafts` row, keyed by its UUIDv7 `id`: one request to create a skill, or to change a live one, from the first spec to a terminal state. Its bounds are fixed when the row is inserted — the skill name, and for an edit the live `base_git_sha` — so nothing re-plans them. A round (`round`, from 0) is one authoring pass that reviewers judge. An attempt (`attempt`, from 0 within a round) is one coding task: a pausing failure or a terminated run starts a new attempt without spending a round. Coding tasks are keyed `skill-draft:<id>:<round>:<attempt>`, rounds' attempts are `skill_draft_rounds` rows on `(draft_id, round, attempt)`, and reviews are keyed on `(draft_id, round, reviewer)`.

**Sequence.** `transition_seq` increments on every transition, the claim included. Each event the draft emits carries `{ draftId, seq }` and the bus-dedup id `skill-draft-<id>-<seq>`. Each gate key is `${draftId}:${seq}`, encoded as the pipelines' 8-hex token. A re-emit after a Retry, an Override or a second block in one round therefore always has an id the bus has not seen, and a card left from an earlier park never matches.

**Each attempt is a fresh coding task.** It has a fresh CLI session seeded with the findings and starts from the previous attempt's tip with `main` merged in, so a `non_fast_forward` from another skill's deploy is resolved before authoring instead of recurring each round; the per-skill directory layout keeps that merge clean. Coding delegation gains a `baseRef` on the task for this, designed in [coding-delegation.md](coding-delegation.md) with its CHECKs and failure rows (todo.md → Skills autonomy S9). Each attempt opens its own branch and PR; the draft closes the PR an attempt supersedes, so only the latest is open.

**Admission.** The skills repo admits one coding task at a time (`maxConcurrentTasks: 1`). When admission refuses a draft's next task, the draft stays in `authoring` in its `awaiting_slot` variant, which holds the attempt's pending findings; the round row, whose coding-task reference is NOT NULL, is written once admission succeeds. The reconcile cron retries admission each tick until a slot frees, and the transitions out of `authoring` require the attempt's task to exist.

**States** — `skill_draft_status`:

| State | Meaning | Waits on |
|-|-|-|
| `specifying` | Spec drafted, card posted; the requester answers its open questions and approves it | the requester, 7 d |
| `authoring` | Round r's current attempt is writing the code on the draft branch | the coding task, within its wall time |
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
     registering(r) ──the deploy at the tip already denied──▶ abandoned
```

**Transitions.** Each is a conditional `UPDATE … WHERE id = $1 AND status = <from> AND transition_seq = <seq>` that increments `transition_seq` and `transitioned_at` and returns whether it happened ([state-machines.md](../.agents/rules/state-machines.md)); the guard's other reads share its transaction. One use-case file per transition lives under `src/skills/draft/`. **Actors:** the requester (who may be the owner) answers the spec card; the owner alone approves or denies a pending deploy and retries, overrides, extends or abandons a blocked or awaiting draft.

| Transition | Actor or trigger | Guard | Writes |
|-|-|-|-|
| insert → `specifying` | `draft_skill` (user turn) | the spec parses `SkillSpecSchema`, else the tool returns its issues and writes nothing; no open draft holds the name, read in the transaction under the partial name index's `targetWhere` | the row, `spec_version = 1`, through `ON CONFLICT (idempotency_key) DO UPDATE` with a no-op SET, the one arbiter; the key is the call's `ToolCallContext.idempotencyKey` plus a digest of the canonical spec. A recovered row with another name, or an insert losing the name index to a concurrent one (`23505`, mapped at the store edge), returns `{ kind: "name_taken"; draftId; status }`. Emit `skills/draft.parked` |
| claim (same state) | the first step of each draft function | status and seq; `state.claimedByRunId` null, this Inngest run's id, or its lease expired (`claimedAt` plus the function's maximum runtime) | `state.claimedByRunId`, `state.claimedAt`; returns `claimed`, `claimed_by_this` (a replay) or `stale` with the row's status |
| `specifying` → `specifying` (revise spec) | `draft_skill` naming a draft in `specifying`, keyed like the insert | status `specifying`; a spec whose digest equals the current one is a no-op, so a replayed call writes nothing | `spec`, `spec_version + 1`; emit `skills/draft.settled` for the old gate key and `skills/draft.parked` for the new one |
| `specifying` → `authoring` (approve spec) | the requester's Approve tap; or automatically when the spec equals the live manifest and asks nothing | status, seq from the gate key; no open questions | `round = 0`, `attempt = 0`, `state.approvedSpecVersion`; the first `coding_tasks` row (`insertOrRecoverTask`, `trigger_source = 'skill_draft'`) and its round row, one transaction, or, when admission refuses, the `awaiting_slot` variant ([Admission](#skill-lifecycle)); then emit `coding/task/start` (when admitted) and `skills/draft.settled` |
| `authoring` → `verifying` | `coding/task/pr-opened` for the current attempt's task | status, seq, the task is the current attempt's | the attempt's `tip_sha`; emit `skills/draft.verify` |
| `verifying` → `verifying` (re-verify) | `verify-code`, finding the dependency artefact gone ([Verify phases](#verify-phases)) | status, seq; the attempt's phase reset in the same transaction | `transition_seq + 1`, the claim released; emit `skills/draft.verify`, so a fresh run plans `verify-install` again; no round or attempt spent |
| `authoring` → `authoring` | `coding/task/failed` ([Coding failures](#coding-failures)), or the reconcile cron's admission retry | status, seq, the current attempt's task | a round-spending reason: `round + 1`, `attempt = 0`, the failure as a finding; a retrying one: `attempt + 1`. Both insert the next coding task and, after the commit, close the superseded attempt's PR if it opened one |
| `verifying` → `reviewing`, or → `registering` when `skills.review_panel` is off | `settle-verify`, report has no `revise` finding | status, seq | the report on the attempt row, whose `verify_phase` stays `code` for register; emit `skills/draft.review`, or `skills/draft.register` when there is no panel |
| `reviewing` → `registering` | `settle-review` | every panel member's row for round r reads `pass` | emit `skills/draft.register` |
| `registering` → `live` | `settle-register` | the deploy row it names is `live` or `rolled_back` ([Functions](#skill-lifecycle)) | `state.deployId` |
| `registering` → `blocked: registrar_unavailable` | `settle-register`, from a pausing outcome ([Functions](#skill-lifecycle)): `registrar_unavailable` (`index` or `sandbox`); `concurrent_first_deploy` ([first-deploy race](#first-deploy-race)); `pending_deploy_exists` whose pending row is not at the tip, which the owner resolves before Retry; or `resets_exhausted` ([Verify phases](#verify-phases)) | status, seq | `blocked_reason`, `state.cause` (`index`, `sandbox`, `concurrent_first_deploy`, `pending_deploy` or `resets_exhausted`), `state.resumeTo = registering`; emit `skills/draft.parked`; no round spent |
| `registering` → `awaiting_approval` | `settle-register` | the deploy row it names is `pending_approval` ([Functions](#skill-lifecycle)) | `state.deployId`; emit `skills/draft.parked` |
| `registering` → `abandoned: denied` | `settle-register` | the deploy row it names is `denied`, a deny that landed before the draft settled | `state.deployId`, `end_reason = denied`; no approval card; emit `skills/draft.settled` |
| `awaiting_approval` → `live` / `abandoned` | `skills/deploy/resolved` for `state.deployId`, emitted by `approveDeploy` and `denyDeploy` whoever calls them (owner tap, CLI); the waiter's timeout, which denies, and on `not_pending` settles from the row's status; or the reconcile cron reading the row | the row's resolution; a timeout matches its gate key | `end_reason = denied` or `approval_timeout` on `abandoned`; emit `skills/draft.settled` |
| `verifying`, `reviewing`, `registering` → `authoring` (r+1) | findings: verify `revise`, any reviewer `revise` (none `block`), or a register rejection from `RegisterRejection`'s terminal group other than `blocked` | status, seq, round r < `max_rounds` | `round + 1`, `attempt = 0`, the next coding task, carrying every finding of round r; after the commit, close round r's PR |
| any working state → `blocked: rounds_exhausted` | the same, at r = `max_rounds` | status, seq | `blocked_reason`; emit `skills/draft.parked` |
| `authoring`, `verifying`, `reviewing` → `blocked: *_unavailable` | a pausing coding failure; a verify sandbox or reviewer still unreachable after the step's retries; or a verify phase reset refused at the cap | status, seq | `blocked_reason`, `state.resumeTo`, and for `verifier_unavailable` `state.cause` (`sandbox` or `resets_exhausted`); emit `skills/draft.parked` |
| `reviewing` → `blocked: reviewer_block` | any reviewer `block` | status, seq | `blocked_reason`; emit `skills/draft.parked` |
| `registering` → `blocked: risk_blocked` | `settle-register`, from the memoized `blocked` rejection ([Risk tiers](#risk-tiers-without-a-human)) | status, seq | `blocked_reason`, the reasons on the attempt row; emit `skills/draft.parked` |
| `blocked` → `state.resumeTo` (retry) | the owner's Retry tap | reason is `*_unavailable` (including `registrar_unavailable`); seq from the gate key | `author_unavailable` inserts the next attempt's coding task; the others re-emit the resumed state's event under the new seq, with the tap's phase reset ([Verify phases](#verify-phases) → At the cap); emit `skills/draft.settled` |
| `blocked` → `registering` (override) | the owner's Override tap | reason is `reviewer_block` or `risk_blocked`, or `rounds_exhausted` with round r's verify passed and no register rejection at round r; seq | `state.overriddenBy`, which register needs to accept a `blocked` tier; from `risk_blocked`, the tap's phase reset ([Verify phases](#verify-phases) → At the cap); emit `skills/draft.register`, `skills/draft.settled` |
| `blocked: rounds_exhausted` → `authoring` (extend) | the owner's One-more-round tap | `max_rounds` < 6; seq | `max_rounds + 1`, `round + 1`, the next coding task; after the commit, close the last round's PR; emit `skills/draft.settled` |
| `awaiting_approval` → `abandoned` | the owner's Abandon tap | status, seq | denies the pending `skill_deploys` row (`denyPendingDeploy`) in the same transaction, so later registers of the skill are not refused `pending_deploy_exists`; `end_reason = user_abandoned`; emit `skills/draft.settled` |
| other non-terminal → `abandoned` | Abandon (the requester's in `specifying`, the owner's in `blocked`; the tool's or the CLI's in any state but `registering`) or the waiter's timeout in `specifying` or `blocked` | not terminal and not `registering`, where Abandon returns `not_abandonable`, so `settle-register` never meets an abandoned draft; a timeout matches its gate key's seq | `end_reason`: `user_abandoned`, `spec_timeout`, `blocked_timeout`; an abandoned working state's coding task is cancelled, and from `verifying` or `reviewing` the attempt's PR is closed after the commit; emit `skills/draft.settled` |
| any non-terminal → `failed` | a draft function's `onFailure` | not terminal, and: for a claiming function, `state.claimedByRunId` is the failing run's, so a run that lost its claim cannot fail a draft another run holds; for a non-claiming function, which cannot read its run's step results, the event names a position the draft still holds: `skill-draft-on-coding` fails it only when the event's `(round, attempt)` (which `coding/task/*` events carry for `skill_draft` tasks) equal the draft's current `round` and `attempt` and the draft is `authoring`, or, for a `coding/task/failed` event only, `blocked` at a reason that outcome writes (`author_unavailable`, `rounds_exhausted`), whose lost `skills/draft.parked` nothing re-emits; a draft it moved to `verifying` is left to the reconcile cron, and a `rounds_exhausted` written by a `settle-*` step after `pr-opened` is not its own; `-on-deploy` only when `state.deployId` is the event's and the draft is `awaiting_approval`; `-waiter` only when its gate key's seq is current. `-reconcile` never fails a draft: a failed tick is logged, and the next tick retries | `end_reason = step_error`, the error text in `state.detail` |

Transitions not in the table are illegal. A tap is honoured only from its row's actor and only while its gate key's seq is current. A transition that supersedes the current attempt (the next attempt or round, Extend) or leaves it no verify or register work (`awaiting_approval`, `live`, `abandoned`, `failed`) also moves the attempt's `verify_phase` to `done` in its transaction. A park in `blocked` keeps the phase, since Retry and Override resume into verify or register.

**Per-state data.** `state` is `SkillDraftStateSchema`, a Zod union discriminated on `status`, and a CHECK ties `state->>'status'` to the column; a `blocked` state is further discriminated on its reason, so `resumeTo` exists only on the `*_unavailable` variants, and `cause` (a Zod enum) only on `verifier_unavailable` and `registrar_unavailable`. `blocked_reason` (`skill_draft_blocked_reason`) is set iff `blocked`; `end_reason` (`skill_draft_end_reason`: `user_abandoned`, `spec_timeout`, `blocked_timeout`, `approval_timeout`, `denied`, `step_error`) iff `abandoned` or `failed`. `spec` changes only in `specifying`; after approval `state.approvedSpecVersion` names the version every later check reads, and the spec card that version rendered is stored on the row.

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
| `skill-draft-review` | `skills/draft.review` | `claim`, one `review-<reviewer>` step per panel member in parallel, then `settle-review` reading the review rows, since code after a parallel group runs only in fully memoized invocations. Four steps, so the body runs up to five times; each reviewer step makes at most three model calls (the verdict plus two malformed-verdict retries), and each Inngest retry of the step repeats them |
| `skill-draft-register` | `skills/draft.register` | `claim`, `register`, `settle-register`. The skill's **deploy at the tip** is its newest `skill_deploys` row whose `git_sha` is the tip, unless that row is `blocked`, which an Override is past. The `register` step reads it first: one there means an earlier attempt of the step, or a CLI register of the same sha, committed it, so the step returns it without calling register, compiling nothing and moving no phase. Otherwise it re-enters from the attempt's phase ([Verify phases](#verify-phases)) and returns `RegisterStepResult`: `{ kind: "deployed"; deployId }`, `{ kind: "registered"; result: RegisterResult }` or `{ kind: "resets_exhausted" }`. Register never returns the approve- and rollback-only rejections (`deploy_not_found`, `deploy_not_pending`, `skill_not_found`, `main_moved`), so the step's rejection type excludes them; one occurring is an invariant violation that fails the run. `settle-register` matches the result exhaustively. `deployed`; a `live`, `pending_approval` or `no_op` result; and `pending_deploy_exists` whose pending row is at the tip each name one deploy row: the step's id, register's `pendingId`, or else the deploy at the tip. For `no_op` that row exists: register returns `no_op` only for an enabled skill at the tip, and an enabled skill's sha has a `live` row there (the enable guard) or a `rolled_back` one (rollback enables at its target without the guard). `settle-register` reads the row by id and settles from its status now: `live` → `live`; `rolled_back` → `live`, since the tip's code is live by the owner's rollback; `pending_approval` → `awaiting_approval`; `denied` → `abandoned: denied`. A `blocked` row, or no row, is an invariant violation that fails the run. A rollback or deregister landing between `register` and `settle-register` leaves the row as it was, so the draft settles from it. **Residual:** the draft can report `live` for code the owner has since rolled back or deregistered, which matches `live`'s meaning in the Deploy lifecycle: the deploy went live, not that it is current. `pending_deploy_exists` elsewhere, the other pausing rejections and `resets_exhausted` park at `registrar_unavailable`; the remaining rejections, `blocked` included, settle from the memoized value |
| `skill-draft-on-deploy` | `skills/deploy/resolved` | one step: `awaiting_approval` → `live` or `abandoned` for the draft whose `state.deployId` it names |
| `skill-draft-waiter` | `skills/draft.parked` `{ draftId, gateKey, boundMs }` | `idempotency: gateKey`; sleeps out the bound with two reminders, then emits the timeout carrying its gate key; `cancelOn` `skills/draft.settled` matched on `data.gateKey`, as `pipeline-gate-waiter` does |
| `skill-draft-reconcile` | cron, every 10 min | for a working state older than 30 min (`transitioned_at`) it re-emits the owed event under the current seq. For `awaiting_approval` it reads the deploy row and settles a resolved one. For `authoring` it reads the attempt's coding task: `queued`, re-emit `coding/task/start`; `pr_open` or `failed`, apply that outcome as `skill-draft-on-coding` would; running past its wall time, nothing, since coding delegation's own reconciliation ends it |

**Failure modes.**

| Failure mode | State left | Why it is safe, or the residual |
|-|-|-|
| The approve-spec transaction commits, the `coding/task/start` emit is lost | `authoring`, its coding task `queued` | the reconcile cron re-emits; a second tap carries a stale seq and is refused. The bus id and the task's `queued → planning` guard collapse duplicates |
| A coding task's outcome event is lost | `authoring` | the reconcile cron reads the task and applies its outcome |
| A coding task fails | per [Coding failures](#coding-failures) | a pausing or transient failure never spends a round, and a retry gets a fresh coding-task key, so it never recovers the failed task |
| `pr-opened` delivered twice, or after the draft moved | unchanged | the transition's guard on status, seq and the current attempt's task reads `stale` |
| A function retry, or a duplicate event, re-runs a claim | unchanged | the claim returns `claimed_by_this` for its own run and `stale` for another's, so a duplicate does no work |
| `verify-install`, `verify-code` or `register` crashes before Inngest records it | `verifying` or `registering` | the step re-enters from the attempt's phase ([Verify phases](#verify-phases) → failure modes). A repeat costs one more sandbox session; steps reset at most twice per attempt before the draft parks |
| The install credential leaks into skill code (left in the session's environment or a file) | `verifying` or `registering` | the proxy admits it only at the phase and generation it names, and both move before any skill code runs ([Verify phases](#verify-phases)) |
| A reviewer step bills its model, then crashes before recording | `reviewing` | the retry bills once more; the review row (unique on draft, round, reviewer, `ON CONFLICT DO UPDATE` with a no-op SET) keeps the first verdict that committed. **Residual:** one re-billed review per crash |
| A reviewer stays unreachable or returns a malformed verdict after retries | `blocked: reviewer_unavailable` | never a pass on a partial panel; Retry resumes `reviewing` under a new seq and re-runs only the missing member, whose row is absent |
| `register` commits, then the step result is lost | `registering` | the retry's `register` step returns the deploy at the tip without calling register ([Functions](#skill-lifecycle)), and `settle-register` reads it |
| A CLI `register` of the draft's exact tip lands first (live, pending or denied) | once the draft reaches `registering`, it settles from that deploy | the `register` step's read is keyed on the sha, not the draft, so it adopts the row as its own ([Functions](#skill-lifecycle)): `live`, `awaiting_approval` or `abandoned: denied`. **Residual:** the draft takes an outcome it did not request, which is the owner's decision on that exact code. Before register, verify and review still judge the tip, so a draft in `verifying` or `reviewing` can end in `revise` or `reviewer_block` while the CLI has that code live |
| Two first deploys of one name race on `skills.name` | `registering`, or `blocked: registrar_unavailable` | the [first-deploy race](#first-deploy-race): one in-process retry, then a park without spending a round |
| Register rejects the tip (validation, lockfile, spec drift, `non_fast_forward`) | `authoring` at r+1, or `blocked: rounds_exhausted` | the rejection becomes a finding, so the author fixes what the floor refused. Each attempt merges `main` before authoring, so a `non_fast_forward` recurs only when another skill deploys between that merge and register. **Residual:** that window costs a round |
| Rounds run out | `blocked: rounds_exhausted` | the cap bounds cost; Extend grants one round at a time up to 6, Override registers only a tip that passed verify and that register has not refused (the override row) |
| `cogmo skills approve` or `deny` resolves the draft's pending deploy outside the draft | `live` or `abandoned` | both emit `skills/deploy/resolved`, which the draft follows like a tap |
| `cogmo skills rollback`, `deregister` or a CLI `register` of the same skill while a draft is open | the draft's state | the draft's register meets the moved state as a rejection (`non_fast_forward`, or a base that is not the live sha) and turns it into a finding; a pending deploy the CLI left at another sha parks the draft at `blocked: registrar_unavailable` (`pending_deploy`) until the owner resolves it and taps Retry |
| A cron fire of the skill while a revision is in flight | the live version runs | a draft writes nothing to `skills` until register; each run records the `git_sha` it ran |
| Abandon commits, the coding-task cancel it emits is lost | `abandoned`; the task runs on | when the task opens its PR, `skill-draft-on-coding` finds the draft terminal and closes the PR. **Residual:** the task's tokens are spent |
| The coding task finishes between Abandon's read and its commit | `abandoned`; the outcome event arrives after | the outcome's transition guard reads `stale`; a PR it opened is closed as above |
| `approveDeploy` or `denyDeploy` commits outside Inngest and its `skills/deploy/resolved` emit is lost; or the resolution commits after `settle-register` read the row `pending_approval`, and its event arrives while the draft is still `registering`, so `-on-deploy` reads it as stale | `awaiting_approval` | the reconcile cron reads the deploy row and settles the draft within one tick; the waiter's timeout does the same if it fires first |
| A claim holder is cancelled or its process dies | the working state, claimed | after the lease (`claimedAt` plus the function's maximum runtime), the reconcile cron's re-emit lets a new run claim it |
| A waiter from an earlier park wakes | unchanged | its gate key's seq is stale, so the timeout transition matches no row; `skills/draft.settled` normally cancelled it first |
| A run in flight across a deploy that changes these functions | each step replays its stored result | new data rides new steps reading committed rows, never an earlier step's return value |
| Two taps, or a tap and a timeout, on one gate | one transition wins | conditional UPDATE on seq; the loser reads `stale` and is told only if its decision did not stand |
| `draft_skill` re-run by Inngest after its commit | the same row | the key (the call's key plus the spec digest) recovers it through the one `ON CONFLICT` arbiter |
| Two `draft_skill` calls for one name at once | one row | the loser trips the partial name index (`23505`), which the store returns as `name_taken` |
| A skills-repo coding task started before the draft machine shipped reaches `pr-opened` | no draft row | the subscriber registers it as the auto-register subscriber does today, for one release, then the path is removed |
| The requester has no reachable channel for the card | `specifying` | it times out to `abandoned: spec_timeout`; `cogmo skills drafts` lists it meanwhile |
| A draft function fails after its retries | `failed: step_error` | reported to the requester with the error; a new draft can start, since the name is free again |
| `skill-draft-on-coding`'s emit step fails after its `authoring → verifying` committed | `verifying` | its `onFailure` leaves a `verifying` draft alone; the reconcile cron re-emits `skills/draft.verify` |
| `skill-draft-on-coding`'s emit step fails after it parked the draft | `failed: step_error` | its `onFailure` fails a draft it parked at the event's position, since no waiter started and nothing re-emits `skills/draft.parked` |
| A claiming function's `skills/draft.parked` emit fails after its retries (the event API unreachable throughout) | the parked state, no waiter | the park released the claim, so `onFailure` cannot fail the draft. **Residual:** no reminders or timeout; `cogmo skills drafts` lists it, and Abandon from the tool or the CLI ends it |

**Cost bounds.** A draft spends at most `max_rounds + 1` rounds (default 3 + 1, ceiling 6 + 1 with Extend), each of at most four coding tasks under the skills repo's `taskTokenBudget`, though only the round-spending first is normal. Each round makes at most two reviews of up to three model calls each, plus Inngest step retries. Each attempt's verify takes two sandbox sessions, and each phase reset one or two more; steps reset at most twice per attempt, and every reset past that is an owner's tap. Nothing loops without a round or an attempt, and every wait is bounded.

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
| Owned paths | the branch changes only `skills/<name>/` (`SKILL.md`, `skill.py`, `requirements.lock`, `test_skill.py`) for the draft's own skill | toolchain files and other skills are not the author's |
| Syntax | `python -I -m py_compile`; a tree-sitter `ERROR` node also fails | — |
| Entrypoint | AST: `async def run(inputs: Input, ctx: Ctx) -> Output` at module level | typed `run` |
| Contracts | AST: `Input` and `Output` subclass `pydantic.BaseModel`; their JSON Schemas generate in the tier's runtime and match the spec | pydantic contracts |
| Types and lint | `pyrefly check` against the `cogmo_ctx` stubs; `ruff check` with `E`, `F`, `B`, `BLE`, `S` (the flake8-bandit port, which stands in for bandit), `ASYNC` | failures as values: no bare or swallowing `except`, `SkillError` for expected failures |
| Imports | each import root is stdlib, `pydantic`, `cogmo_ctx`, or a module a declared dependency's wheel installs (from its `RECORD`, read at lockfile compile) | dependencies declared for every import |
| Dynamic code | AST: `exec`, `eval`, `compile`, `__import__`, `importlib.import_module` or `getattr` on a module with a non-literal name | no code built at runtime |
| Tier-1 bridges | `wasm-lint` rows for `js`, `pyodide_js`, `pyodide.ffi`, `pyodide.code`, `pyodide.http`, `micropip` | tier 1 reaches the host only through `ctx` |
| Effects, hosts, secrets | the AST rules plus rows for `ctx.memory.*`, `ctx.files.*`, a non-GET `ctx.http`, literal `ctx.secrets.get` names and literal URL hosts, checked against the spec | the manifest says what the code does |
| Idempotency | a non-GET request without an `Idempotency-Key` from `ctx.run().key` is a `note` | external writes keyed |
| Tests | `pytest -q` passes `test_skill.py`, which has a test per spec example | tests for the examples |
| Sample call | each spec example runs through `run` in the skill's own tier runtime, with a recording `ctx`: reads return empty or fixture values, writes and egress are recorded, not performed; the output validates against `Output` and survives `json.dumps(allow_nan=False)` | output is the contract |
| Observed effects | the sample call's recorded hosts, secrets and writes are within the spec | — |
| Size | `skill.py` at most 400 lines | reviewers lose recall on large diffs, so skills stay small |
| Register dry run | `prepareRegister` without the write: manifest, ajv, lockfile compile, Pyodide compatibility | register's floor, met before review |

Static checks and `pytest` run under CPython in short-lived `cogmo-skills` sandbox sessions, one per verify step ([Verify phases](#verify-phases)), from a tools virtualenv (`/opt/cogmo-skills/tools`: ruff, pyrefly, pytest) outside the task's `sys.path`. The session's egress comes in two phases ([Egress proxy](#egress-proxy-proposed)). An install credential reaches the package index for the lockfile compile and the dependency install. It is revoked, by moving the attempt's `verify_phase` from `install` to `code`, before any skill code runs. A code credential then serves the schema import, the tests and the sample call: the spec's hosts are answered in shadow, and everything else is denied. A tier-1 skill's sample call runs in the hardened Pyodide child ([Tier-1 boundary](#tier-1-boundary-proposed)). A tier-2 skill's sample call and `pytest` run only once tier-2 workers sit behind the proxy, with every request answered in shadow and none forwarded; until then a tier-2 skill gets the static checks only.

**Per backend.** `pytest` and a tier-2 sample call need the dependencies `verify-install` populated, which `verify-code`'s session reaches only on a `shared-volume` backend ([Cache layout](#cache-layout)). On a `per-sandbox` backend (Daytona) the venv is discarded with `verify-install`'s session, so neither runs there. The verify stage there is the static checks, plus a tier-1 skill's sample call, which reads the host's wheel directory. pyrefly there types a declared dependency's imports as `Any`, and a tier-2 skill's schema generation falls to register, which compiles, installs and imports in one session ([Contracts](#contracts-proposed)).

The report is `SkillVerifyReportSchema` on the round row: per check, its status and findings, plus the sample call's trace, which the reviewers and the notification read.

#### Verify phases

`verify-install` and `verify-code` are separate steps in separate sandbox sessions, so the install's output must be durable. `verify-install` populates the dependencies keyed by the lockfile hash: the `<hash>-py<X.Y>` venv under the existing `/skill-venvs` layout ([Populate](#populate)) for tier 2, the tier-1 wheel directory for wasm. It records that hash on the attempt row as `deps_hash`. `verify-code` installs offline from it. On a `per-sandbox` backend a tier-2 venv does not outlive `verify-install`'s session, so for a tier-2 skill there `verify-code` installs nothing and looks for no artefact, and no reset arises ([Verify stage](#verify-stage) → Per backend).

`skill_draft_rounds.verify_phase` (`skill_verify_phase`) decides which verify credential the proxy admits, and `verify_resets` is its generation. Each credential names both, so a reset back to an install phase leaves every earlier credential refused ([Egress proxy](#egress-proxy-proposed) → credential classes). Each transition is a conditional UPDATE on the attempt row:

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
| `install` → `code` | `verify-install`, after the populate | `verify_phase = 'install' AND verify_resets = $gen`, the draft `verifying` at this attempt | `verify_phase`, `deps_hash`; the install credential is refused from here on |
| `code` → `install` (reset) | a `verify-install` or `verify-code` run that finds no artefact for `deps_hash` (swept, or the volume lost); an owner's tap (At the cap, below) | `verify_phase = 'code' AND verify_resets = $gen`; a step also matches `deps_hash = $hash` and needs `verify_resets < 2` | `verify_phase`, `deps_hash` null, `verify_resets + 1` |
| `code` → `register_install` | `skill-draft-register`'s `register`, when it reaches the lockfile compile | `verify_phase = 'code' AND verify_resets = $gen`, the draft `registering` at this attempt | `verify_phase`: the compile reaches the index again |
| `register_install` → `register_code` | `register`, before the schema import | `verify_phase = 'register_install' AND verify_resets = $gen`, the draft `registering` at this attempt | `verify_phase` |
| `register_code` → `register_install` (reset) | a `register` run that reaches the compile with the attempt at `register_code`; an owner's tap (At the cap, below) | `verify_phase = 'register_code' AND verify_resets = $gen`, the draft `registering` (or, for a tap, `blocked`) at this attempt; a step also needs `verify_resets < 2` | `verify_phase`, `verify_resets + 1` |
| any → `done` | a draft transition that supersedes the attempt or leaves it no verify or register work ([Skill lifecycle](#skill-lifecycle), after the transitions) | that transition, in its transaction | `verify_phase` |

**Re-entry.** A step can crash after its UPDATE commits and before Inngest records it, so each step re-enters from the phase it finds:

- **`verify-install`** at `install` populates and moves; the populate is idempotent on `.ready`. At `code` it does nothing when the artefact for `deps_hash` is present, or when there is none to look for (a tier-2 skill on a `per-sandbox` backend). Otherwise it resets and installs again in the same step, under the new generation's credential.
- **`verify-code`** at `code` proceeds when the artefact is present. When it is not, the reset commits with the draft's `verifying → verifying` transition, which takes a new seq and emits `skills/draft.verify`, and the run ends. This run has `verify-install` memoized, so only a fresh run can install again; it plans `verify-install` from the start.
- **`register`** at `register_install` (a retry after its move, before the next) finds its `code` move matching no row and takes the phase as its own. The install credential of this phase and generation is still admitted, so it compiles again; the install is a no-op when the tip's lockfile hashes to `deps_hash` and that artefact is present. At `register_code`, skill code may already have run in the session the lost attempt held, so register resets and compiles under the new generation's credential. A `register` step that finds the deploy at the tip ([Functions](#skill-lifecycle)) returns before any of this.
- **At the cap** (`verify_resets = 2`) a step's reset is refused and the working state parks with `state.cause = resets_exhausted`. A verify step commits `verifying → blocked: verifier_unavailable` in its own transaction and returns `{ kind: "parked" }`; an emit step for `skills/draft.parked` follows and the run ends. The `register` step returns `resets_exhausted` without calling register, and `settle-register` parks `registering → blocked: registrar_unavailable` from it. The owner's Retry from `verifier_unavailable` with the attempt at `code`, or from `registrar_unavailable` or Override from `risk_blocked` with it at `register_code`, performs that phase's reset in its own transaction, uncapped. A resumed run therefore starts with a fresh install credential instead of re-entering the state it parked in; past the cap, each further reset takes a tap.

A draftless register has no attempt row and moves through `register_install` and `register_code` in-process ([Egress proxy](#egress-proxy-proposed) → credential classes).

| Failure mode | Phase left | Why it is safe, or the residual |
|-|-|-|
| `verify-install` crashes after the populate, before its move | `install` | the re-run's populate finds `.ready`; the move follows |
| `verify-install` or `verify-code` crashes after its UPDATE, before Inngest records it | the moved phase | a no-op re-entry when the artefact is there, a reset when it is not |
| The artefact is swept, or the volume lost, before `verify-code` | `install` at the next generation | the reset and a fresh verify run under a new seq; no round or attempt spent |
| The reset commits, its `skills/draft.verify` emit is lost | `install`; the draft `verifying` at the new seq | the reconcile cron re-emits the owed event under the current seq |
| The artefact keeps disappearing | `code`; the draft `blocked: verifier_unavailable` | two resets per attempt, then each further one is the owner's tap |
| `register` crashes after a phase move, before Inngest records it | `register_install` or `register_code` | `register_install` re-enters as its own move; `register_code` resets |
| `register` commits the deploy, then its result is lost | `register_code` | the retry moves nothing ([Functions](#skill-lifecycle)); `settle-register` writes `done` |
| Override of `risk_blocked` | `register_install` at the next generation | the tap's reset; register's re-run proceeds there |
| An install credential leaks into skill code (left in the session's environment or a file) | any | it is admitted only at the phase and generation it names, with the draft in the matching state. Skill code runs only after the move out of that phase, and a reset back moves the generation, so the leaked token is never admitted again |
| Two verify or register runs of one draft at once | unchanged | concurrency 1 per draft, and the claim |

**The skills repo toolchain.** Bootstrap writes Cogmo-owned files to the repo root: `pyproject.toml` (Python 3.14, a `dev` group pinning the tools virtualenv's versions, ruff and pyrefly configuration), `CLAUDE.md` (the authoring convention, generated from `SkillManifestSchema` and `SKILL_EFFECTS` so it cannot drift from them), `cogmo_ctx/` stubs ([Contracts](#contracts-proposed)) and `skill.schema.json`. A Cogmo release that changes them commits them to `main` through `advanceMain` at boot, under the bootstrap lock, deploying no skill. The repo's `verifyCommand` is `uv run --locked --group dev scripts/verify`, which runs ruff, pyrefly and pytest inside the coding task so the author sees failures in its own session; Cogmo's verify stage is still the authority, since the author can edit nothing it runs.

### Review stage

Read-only reviewer agents replace the human approval tap. A panel reviews every round that passed verify:

- **The author's model**, in a fresh session with no access to the author's;
- **a model of the other family.** Drafts are Claude-authored only today (the skills repo's `allowedBackends` is `["claude"]`), so Codex reviews them; Claude reviewing a Codex author is the future case. The author's family never reviews alone.

`SkillReviewer` is the interface (`review(input, signal): Promise<Result<SkillReviewVerdict, SkillReviewerError>>`), with a Claude Code backend (`claude -p --permission-mode plan`) and a Codex backend (`codex exec --sandbox read-only`), each in a read-only sandbox holding the draft branch, so a reviewer reads the repo, not just the diff. Tests run once, in the verify session, and reach reviewers as the report and trace. A review session has a 100k-token budget and a 10-minute wall clock; exceeding either is `unavailable`. Its input: the approved spec card, the diff against the base, the verify report and trace, `classifier_log`, the previous rounds' findings, and the checklist.

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

**Measured, not trusted.** A seeded-bug suite holds skills each carrying one defect class — an undeclared host, a secret in the output, a memory read posted out, a missing idempotency key, dynamic code, swallowed failures, an unbounded loop, an input the spec lacks — and clean controls, a third of the cases. Every reviewer backend runs over it, and each must reach the expected severity on at least 80% of seeded cases and the panel on 90%, with no `block` and at most 20% `revise` on controls. The suite is a production job, not a `.live.test.ts`. Its fixtures ship in the image, and `skill-review-calibration` runs it inside the deployment: weekly, and at boot when the checklist, a reviewer prompt, a reviewer model or a CLI version differs from the last run's. The `skills.review_panel` flag:

- **At boot**, when anything the suite depends on differs from the row's `calibration_inputs`, the flag is cleared (`recalibration_pending`) before the job runs; with no Codex backend configured it is cleared as `no_second_family`.
- **Only a passing run sets it.** A run below the floor leaves it cleared (`calibration_failed`) and notifies the owner.
- **A missing row means the panel is off.**

A run costs at most the suite's size (30 cases) times two reviewers times three model calls.

**Without a panel.** When no Codex backend is configured, or the seeded-bug floor fails, `reviewPanel` is off: `reviewing` is skipped (the draft goes `verifying → registering`), and today's tier table applies with `auto` capped to `notify`. The owner is told once at boot, or when the suite clears the flag.

### Risk tiers without a human

`computeRiskTier` returns one of `auto`, `notify`, `approve`, `blocked`, plus the reasons (`SkillRiskReason[]`) that put it there, recorded in `classifier_log` and shown in every notification. Its inputs are the classifier log, the deployment's enforcement capabilities, and one owner setting.

| Tier | Effect at register |
|-|-|
| `auto` | Live; no message. Listed in `/skills` and the activity view. |
| `notify` | Live; a notification with undo. |
| `approve` | Pending until the owner taps Approve. Only for what the owner opted into. |
| `blocked` | Not deployed; a notification with the reasons and one-tap Override, which registers with `approved_by` set to the owner. |

`approve` is opt-in per class: the `skill_approval_classes` rows, one per class the owner opts into from `SKILL_EFFECTS` plus `raw_secret`, `reads_and_egress` and `sensitive_dependency`; none by default.

Rules, first match wins:

1. **Rejected**, no tier: validation errors, as today.
2. **`blocked`**: the manifest needs enforcement this deployment lacks — a bound secret before the proxy substitutes, or a `network:` block on a tier-2 backend without the egress proxy's network. Register returns the `blocked` rejection and writes a terminal `blocked` deploy row (Deploy lifecycle). The rule exists only with `reviewPanel`, so `blocked` is unreachable until the review stage ships.
3. **`approve`**: a declared or detected effect, or a reason, in `skill_approval_classes`.
4. **`auto`**, when all hold: an edit whose manifest does not widen the live one (a first deploy always notifies); the tier's boundary is enforced (tier 1 hardened; tier 2 behind the proxy network); no write, send, delete, financial or subprocess effect; every secret bound; no read effect alongside `network:`; every dependency on the allowlist; `cost_per_call_usd = 0`.
5. **`notify`**: everything else, each reason listed. A raw secret (`raw_secret`) lands here at most, never `auto`: its plaintext is in the skill's memory, so it can leave through any allowed host, a memory write or the output, and no check sees the value. A read effect with `network:` (`reads_and_egress`) is the same pairing as a raw secret with egress.

The classifier reads capabilities as flags (`tier1Hardened`, `tier2EgressEnforced`, `bindingsSubstituted`, `reviewPanel`), never by inspecting the build, so the tier follows what is enforced while the pieces ship in order. Without `reviewPanel`, `reviewing` is skipped and rules 2–5 give way to today's table ([Risk tiering & auto-apply](#risk-tiering--auto-apply-confirmed)) with `auto` capped to `notify`, since no reviewer stands in for the tap. `tier1Hardened`, `tier2EgressEnforced` and `bindingsSubstituted` are properties of the build; `reviewPanel` is the `skills.review_panel` row of `deployment_flags`.

### Notifications and undo

One use case (`announceDeployOutcome`) serves every register caller and emits `skills/deploy/outcome` with `{ skillId, deployId, outcome, riskTier, reasons, conversationId }`; the transport renders it in the requester's conversation, or the owner's when there is none.

| Outcome | Message | Buttons |
|-|-|-|
| `live`, `notify` | `skill X is live` (new, or `abc1234 → def5678`), the description, the reasons, effects (declared and detected), hosts, secrets (bound or raw), dependencies, schedule and run-as, verify and panel verdicts with the round | Disable; Roll back for an edit, a forward commit restoring the skill's directory (Deploy lifecycle); Details |
| `pending_approval` | the same, and the opted-in class that holds it | Approve, Deny |
| `blocked` | the same, and the reasons | Override and Abandon, the owner's |
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
- **`/rollback <skill>`** — back to the prior deploy's version (Deploy lifecycle).
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

See [Run failures](#run-failures): the `error_kind` class decides retry, notification and auto-disable.

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
| `ctx.http.request(method, url, ...)` | Outbound HTTP performed by the host; `get` / `post` wrap it. Tier 1's only network path — Pyodide has no sockets, so `httpx` and `requests` cannot run there. Present in tier 2 as well, so a skill does not break when adding a dependency moves it across the boundary; tier 2 may use `httpx` directly instead. Returns `{status, headers, body}`; a 4xx/5xx is a value, not an exception. Every destination must appear in the manifest's `network.allow` list, checked on the hostname ahead of resolution — a skill with no `network:` block reaches nothing. `http`/`https` only, capped at 5 MiB, and timed out under the skill's own `wall_clock_s` so a hung request stays catchable. Redirects are not followed — the 3xx comes back with its `location` so the next hop is a fresh, separately-checked call. Destinations resolving to a non-public address are refused (`isBlockedAddress` in `src/util/blocked-address.ts`, shared with `fetch_url`): `fetch` runs in the host process, so without it a skill would reach internal services (Hindsight takes no auth) that a tier-2 sandbox cannot see. Residual: `fetch` resolves the name again, so DNS rebinding between the check and the connection is open until connections are pinned to the checked address. Audited to `skill_context_calls` by origin and path, never the query string. The [Egress proxy](#egress-proxy-proposed) listener takes over the allowlist, the address guard, pinning and the audit, and its `skill_egress` row replaces the `http.request` context-call row. |

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

**Stage 1 — declared egress, default deny.** A `network:` block in `SKILL.md` names the hosts a skill may reach; absent the block, `ctx.http` refuses every destination, so a skill opts into the internet per host rather than out of it. Entries are hostnames, optionally prefixed `*.` for subdomains — `*.example.com` admits any host under that zone, `a.b.example.com` as readily as `api.example.com`, but not the apex, which needs its own entry — and a lone `*` does not parse. Depth is deliberate: CDN and bucket hosts are routinely several labels deep, and a single-label rule would push authors toward listing a bare apex, which is broader. A wildcard over a zone carrying third-party sub-labels admits those too, which is a property of sharing the zone rather than of the depth, and a reason to name hosts exactly where the zone is shared. Matching happens on the hostname ahead of resolution, so a destination the manifest never named does not even become a DNS query; the address guard then runs on what a permitted name resolves to, which is a separate question and refuses a declared host pointing inward.

This is the load-bearing control, because exfiltration requires reaching a destination the attacker chose. An allowlist bounds where a credential can travel even while the skill still holds it in plaintext, which is why the proxy enforces it for both tiers before it substitutes anything.

#### Egress proxy `[proposed]`

One enforcement point for every byte a skill sends off the machine: a token-injecting forward proxy inside `cogmo serve` (`src/skills/egress/`). Placeholder minting is the primitive it shares with `ctx.secrets.get`. It carries stages 2 and 3: allowlist, pinning, substitution, token exchange and audit live here, for both tiers.

**One path.**

- Tier-2 workers run on an internal Docker network (`Internal: true`): no default route, and the only reachable address is the proxy's listener on that network. That is the enforcement, so there is no `iptables` and nothing to bypass by unsetting a variable. `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` are set for convenience. Verify sessions join the same network under the two verify credentials (below).
- `ctx.http`, which the host performs for tier 1 and for tier 2's RPC, is a forward-proxy client of the same listener: a plain absolute-URL request carrying the run's credential, forwarded upstream under the scheme the call named, so the client needs no trust in the Cogmo CA. Allowlist, pinning, substitution, shadow and audit have one implementation, and the proxy writes the call's `skill_egress` row; `ctx.http` writes no `skill_context_calls` row for it. The client keeps its per-call rules: the response shape, the 5 MiB cap, the timeout, `redirect: manual`, and the mapping of the proxy's own replies to `CtxErrorKind`, by the reason in the `x-cogmo-egress` header every synthesised reply carries: `shadowed` is a value, returned as `{status, headers, body}`; `host_not_allowed`, `blocked_address` and `not_http` raise `blocked_destination`; `too_large` on a request raises `request_too_large`, added to `CtxErrorKind`; `credential_revoked` raises `network_error`. A connection the tunnel cuts reaches the client as a reset, `network_error`, unless the client's own decoded-body cap or timeout fired first.
- Dependency populate, the lockfile compile and the verify session reach the package index through the proxy under their own credential classes (below).
- mockttp binds every interface. When `cogmo serve` runs in a container that is the internal network and the compose network, with nothing published; on the host it is every interface, reachable from the LAN and the tailnet. **Residual** for the host case: the credential check refuses every request, but an unauthenticated client can complete handshakes, have the proxy mint a leaf certificate for each name it sends (mockttp's certificate cache is an unbounded map, so each name costs memory and a signing), and hold up to the request cap in memory per connection until the `407`, with no bound on connections. todo.md → Skills autonomy S7 confirms the host case under rootless and rootful Docker and asks mockttp upstream for a bind address.
- Non-HTTP protocols have no route (failure modes below; [Open questions](#open-questions)).
- Tier 2 runs on local Docker only ([Warm pool](#warm-pool-confirmed)). A managed backend Cogmo cannot attach to an internal network has no egress control, so the classifier reads `tier2EgressEnforced = false` there: bound secrets are unavailable and a `network:` block is `blocked`, until the provider offers an egress hook the proxy can sit behind.

**Per-run identity.** No credential, no egress.

- The credential is `<class>.<runId>.<mac>`, where `mac` is HMAC-SHA256 of the class and the run id under a key derived from the master key (HKDF, purpose `skill-egress`, [infrastructure.md](infrastructure.md)). The rules parse the class to pick a rule; admission verifies the MAC for the class claimed. It derives from the durable `skill_runs` row, so nothing stores it and a restarted proxy needs no map.
- The relay puts it in the task process's environment and proxy URL, never in the container's. The URL is mockttp's metadata form, `http://metadata:<base64url({"tags":["<credential>"]})>@<proxy>`, which httpx and requests send as `Proxy-Authorization` on each `CONNECT`, and on each plain-`http` request (Implementation, below). A pool worker's next task gets the next run's credential.
- Each request is admitted only while its run is `recovery_point = 'started'`. The proxy then loads the run's skill at the run's `git_sha` for its allowlist and bindings. `transitionToExecuted` revokes the credential by moving the row, and the proxy refuses the run's next request; a request already in flight ends at the tunnel's class timeout, or sooner when its client socket closes. Admission is cached per class: a `run` or `populate` admission until the run's deadline, invalidated in-process by `transitionToExecuted` and the sweeper; a verify-class admission never, so every verify request re-reads its attempt's phase in one indexed read.
- A new run means a new credential. The task process can read its own credential; that is the trade for pool workers that need no per-task network setup, and it is bounded because a credential opens only its own run's allowlist, and only while the run is in flight.

**Credential classes.**

| Class | Derived from | Admitted while | Allowlist | Limits |
|-|-|-|-|-|
| `run` | the run id | the run is at `started` | the skill's `network.allow` at the run's `git_sha` | 5 MiB + 64 KiB per response and 130 s per connection, enforced by the tunnel as the backstop behind `ctx.http`'s 5 MiB decoded-body cap and 120 s timeout, which fire first |
| `populate` | the run id, purpose `populate` | the run is at `started` | the configured package index hosts | 512 MiB per response, 10 min, enforced by the tunnel |
| `verify_install` | the draft id, round, attempt, phase and generation (`verify_resets`); for a register outside a draft, the skill name, tip sha and phase, with an expiry in the token | the attempt is at the token's phase and generation: `install` with the draft `verifying` at that attempt, or `register_install` with it `registering`; for a draftless register, until the register call revokes it in-process before the import, or its 10-minute expiry. **Residual:** a restart forgets the in-process revocation, so the token is live again until it expires | the configured package index hosts, forwarded | 512 MiB per response, 10 min, enforced by the tunnel |
| `verify_code` | as `verify_install` | the attempt is at the token's phase and generation: `code` with the draft `verifying`, or `register_code` with it `registering`; for a draftless register, until its expiry | the spec's hosts (a draftless register: the manifest's), answered in shadow and never forwarded; nothing else | none: nothing is forwarded |

**TLS.** The proxy terminates TLS for `CONNECT` with a Cogmo CA, minted by setup (`generateCACertificate`), kept in the secrets store, handed to mockttp as its `https` key and certificate, and rotated by `cogmo skills rotate-egress-ca`.

- The skills image is public, so the CA cannot be baked into it. Each worker gets the system bundle plus the CA as a read-only mount, with `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE` pointing at it, which httpx and requests both honour.
- mockttp mints a leaf certificate per host on first use and caches it in memory.
- Upstream, the proxy sends the hostname as SNI and verifies the destination's real certificate against that hostname and Node's root store.
- A client that pins its own CA fails closed, as it should.

**Implementation.** [mockttp](https://github.com/httptoolkit/mockttp), the intercepting engine behind HTTP Toolkit, runs in-process. It owns the wire: leaf certificates under the Cogmo CA, `CONNECT`, TLS on both sides, HTTP/1.1 and chunked bodies. Cogmo owns the policy and the upstream connection, in TypeScript against its own stores, split as the Docker API proxy is ([sandbox.md → Proxy Design](sandbox.md#proxy-design)):

- **One passthrough rule per credential class**, matched on the class the credential names and marked `always()`, then a last rule that answers `407`. Each class rule's `beforeRequest` calls a pure policy function of the request and the admission state and returns either the request to forward (placeholders substituted, `Connection: close` added so one upstream connection carries one request, which mockttp keeps per downstream connection and never shares across credentials) or a reply sent without forwarding: `407`, `403`, `413`, a shadow reply, each with an `x-cogmo-egress` header naming its reason. No rule sets a response hook, so every response streams to the client. mockttp buffers a copy of each request body for its matchers and hooks, and of each response body for its events, up to `maxBodySize`, which is set to the request cap (5 MiB); a request whose declared length exceeds the cap, or whose buffer is empty under a `content-length` or `transfer-encoding` that announced a body, is refused `413` as `too_large`, never forwarded. No WebSocket rule exists, so mockttp refuses an upgrade with `503`; `http2` is off, so the listener speaks HTTP/1.1; `passthrough` and `tlsPassthrough` stay unset, so an unknown protocol on the listener is refused; `recordTraffic` is off.
- **The pin tunnel.** mockttp never resolves a destination. Each class rule names, as its upstream proxy (`proxyConfig.proxyUrl`), an in-process `CONNECT` server on loopback, with the class as the URL's user name and a per-boot random token as its password; a `CONNECT` without the token is refused, so no other local process can use the tunnel. For each `CONNECT host:port` the tunnel resolves the host with `dns.promises.resolve4` and `resolve6` (the resolver, not `getaddrinfo`: no threadpool, no `/etc/hosts`), requires every address to pass `isBlockedAddress` (an IP literal is checked as itself), connects to one of them, and pipes bytes while counting them in both directions, TLS overhead and headers included, the upstream-to-client count against the class's response cap, and timing the connection against its limit. A connection over either is cut with a TCP reset (`resetAndDestroy`), so the client sees `ECONNRESET` and never a complete-looking close-delimited body. A refused host is answered `403` with `x-cogmo-egress: blocked_address`, which reaches the client intact. SNI and certificate validation happen in mockttp, against the hostname, through the tunnel. The tunnel keeps a short in-memory log of its refusals, cuts and byte counts, by class, host and time, for the audit.
- **The rest.** Admission and its caches, the `skill_egress` audit, and custody of the CA.

The credential rides in mockttp's metadata channel: `Proxy-Authorization: Basic <base64("metadata:" + base64url({"tags":["<credential>"]}))>`, read from the `CONNECT` for a tunnel or from a plain absolute-URL request, stripped before forwarding, and handed to the rules as the tag `socket-metadata:<credential>`. mockttp (Apache-2.0, Node ≥ 20, `@peculiar/x509` underneath) is the module's one runtime dependency, signed off under AGENTS.md → Autonomy. Its optional native dependency `tls-impersonate` stays unbuilt, out of `onlyBuiltDependencies`.

**Alternatives.** `mitmdump` as a child process, with a Python addon and a Unix-socket bridge, is the fallback if mockttp fails the integration test that drives the real listener (todo.md → Skills autonomy S6). A hand-rolled interceptor on `undici` and an X.509 library would rebuild the wire layer mockttp has run in production for years, Go or Rust MITM libraries add a second language and the same bridge, and Squid `ssl_bump` is configuration-driven, which makes per-run substitution awkward.

**Per request**, in order:

1. A request carrying anything other than exactly one `socket-metadata:` tag, or a credential that is missing or unadmitted, is refused with `407` when the request arrives: after the `CONNECT` and the client-side TLS handshake for a tunnel, on the request itself for plain `http`; no upstream connection is opened. **Residual:** a client without a credential can complete a TLS handshake with the proxy, and nothing more.
2. A request whose declared length exceeds the request cap, or whose buffer is empty under a `content-length` or `transfer-encoding` that announced a body, is refused `413` as `too_large`. An empty chunked body is refused with it, a residual for clients that send one.
3. A tunnel whose destination is not the request URL's host (a `CONNECT` to an IP literal with another name in `Host`) is denied as `host_not_allowed`. The policy always returns the URL it checked, so mockttp connects to that host and no other.
4. For a `verify_code` credential, a request to one of the spec's hosts is recorded `shadowed` and answered with the shadow reply, before the allowlist check and before resolution; any other host is denied.
5. A host outside the credential's allowlist is denied before resolution, so it never becomes a DNS query.
6. The tunnel resolves the host and connects only to an address that passed `isBlockedAddress`, so the checked address is the connected one, and SNI and certificate validation use the hostname. This closes DNS rebinding for `ctx.http` and the proxy alike.
7. The scheme check (`http` and `https` only; [v1 surface](#v1-surface)) in the policy; the proxy never follows a redirect. The class's response cap and timeout are the tunnel's, on the one connection the request owns; a connection cut for either reaches the client as a reset and the audit row as `too_large` or `timeout`. An upstream connection error reaches the client as `502` and the row as `upstream_error`, from mockttp's `passthrough-error` tag.
8. Substitution, below.
9. Audit, below.
10. In a shadow run, a non-GET method is recorded `shadowed` and answered `202` with a fixed shadow body.

**Substitution.** A bound secret never enters the worker. `ctx.secrets.get(name)` returns a placeholder, `cogmo-secret:<hmac(runId, name)>`, unique to the run.

- The binding names its `destination` (a URL pattern within the allowlist) and its `location`, an enum: `header` (the default: a named header, or the existing `header:` template) or `query` (one parameter). Body placement waits on an owner question (Open questions). The proxy replaces the placeholder only in that location, only on a request to that destination.
- A placeholder anywhere else — another host, another location — is passed through unchanged, so it reaches the destination as an opaque string, and audited as `binding_misuse`.
- `exchange: oauth_refresh` makes the proxy trade the stored refresh token for a short-lived access token at substitution time, caching it until its expiry, so no long-lived credential reaches the request either.
- An unbound secret keeps the pull model and classifies as `raw_secret` ([Risk tiers](#risk-tiers-without-a-human)). It is the fallback for credentials no binding can place, such as a signing key the skill computes with.

**Audit.** Every proxied request writes one `skill_egress` row: its subject, exactly one of `run_id` (`run` and `populate`), `draft_round_id` (verify classes inside a draft) or the register subject `(register_skill_name, register_tip_sha)` (verify classes for a register outside a draft), and `credential_class`; `method`, `origin`, `path` (never the query string), request and response bytes, `status`, `outcome` (`forwarded | shadowed | denied | failed`), `failure_reason` (`skill_egress_failure_reason`, set iff `denied` or `failed`: `host_not_allowed`, `blocked_address`, `credential_revoked`, `not_http`, `too_large`, `timeout`, `upstream_error`, `client_aborted`), and `bindings` (`EgressBindingsSchema`: each secret name with `substituted` or `misuse`). The row is inserted before the request is forwarded and completed from mockttp's `response` and `abort` events: the status from the event, request and response bytes from the tunnel's counts, and for a cut connection the reason from the tunnel's log, matched by class, host and the request's lifetime (**residual:** two concurrent requests of one class to one host, from any runs, are told apart only by time, so their byte counts and cut reasons can swap; refusals are unaffected, since their reply names its reason); `client_aborted` for an `abort` with no error of its own; a request whose insert fails is refused, failing closed as `secrets.get` does. A `ctx.http` call gets its row from the proxy like any other request. Only a request with no valid credential has no subject; it is logged, not stored.

**Credential lifecycle.** A credential has no state of its own; its liveness is read from durable state. A `run` or `populate` credential is live while its run is at `started`. A verify credential inside a draft is live while the draft is in the state, and the attempt in the phase and generation, the credential names. A draftless register's verify credential is live until its 10-minute expiry, or until the register call revokes the install credential in-process, which a restart forgets. The proxy holds only caches it can rebuild.

| Failure mode | State left | Why it is safe, or the residual |
|-|-|-|
| The proxy is down or restarting | requests fail to connect; the run continues | fails closed: no route exists around it. When a run ends in error, the runner checks the proxy's health and records `egress_unavailable`, a pausing kind, if it is down, whatever the skill raised. A restart re-derives admission from `skill_runs` |
| A run ends with a request in flight | the request runs on, until the tunnel's class timeout or its client socket closing | mockttp has no per-request abort; revocation refuses the run's next request, and the tunnel bounds the open one |
| A run is swept from `started` ([Run failures](#run-failures)) | the credential is revoked with it | the sweeper's transition is the same revocation |
| CA rotation | workers trust the old and new CAs until recycled | rotation drains the pool; the old CA is removed once no worker holds it |
| A leaf certificate cache lost | re-minted on first use | it is a cache |
| The pin tunnel is down, or refuses the host | the `CONNECT` fails; the request fails with `403` or `502` | fails closed: a class rule has no upstream but its tunnel, and mockttp resolves nothing itself |
| An upstream streams past the class cap, or past its time limit | the connection is reset; the client sees `ECONNRESET` | the tunnel counts and times the stream; the only copy mockttp keeps is capped by `maxBodySize`; the row records `too_large` or `timeout` |
| A client sends a body over the request cap | refused `413`, never forwarded | mockttp drops the copy past `maxBodySize`, and the policy refuses the request rather than forwarding a truncated body. **Residual:** an unauthenticated client holds up to the cap per connection before the `407` |
| A `CONNECT` to an IP literal naming an allowlisted host in `Host` | denied `host_not_allowed`; nothing connects | the policy compares the tunnel's destination with the URL's host, and returns the checked URL so mockttp connects by name, never by the tunnel's address |
| A WebSocket upgrade, or a non-HTTP protocol on the listener | refused: `503` for the upgrade, a closed connection otherwise | no WebSocket rule and no passthrough option exists |
| A mockttp major changes the rule or hook API | the integration test fails | it drives the real listener against a local TLS upstream (pinning, a wrong certificate, a `CONNECT` to an IP literal, `407`, `403`, `413`, the byte cap on a close-delimited body, one request per connection, a refused upgrade), so a bump that breaks the policy wiring cannot merge green |
| The proxy crashes between forwarding and completing the audit row | the row with `status` and response bytes null | the request is recorded as sent with its result unknown, never missing |
| The audit insert fails | the request refused | fails closed; the skill sees an `upstream_error` |
| The master key rotates | credentials of in-flight runs stop verifying | those requests get `407`; the runs fail with `egress_unavailable`. **Residual**, benign at single-user scale |
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
| pausing | `skill_retryable` (`SkillError(..., retryable=True)`), `runtime_unavailable` (pool, sandbox, supervisor, worker init), `dependency_unavailable`, `egress_unavailable`, `host_lost` (swept) | no | once, for a cron fire |
| legacy | `unknown`: only the migration writes it, on error rows from before the column | no | no |

- A failure before the skill executed is a `SkillInvokeRejection`, as today. A cron fire throws on `sandbox_unavailable`, so Inngest's retries apply; every other rejection is skipped, as today.
- A run that executed is never re-run on its own key. A cron run ending in a pausing kind is re-fired once, after a backoff, under `skill-cron:<skillId>:<scheduledFor>:retry`.
- `output_invalid` keeps what the skill returned, so the run is debuggable and the model is told its effects happened: `chk_skill_runs_outcome` admits `output` on an error verdict only with that kind.
- A non-JSON output (`NaN`, a `set`) is `output_invalid`, decided in the worker before `transitionToExecuted`, so a host-side parse never strands the row at `started`.

**Events.** Every run that finishes with an error emits `skills/run.failed` `{ skillId, runId, trigger, errorKind }`. Cron and event runs notify their run-as user: the skill, the error, the last success, and Disable. Tool runs reach the user through the model. The same subscriber applies the auto-disable rule ([Notifications and undo](#notifications-and-undo)), and `skills.disabled_reason` (`awaiting_first_deploy | operator | deregistered | error_rate`, set iff `disabled`) records why a skill is off, naming the activation states that `disabled` alone encodes.

**Stuck runs.** `skill-runs-sweeper` runs every 5 min and moves rows at `started` older than 15 min to `finished` with `error_kind = host_lost`, writing `finished_at`, `resource_usage` (`wallClockMs` from `created_at`, `peakMemoryBytes` null) and the `error` text (`swept: no result after 15 min`), as `chk_skill_runs_executed_payload` and `chk_skill_runs_outcome` require. Fifteen minutes is longer than the 60 s worker init plus the 600 s wall-clock ceiling plus the grace period. The move is a conditional UPDATE on `recovery_point = 'started'`. A late `transitionToExecuted` then matches no row and returns `swept`, logged with the output it discards, rather than throwing. A keyed retry replays the error instead of reading `inflight` forever.

**Audit columns.** `skill_runs` gains `git_sha`, `run_as_user_id`, `run_as_profile_id` and `shadow`. `skill_context_calls.error` becomes the `ctx_error_kind` pgEnum, and `secrets.get` fails closed when its audit row cannot be written. Backfills, in the migration of the slice that adds each column: with the run schema (todo.md → Skills autonomy S3), error runs get `error_kind = 'unknown'` and `shadow` is `false`; with the failure events (S12), context-call errors map each known `CtxErrorKind` string to its value and anything else to `unknown`, and disabled skills get `awaiting_first_deploy` when their sha has no live deploy, else `unknown`, since nothing recorded whether an operator or `deregister` turned them off.

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

- **CLI.** `cogmo skills runs <name> [--since 7d] [--status error]`; `cogmo skills run-log <runId>` (its context calls and egress); `cogmo skills activity <name> [--since 7d]` (hosts, secrets, writes, error kinds, cost); `cogmo skills drafts [--open]`.
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
  'registrar_unavailable', 'reviewer_block', 'risk_blocked', 'rounds_exhausted');
CREATE TYPE skill_draft_end_reason AS ENUM ('user_abandoned', 'spec_timeout', 'blocked_timeout', 'approval_timeout',
  'denied', 'step_error');
CREATE TYPE skill_review_verdict AS ENUM ('pass', 'revise', 'block');
CREATE TYPE skill_run_error_kind AS ENUM ('skill_raised', 'output_invalid', 'load_failed', 'wall_clock_exceeded',
  'memory_exceeded', 'skill_failed', 'input_invalid', 'skill_retryable', 'runtime_unavailable',
  'dependency_unavailable', 'egress_unavailable', 'host_lost', 'unknown');   -- 'unknown': migration backfill only
CREATE TYPE skill_disabled_reason AS ENUM ('awaiting_first_deploy', 'operator', 'deregistered', 'error_rate', 'unknown');
CREATE TYPE skill_egress_outcome AS ENUM ('forwarded', 'shadowed', 'denied', 'failed');
CREATE TYPE skill_egress_class AS ENUM ('run', 'populate', 'verify_install', 'verify_code');
CREATE TYPE skill_verify_phase AS ENUM ('install', 'code', 'register_install', 'register_code', 'done');
CREATE TYPE deployment_flag_reason AS ENUM ('calibration_passed', 'calibration_failed', 'recalibration_pending', 'no_second_family');
ALTER TYPE skill_deploy_status ADD VALUE 'blocked';   -- terminal: resolved_at set
CREATE TYPE skill_approval_class AS ENUM (/* SKILL_EFFECTS */ ..., 'raw_secret', 'reads_and_egress', 'sensitive_dependency');
CREATE TYPE skill_egress_failure_reason AS ENUM ('host_not_allowed', 'blocked_address', 'credential_revoked',
  'not_http', 'too_large', 'timeout', 'upstream_error', 'client_aborted');

skill_drafts (
  id                 UUID v7 PK,
  skill_name         TEXT NOT NULL,
  base_git_sha       TEXT,                     -- nullable: null for a new skill; the live sha an edit starts from
  conversation_id    UUID REFERENCES conversations(id),   -- nullable: null for a CLI-started draft, whose card and notifications go to the owner
  requester_user_id  UUID NOT NULL REFERENCES users(id),
  requester_profile_id UUID NOT NULL REFERENCES profiles(id),      -- the deploy origin, and who a schedule runs as
  status             skill_draft_status NOT NULL,
  round              INT NOT NULL,
  attempt            INT NOT NULL,             -- coding task within the round; resets to 0 each round
  transition_seq     INT NOT NULL,             -- increments on every transition and claim; in every event id and gate key
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
  attempt          INT NOT NULL,
  coding_task_id   UUID NOT NULL UNIQUE REFERENCES coding_tasks(id),   -- keyed skill-draft:<draftId>:<round>:<attempt>
  findings         JSONB NOT NULL,           -- SkillFindingsSchema: what this round was asked to fix; [] at round 0
  tip_sha          TEXT,                     -- nullable: null until the attempt's coding task opens its PR
  verify_report    JSONB,                    -- nullable: SkillVerifyReportSchema; null until verify settles
  verify_phase     skill_verify_phase NOT NULL,  -- which verify credential the proxy admits; transitions in Verify phases
  deps_hash        TEXT,                     -- nullable: the lockfile hash verify-install populated; null in 'install'
  verify_resets    INT NOT NULL,             -- 0 at insert; +1 per phase reset; in every verify credential; steps reset while < 2, owner taps past it
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
  reason      deployment_flag_reason NOT NULL,         -- why the flag last changed
  calibration_inputs JSONB,                            -- nullable: CalibrationInputsSchema { checklistVersion, promptDigests, modelIds, cliVersions } of the last calibration run; null until one runs
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
  draft_round_id  UUID REFERENCES skill_draft_rounds(id),   -- nullable: the subject of verify requests inside a draft
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

-- skill_runs gains:
  git_sha            TEXT,        -- nullable: null only on rows from before the column; every new row sets it
  run_as_user_id     UUID REFERENCES users(id),     -- nullable: as git_sha
  run_as_profile_id  UUID REFERENCES profiles(id),  -- nullable: as git_sha
  shadow             BOOLEAN NOT NULL,         -- written explicitly by every insert; the migration backfills false
  error_kind         skill_run_error_kind,  -- nullable: set iff status = 'error' (CHECK)
  -- chk_skill_runs_outcome admits output on an error verdict only when error_kind = 'output_invalid'

-- skill_deploys gains:
  restores_git_sha   TEXT,        -- nullable: set iff status = 'rolled_back' (CHECK); backfill: the row's own git_sha, which an update-ref rollback restored

-- skills gains:
  disabled_reason    skill_disabled_reason,  -- nullable: set iff disabled (CHECK); backfill: 'awaiting_first_deploy' where the sha has no live deploy, else 'unknown'

-- skill_context_calls.error becomes ctx_error_kind (the CtxErrorKind set, plus 'unknown' for unmapped legacy text); http.request rows give way to skill_egress
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
| Drafts `[proposed]` | `draft/` | The draft lifecycle: one use case per transition, the draft functions, the spec card |
| Review `[proposed]` | `review/` | `SkillReviewer`, its Claude Code and Codex backends, the checklist, the calibration job |
| Egress `[proposed]` | `egress/` | The egress proxy: the mockttp rules and policy, the pin tunnel, credentials, substitution, audit |

The public interface is `SkillRunner`, defined once in [Where the classifier runs](#where-the-classifier-runs).

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
| Reviewers | The author's model in a fresh session plus the other family's; structured verdict; round 0 plus up to 3 revision rounds | Self-preference bias makes the author's family the weakest sole judge; rounds are bounded because self-repair is limited by critique quality. A seeded-bug suite is a regression floor, not a recall measure. |
| Prompt practices | Each has a mechanical twin in the verify stage | Prompts are advisory; gates are deterministic. |
| Classifier execution | Branch + `register` RPC | No repo-watching. Branch ≠ deploy. Atomic, synchronous, authoritative. Pre-commit hook deferred unless ~30s feedback lag becomes painful. |
| Who advances `main` | Only Cogmo: `register`, and the toolchain and layout commits at boot | Pre-receive hook rejects direct pushes to `main`. Makes "live on main" atomic with "classified and approved"; collapses transient "committed-but-rejected" states; structurally prevents force push. |
| Concurrency on register | Advisory lock + pending-deploy check | `pg_advisory_xact_lock` per skill name queues concurrent registers; it doesn't refresh the loser's snapshot (audit filed in `todo.md`). Refuse if a pending-approval deploy exists. Idempotent for no-op SHAs. Standard DB-backed state-machine pattern. |
| LLM tool surface | One tool per skill (dynamic per-turn tool list) | Matches progressive disclosure — skills appear in the tool list with their own name + description. No `invoke_skill` wrapper (would break discovery). Orchestrator rebuilds tool list each turn from `SkillRunner.list()`. |
| Manifest | Single `SkillManifestSchema` (Zod) parsed from `SKILL.md` frontmatter | Five consumers read it: register RPC, classifier, dependency populator, dispatcher, tool registrar. One schema prevents field drift. Superset of Anthropic SKILL.md. |
| State reset | Fresh processes per task forked from a pre-imported supervisor, behind a per-task relay; the task's process tree is killed before the worker is released; per-skill `recycle` opt-out | No in-memory state or process crosses tasks, at a few ms per task. Recycling every task also resets the filesystem, at a container start per invocation. |
| Skill discovery | Progressive disclosure (SKILL.md) | Matches Anthropic standard. At <50 skills, tool list stays manageable. Retrieval (`search_skills`) added later when tool-list tokens or selection accuracy forces it. |
| Resource budgets | Declared in SKILL.md; cgroup slice (container); WASM per [Tier-1 boundary](#tier-1-boundary-proposed) | Container tier reuses sandbox.md cgroup parent. Per-skill override within tier hard ceilings. |
| Cost tracking | Wall-clock + peak memory + LLM tokens via `ctx.llm` + declared `cost_per_call_usd` | Measured per `skill_run`. Dispatcher enforces daily/monthly budget from SKILL.md. `auto` tier requires zero paid surface. |
| Cron failure handling | `error_kind` classes: a pausing kind re-fires once, every failure notifies, defects auto-disable | Infrastructure failures must not read as skill bugs, and a run that executed is never silently repeated. |
| Tier-1 boundary | Pyodide in a forked child under `--permission` and `--disallow-code-generation-from-strings`, minimal frozen `jsglobals`, `env: {}`, no network API, a `grow` hook | Measured: `jsglobals` alone leaves the `Function`-constructor path, `resourceLimits` does not cap WASM memory, and snapshots cannot preload dependencies. |
| Contracts | pydantic `Input` / `Output` in `skill.py` generate the tool schema; one `cogmo_ctx` generated from the TS schemas | One source per contract; every copy generated and checked in CI. |
| Inter-skill composition | Not in v1; future via `ctx.skills.invoke()` through orchestrator | Agent composes at LLM level. Direct skill imports rejected — break permission scoping. |
| `ctx` v1 surface | secrets, memory, files, http, now, user, log (attachments, llm, notify pending) | Covers what skills actually need. `http` is the intended network path, gated on the manifest's `network.allow`; metrics, composition and scheduling stay deferred. |
| Invocation | Inngest events | Durable execution, retry, scheduling — all free. Matches existing orchestration pattern. |
| Output delivery | JSON via tool result; binaries via `AttachmentStore` | Same pattern as `generate_image`. |
| Skill metadata | `SKILL.md` frontmatter | Matches Anthropic's progressive-disclosure standard, already referenced in [integrations.md](integrations.md). |
| Host access | `ctx` object projected over JSON-RPC | Mirrors TS `Service` pattern for tools — same shape, over a pipe. Covers secrets, memory, attachments uniformly. |
| Secrets access | Pull model — `ctx.secrets.get(name)` gated by manifest allowlist; bound secrets become placeholders the egress proxy substitutes | Materializes secrets only at point of use; per-access audit; zero-touch rotation. Reads naturally in Python. The manifest gating its own access is the skill declaring its own permissions, which is why risk tiering and the egress allowlist carry the weight rather than the allowlist alone. |
| Secrets storage | Existing encrypted `secrets` table (per [infrastructure.md](infrastructure.md)) | Cogmo already has a minimal self-hosted vault. No external service at personal scale. |
| Egress enforcement | One token-injecting forward proxy in `cogmo serve`; tier-2 workers on an internal network with no other route; `ctx.http` through the same listener | The missing route is the enforcement, so unsetting a variable bypasses nothing; one implementation of allowlist, pinning, substitution and audit. mockttp in-process: it owns the interception wire layer, proven in production, while the policy stays TypeScript against Cogmo's stores, with no bridge and no second runtime; a `mitmdump` child is the fallback. |
| Dep declaration | `dependencies: ["pkg==version", ...]` in `SKILL.md`; Zod regex rejects ranges/extras/URLs/paths | One Zod schema, five consumers — same drift-prevention as the rest of the manifest. Strict pinning prevents resolution drift between register and re-resolve. |
| Lockfile | `requirements.lock` next to `skill.py`, hash-pinned via `uv pip compile --generate-hashes`, author-committed | Transitive graph pinned; register byte-compares to catch staleness. Atomic with the rest of the skill from the operator's POV. |
| Resolver | `uv` (compile + sync) baked into `cogmo-skills:<version>` runtime image | Sub-100ms venv creation; hash pinning is first-class; resolver at register matches resolver at populate byte-for-byte. Already standardised across the codebase. |
| Where compile runs at register | Short-lived sandbox session via `SandboxClient` | No host-side `uv` dependency; same `uv` binary as runtime; ~1-2s register latency is acceptable for a once-per-skill-version op. |
| Dep cache shape | Per-lockfile-hash venv at `/skill-venvs/`; storage chosen per backend via `SandboxCapabilities.depsCacheSharing` (`shared-volume`: ext4 Docker volume, cross-worker dedup; `per-sandbox`: container-local ephemeral disk) | Avoids per-skill image rebuild (kills warm-pool economics). uv's hardlink + atomic-rename requirements only hold on POSIX backends; FUSE object storage (Daytona Volumes / mountpoint-s3) lacks them so the runner falls back to per-sandbox ephemeral and pays a cold populate per worker. Capability flag is the dispatch — wiring is backend-agnostic. |
| Cache atomicity | Populate to `<hash>.tmp.<workerId>/`, `.ready` marker, `mv -T` rename | uv has no directory-level atomicity guarantees under concurrent writers ([uv #15335](https://github.com/astral-sh/uv/issues/15335)). Marker file + `mv -T` rename is the portable answer on POSIX storage; the loser of a concurrent populate sees `.ready` on the target after its rename fails and exits success. On `per-sandbox` backends each worker has its own `/skill-venvs/`, so cross-worker concurrency on the same hash can't happen — the rename still runs but is single-writer. No Postgres advisory lock needed at this layer (advisory lock IS used for register concurrency, a separate concern). |
| Cache reachability | `skills.lockfile_hash` denormalised from git; reaper sweeps `<hash>/` with no live reference + 7-day grace | LRU evicts cold-but-live skills and pays multi-second cold start on next invoke. Reachability + grace period is correct. |
| Source distributions | Forbidden (`--only-binary=:all:`) | Sdists run arbitrary install-time code + need a build toolchain. Auto-tier never includes sdists. Opt-in escape hatch deferred to a real driver. |
| Venv overlay vs `--target` | Per-skill venv, not `--target` + PYTHONPATH | `--target` has well-known namespace-package collisions ([pip #10629](https://github.com/pypa/pip/issues/10629)), inert `.pth` files, missing console scripts; PYTHONPATH overlay shadows base-wins which is surprising. Venv creation is cheap enough that "always a venv" is defensible. |
| Tier 1 deps | Today `micropip.install` at worker init with a version check; `[proposed]` host-fetched, hash-checked wheels installed offline ([Tier-1 boundary](#tier-1-boundary-proposed)) | Pyodide-incompatible wheels fail at register (`pyodide-compat.ts`); the wheel directory closes micropip's missing `--require-hashes`. |
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
