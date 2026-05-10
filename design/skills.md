# Skills `[proposed]`

Execution runtime, storage, and invocation for agent-authored skills — small Python programs the agent writes to accomplish recurring tasks.

> *Sandbox API names below (`Sandbox interface`, "sysbox container spawn (via Sandbox interface)") reflect the current code. The canonical interface contract is [sandbox.md](sandbox.md) → Backend Architecture, where `SandboxClient` / `SandboxSession` is the in-flight refactor target. Tier-2 workers will switch to `SandboxClient.create()` when the refactor lands.*

## Scope

**In:**

- How skills are stored (git repo layout)
- How skills execute (runtime tiers, warm pool)
- How skills are invoked (Inngest events, cron)
- State handling between invocations

**Out (covered elsewhere):**

- Skill authoring flow — see [coding-delegation.md](coding-delegation.md) and [evolution.md](evolution.md)
- Skill discovery / retrieval — see [integrations.md](integrations.md) (Voyager pattern, SKILL.md standard, description embedding)
- Self-evolution gates / approval — see [evolution.md](evolution.md)
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

**Used for:** skills that only need HTTP, stdlib, and pre-built / pure-Python packages.

**Why:** capability-based sandbox built into the runtime, sub-50ms cold start, ~0ms warm, ~10 MB memory per instance. In-process execution — no container boot.

**Constraints:**

- No `subprocess`, no shell-outs, no native binaries
- Packages limited to Pyodide's [pre-built list](https://pyodide.org/en/stable/usage/packages-in-pyodide.html) (~200+ including numpy, pandas, cryptography, sqlalchemy) plus pure-Python wheels installable via `micropip`
- No raw sockets (HTTP via `fetch` shim)
- No `os.fork`, limited threading

**Typical coverage:** HTTP API wrappers (Anthropic / OpenAI SDKs, Slack, GitHub, Google APIs), data transforms, JSON/CSV manipulation, plotting. Roughly the "glue code + data" slice of skills.

### Tier 2 — Sysbox container

**Used for:** skills that need `subprocess`, native binaries, arbitrary pip wheels with C extensions, or full-OS isolation.

**Why:** full Python + OS ecosystem, hardened namespaces (user namespaces = root-in-container ≠ root-on-host), consistent with the runtime already chosen for coding delegation. Full [sandbox.md](sandbox.md) infrastructure reused.

**Constraints:**

- Higher resource overhead (~100–300 MB per worker for Python + imports)
- 1–2s cold start if not warm — addressed by the warm pool

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
| **WASM** | 128 MB | 30 s | n/a (single-threaded isolate) | V8 isolate heap limit at creation; host-side wall-clock timer terminates the isolate on timeout. **Known limit:** a tight CPU loop inside the WASM Python runtime may not yield to the V8 interrupt mechanism cleanly — the host timer will fire, but termination depends on hitting a JS↔WASM boundary. Hard fallback: kill the Node worker thread hosting the isolate. |
| **Container** | 512 MB | 60 s | 1 CPU share | Per-run cgroup slice under [sandbox.md](sandbox.md)'s cgroup parent pattern — same mechanism as coding delegation's per-task budgets. Dispatcher SIGKILL on wall-clock exceeded. |

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

## Warm pool `[confirmed]`

The container tier is warmed from day 1. A 1–2s cold start on every interactive skill invocation is user-visible latency. The dispatcher abstraction also removes the need for a sync/async tier split — one pool handles both uniformly.

Implementation lives across two trees. The TypeScript host in `src/skills/worker-sysbox/` (`pool.ts` for lifecycle, `worker.ts` wraps a long-lived `SandboxSession` running the python supervisor) and the Python runtime in `images/skills/` (a real `cogmo_skills_runtime` package with `pyproject.toml`, `uv.lock`, ruff + pyrefly + pytest, multi-stage Docker build that bakes the venv into `cogmo-skills:<version>` at `/opt/cogmo-skills/.venv`). The TS worker spawns the supervisor via `python3 -u -m cogmo_skills_runtime` — `__main__.py` calls `supervisor.main()`. `SkillRunnerImpl.create` eagerly stands the pool up when a sandbox is wired; `shutdown()` tears it down.

### Shape `[confirmed]`

| Piece | Responsibility |
|-|-|
| **Pool manager** (`SysboxWorkerPool`) | Track each worker's state (`idle` / `busy` / `draining`). Scale between `min` and `max` on demand. Recycle workers after N tasks or T ms age. Sweep idle workers above `min`. |
| **Worker** (`SysboxSkillWorker`) | One sysbox container with a `SandboxSession`, reused across many tasks. Spawns the python supervisor process ONCE at create-time via `session.execStreaming`; that process stays alive for the worker's lifetime, forking a fresh child per task. The host's `Dispatcher` multiplexes sequential `task_invoke` / `task_result` over the supervisor's stdin/stdout. |
| **Supervisor** (`supervisor.py`) | Long-lived python process inside the container. Reads `task_invoke` lines from stdin; for each task, `os.fork()`s a child that runs the existing one-shot runner (`runner.py`'s `_main(body, inputs, task_id)`). Parent supervises wall-clock via `os.pidfd_open` + `selectors.select(timeout=...)`; on timeout, SIGKILLs the child and emits `wall_clock_exceeded` on the host's behalf. Child writes `ctx_call` / `task_result` to stdout and reads `ctx_result` from stdin directly (real `os.fork()` inherits FDs cleanly). EOF on stdin = clean shutdown. |
| **Dispatcher** | One `Dispatcher` per worker (NOT per task), reused across the worker's lifetime over a persistent NDJSON transport. Per-task `CtxHandler` is supplied at each `invoke()` call so the run id, manifest, and audit hooks scope to that task. |

### Protocol

Bidirectional JSON-RPC over stdin/stdout. One pipe handles four message types, correlated by `id`:

- `task_invoke` (host → worker) — starts a task.
- `task_result` (worker → host) — terminal response for a task.
- `ctx_call` (worker → host) — `ctx.*` RPCs issued mid-task (e.g. `ctx.secrets.get()`).
- `ctx_result` (host → worker) — response to a `ctx_call`.

Each message is one line of NDJSON. Every `*_result` carries the `id` of the request it answers — a single worker may have one `task_invoke` in flight and several `ctx_call`s nested inside it concurrently. The worker-side SDK blocks the skill's Python call on the matching `ctx_result`.

```json
// host → worker
{"type": "task_invoke", "id": "run-7f3", "skill": "summarize-email", "input": {...}}

// worker → host (mid-task)
{"type": "ctx_call", "id": "ctx-9a2", "method": "secrets.get", "args": {"name": "slack_webhook"}}

// host → worker (answer to ctx-9a2)
{"type": "ctx_result", "id": "ctx-9a2", "ok": true, "value": "..."}

// worker → host (task terminal)
{"type": "task_result", "id": "run-7f3", "ok": true, "output": {...}}
{"type": "task_result", "id": "run-7f3", "ok": false, "error": "..."}
```

stdin/stdout chosen over HTTP / Unix socket for simplicity — one process per worker, no port allocation, no service discovery. Multiplexing on a single pipe is fine because it's plain NDJSON with correlation IDs.

### State reset between tasks `[confirmed]`

Between tasks, "state" means Python module-level globals, library internals (connection pools, engine caches), `sys.modules` entries, monkey-patches, open file handles, background threads. Any of this leaking from task 1 into task 2 is a correctness or security bug.

**Shipped: pre-fork supervisor — long-lived parent, `os.fork()` per task.** ~10-30 ms per task (COW fork from a parent that's already imported `asyncio`, `json`, `traceback`, `uuid`, the Ctx bridge classes — children inherit those for free). Full process-level isolation: every task runs in a fresh OS process forked from the supervisor's `sys.modules` snapshot at create time, so module-level state, monkey-patches, threading state, and open fds from task 1 cannot leak into task 2. Bounded container drift via the pool's `recycleAfterTasks` / `recycleAfterMs`. Wall-clock kill is `SIGKILL` on the child PID; the supervisor itself stays alive and forks a fresh child for the next task — pool worker stays reusable.

**Why not subinterpreters (PEP 734).** Researched in 2026-05; ecosystem isn't ready. NumPy and pandas don't support `Py_mod_multiple_interpreters` yet (numpy/numpy#24755 estimates "~a year of rewrite"); cross-interp asyncio bridging is hand-rolled (no stdlib recipe); zero production adopters. The latency win (~50ms vs ~10-30ms here) doesn't justify the bridge complexity and ecosystem fragility. Revisit when (a) NumPy ships subinterp support, (b) at least one notable project ships it in production, (c) async-aware queue API lands in stdlib. Probably 3.16+ (late 2027).

**Why not `multiprocessing` / `pebble`.** Tried; rejected. `multiprocessing.process.BaseProcess._bootstrap()` unconditionally calls `util._close_stdin()` in every worker child regardless of `fork` / `forkserver` start method. Workers can't read host stdin, which breaks the ctx-bridge over inherited stdio. Workarounds (dup-and-restore stdin, separate pipe pair with multiplexing supervisor) re-introduce the complexity hand-rolling avoids. Hand-rolled fork supervisor sidesteps the stdlib's design intent and is ~150 LOC of stdlib-only Unix code (`os.fork`, `os.pidfd_open`, `selectors.select`, `os.kill`, `os.waitpid`).

**Per-skill opt-out** — `isolation: recycle` in `SKILL.md` poisons the worker after the task runs, so the pool replaces it on the next acquire. Useful for skills whose imports (e.g. C extensions with module-level threading state) might leave the supervisor's snapshot in a state we don't want subsequent tasks to inherit. The `isolation: subinterpreter` enum value is currently treated as "default" (the shipped fork-per-task model); reserved for a future runtime that actually uses PEP 734.

| Mode | Today (shipped) | When to use |
|-|-|-|
| `subinterpreter` (default) | Fork-per-task isolation; worker stays reusable. | Default for all skills — fork inherits the supervisor's pre-imports cleanly. |
| `recycle` | Fork-per-task + worker poisoned after task → replaced on next acquire. | Skills whose imports could pollute the supervisor's `sys.modules` snapshot in a way that hurts subsequent forks (rare). |

**Not used:** logical reset (`importlib.reload` + globals clear). Too leaky — misses library state and monkey-patches. Present in the option space but never the right answer.

### Sizing `[confirmed]`

`DEFAULT_POOL_OPTIONS` in `src/skills/worker-sysbox/pool.ts`:

| Parameter | Default | Env override | Notes |
|-|-|-|-|
| `min` (always warm) | `0` | `COGMO_SKILLS_POOL_MIN` | Workers exist iff there's an active or recently-active task. Pool itself is lazy-constructed on first tier-2 invocation. Trade-off: first invoke per idle period pays a cold start (~1-2 s Local-Docker, ~30 s warm Daytona). Set `1` for steady-state ~300 ms interactive latency at the cost of one always-running worker. |
| `max` (hard cap) | `3` | — | Personal scale — concurrent skill invocations rarely exceed. |
| Spawn-on-demand | up to `max` | — | When no idle worker is free, spawn one up to `max` rather than queuing. Personal-scale latency wins over backpressure economy. |
| `recycleAfterTasks` | 500 tasks | — | Bounds container drift (tmpfs, log accumulation, allocator fragmentation). |
| `recycleAfterMs` | 24 h | — | Wall-clock ceiling — catches workers that ran few tasks but sat warm forever. |
| `idleShutdownMs` | 30 min | `COGMO_SKILLS_POOL_IDLE_SHUTDOWN_MS` | Idle workers above `min` get reaped. With `min=0` the pool drops to zero idle workers; useful on managed backends where a warm worker is a billable sandbox (Daytona deployments should set lower, e.g. 5 min). |
| `idleSweepIntervalMs` | 1 min | — | Sweep cadence. |

**Lazy pool init.** The pool itself isn't constructed until the first tier-2 invocation — `cogmo serve` boots without spinning anything up on the configured sandbox. Concurrent first-callers share one in-flight construction; an init failure (e.g. transient Daytona blip) clears the in-flight reference so the next invocation retries. This keeps an unreachable managed backend from failing boot for deployments that may never invoke a tier-2 skill.

Starting values; revisit with usage data. Skills that declare `resources.{cpu_shares,memory_mb}` overrides bypass the pool — they get a fresh, per-skill-resource-budget container, paying the cold-start every invoke. Most skills don't override and ride the warm path.

### Tier 1 pool `[proposed]`

WASM workers are not pooled today — each invocation spawns a fresh Node worker thread + Pyodide bootstrap, costing ~5s. The future shape: one Pyodide instance per Node worker thread, reused across skill invocations. No container, no recycle tuning. Reset between tasks via fresh Pyodide globals scope (built-in). Sizing: `min = 1`, `max = tier2.max` (share fate). Defer until tier-1 invocation latency becomes user-visible — most production traffic ships through tier-2.

## Skill storage `[proposed]`

Skills live in git. Versioned, diffable, auditable — necessary for self-evolution rollback and audit.

### Repo location

**Configurable local bare repo, user-owned.** Shape:

```text
$COGMO_SKILLS_PATH/                # default /var/lib/cogmo/skills (configurable)
  .git/                            # initialized by Cogmo if missing
  summarize-morning-email/
    SKILL.md
    skill.py
  spending-report/
    SKILL.md
    skill.py
```

- Path configured via env var or `settings.local.json`.
- Cogmo initializes an empty git repo on first boot if the path doesn't exist.
- User optionally sets a remote (`git remote add origin git@github.com:user/cogmo-skills.git`) for backup and cross-machine sync. Cogmo `git push` / `git pull` on schedule if configured.
- Coding delegation operates on this repo exactly like it operates on Cogmo itself — worktrees under the skills path, standard git flow, reused [sandbox.md](sandbox.md) + [coding-delegation.md](coding-delegation.md) infrastructure.

**Why not inside the Cogmo repo:** skills are personal, per-deployment. Committing them to a fork of Cogmo creates merge conflicts on upstream pull, leaks private workflows through misconfigured remotes, and couples release cadences that naturally diverge.

**Why not a separate shared repo (`cogmo-skills`):** user's personal skills shouldn't sit in a shared public repo either. A local user-owned repo with an optional user-owned remote is the right ownership model.

**Why no git server in Cogmo:** most commits auto-apply directly to `main` (see risk tiering below), so there's no PR UI to build. Multi-machine sync, if needed later, uses the user's own remote (GitHub private, self-hosted Gitea, etc.) — no reason to reimplement a git server.

**Bundled base skills:** none initially. Agent bootstraps by authoring skills as needed. If patterns emerge that should ship with Cogmo, promote them to a `base-skills/` directory inside the Cogmo repo in a later iteration.

### Repo invariants

Hard rules enforced on the skills repo:

- **`main` is advanced only by Cogmo's `register` RPC.** Direct pushes to `main` from any other source (agent, human, tool, CI) are rejected *unconditionally*. Agents work on feature branches; the orchestrator is the sole merger. This makes "classified and live" atomic with "present on `main`" — no transient "committed but rejected" state can exist.

  Enforced by a `pre-receive` hook on the bare repo:

  ```bash
  while read oldrev newrev refname; do
    # No push may update main — ever. Cogmo advances main via filesystem update-ref, not push.
    if [[ "$refname" == "refs/heads/main" ]]; then
      echo "Direct pushes to main are not allowed. Use 'cogmo skills register'."
      exit 1
    fi
    # Force-push denied on any branch (feature branches included).
    if [[ "$oldrev" != "0"* && "$newrev" != "0"* ]]; then
      git merge-base --is-ancestor "$oldrev" "$newrev" || {
        echo "Force push not allowed on $refname"; exit 1;
      }
    fi
  done
  ```

  Cogmo advances `main` via `git update-ref refs/heads/main <sha>` directly on the bare repo's filesystem. This bypasses the hook by design — hooks only fire on `push`, not on `update-ref`. No env-var escape hatch for the hook; that would be a footgun (anything in Cogmo's env could bypass). The filesystem-write path is the sole merge mechanism, and it's available only to Cogmo (who owns the filesystem).

- **No force push, no history rewrite on any branch.** `skills.git_sha` references point to specific commits — if history is rewritten, those SHAs dangle and the live skill becomes uninvocable. Enforced by:
  - The pre-receive hook above (non-fast-forward rejected on every branch).
  - Remote branch protection if a remote is configured (GitHub "require linear history," "do not allow force pushes"; equivalent on Gitea).
  - Coding delegation's sandbox proxy refuses any `git push --force`, `git push -f`, or `git update-ref` that would rewrite a reachable commit on its worktree side too.

- **Append-only branches.** Every deploy is a commit added to a feature branch, then merged fast-forward into `main` by `register`. Rollbacks update `main` to a prior SHA (still fast-forward-compatible via `--force-with-lease` from the Cogmo side; to outside observers, main simply moves).

- **Signed commits (optional).** If the user configures commit signing, Cogmo verifies signatures on `register` and refuses unsigned commits. Not required v1.

### Per-skill structure

Follows the Anthropic SKILL.md standard for progressive disclosure (see [integrations.md](integrations.md)):

```text
skills/
  summarize-email/
    SKILL.md           — name, description, when-to-use (retrieval key)
    skill.py           — entrypoint
    requirements.txt   — explicit deps (tier 2)
    test.py            — optional smoke test
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

# Permissions & effects — optional but drive risk classification
effects:
  - reads_user_data
  - sends_message
secrets:
  - name: telegram_bot_token
    binding:                       # egress-proxy binding, future [research]
      destination: "https://api.telegram.org/*"
      substitute: "header:Authorization: Bot {{value}}"
  - name: gmail_oauth
    binding:
      destination: "https://gmail.googleapis.com/*"

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

  // Permissions & effects
  effects: z.array(z.enum(SKILL_EFFECTS)).default([]),
  secrets: z.array(z.union([
    z.string(),                        // v1: by name only
    z.object({                         // future: egress-proxy binding
      name: z.string(),
      binding: z.object({
        destination: z.string(),
        substitute: z.enum(["url"]).or(z.string().startsWith("header:")),
      }).optional(),
    }),
  ])).default([]),

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

**Validation happens in four places — all reading the same schema:**

1. **`register` RPC** — parses manifest, rejects with `errors[]` on schema failure.
2. **Classifier** — reads validated manifest fields (`effects`, `secrets`, `tier`) to assign risk tier.
3. **Dispatcher** — reads `inputs` schema to validate invocation arguments; reads `resources` to set cgroup/isolate caps; reads `budget` to check cost.
4. **Tool registrar** — reads `description` + `inputs` to build the LLM's per-skill tool entry.

Single schema, four consumers, zero drift.

## Risk tiering & auto-apply `[confirmed]`

Not every skill creation or edit needs human approval. Review-everything is friction the system doesn't need. Instead, each deploy is auto-classified into one of three tiers based on the manifest + a static-analysis pass; tier determines whether Cogmo merges directly, notifies, or waits for explicit approval.

### Tiers

| Tier | Matches when | Action |
|-|-|-|
| **Auto** | WASM tier, no secrets (or only read-only public-API secrets), no `writes_*` / `sends_*` / `deletes_*` / `financial` effects, cost-capped | `register` fast-forwards `main` to the branch tip immediately on classification. Skill is live. No notification. |
| **Notify** | Container tier, OR reads user data, OR idempotent external writes (`writes_memory`, creating drafts, upserts), OR any secrets with scoped destinations | `register` fast-forwards `main` to the branch tip immediately on classification. Cogmo sends a one-line notification: *"added skill `X` — [summary]. /disable X if wrong."* |
| **Approve** | Any destructive effect (`deletes_external`, overwrite), external messaging (`sends_email`, `sends_message`, `posts_public`), `financial`, `spawns_subprocess`, broad permissions (3+ secrets, filesystem writes) | `register` leaves `main` untouched; the branch stays as-is. Cogmo sends a Telegram approval prompt with diff + effect summary + approve/deny buttons. `main` is fast-forwarded only when `approveDeploy` fires. |

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

**Failure mode.** Any throw from the AST path (parser load failure, walk panic, unexpected node shape) is caught at the `classifier.ts` boundary and routes through the declaration-only stub (`classifyManifestStub`). The audit log shifts `classifier_version` from `ast-1` to `stub-2-effect-aware` so an operator can spot the degradation; the deploy still completes with a conservative declaration-only tier. The fallback can never reach `auto` — the stub can't *prove* read-only, only the AST path can.

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

1. **Acquire advisory lock** `pg_advisory_xact_lock(hashtext("skill_register:" + name))`. Serializes concurrent registers on the same skill name.
2. **Fast-forward check.** Verify `main` is an ancestor of the branch tip. If not → return `{ status: "rejected", errors: ["main has advanced; rebase branch and retry"] }`.
3. **No-op check.** If `current skills.git_sha == branch tip sha` → return `{ status: "live", … }` with no side effects (idempotent).
4. **Pending-approval check.** If any `skill_deploys` row for this skill has `status = 'pending_approval'` → return `{ status: "rejected", errors: ["pending deploy exists; approve or deny first"] }`.
5. **Read + classify.** `git show <branch-tip>:SKILL.md` / `:skill.py`. Run classifier + static analysis. Validate manifest against `SkillManifestSchema`.
6. **Branch by tier:**
   - `auto` / `notify` → `git update-ref refs/heads/main <branch-tip>` (advances main), delete the feature branch, `UPSERT skills`, insert `skill_deploys` with `status = 'live'`. The audit trail lives in `skill_deploys.git_sha` — the branch pointer itself is not the record, so cleanup is unambiguous.
   - `approve` → insert `skill_deploys` with `status = 'pending_approval'`. Branch **stays** until `approveDeploy` / `denyDeploy` resolves the deploy. `main` does not move. Fire Telegram prompt.
   - Validation errors → return `errors[]`, nothing persisted.
7. **Commit** (releases lock). Return result synchronously.

RPC signature:

```typescript
interface SkillRunner {
  register(opts: { branch: string }): Promise<RegisterResult>;
  approveDeploy(opts: { pendingId: string }): Promise<RegisterResult>;
  denyDeploy(opts: { pendingId: string; reason?: string }): Promise<void>;
  rollback(opts: { name: string; toGitSha?: string }): Promise<RegisterResult>;
  deregister(opts: { name: string }): Promise<DeregisterResult>;
  enable(opts: { name: string }): Promise<EnableResult>;
  list(): Promise<readonly SkillSummary[]>;
  listAll(): Promise<readonly SkillSummary[]>;  // includes disabled
  invoke(opts: { name: string; inputs: unknown }): Promise<SkillRunResult>;
}

interface RegisterResult {
  name: string;
  riskTier: "auto" | "notify" | "approve";
  status: "live" | "pending_approval" | "rejected" | "no_op";
  gitSha: string;                // live SHA post-register (or unchanged if pending/rejected)
  errors?: readonly string[];    // present if status === "rejected"
  pendingId?: string;            // present if status === "pending_approval"
}

// Discriminated unions — typed `kind` instead of thrown `Error`s, so transport
// adapters can pattern-match without string-matching error messages.
type DeregisterResult =
  | { kind: "deregistered"; name: string }
  | { kind: "rejected"; name: string; reason: "not_found" };

type EnableResult =
  | { kind: "enabled"; name: string; gitSha: string }
  | { kind: "already_enabled"; name: string; gitSha: string }
  | { kind: "rejected"; name: string; reason: "not_found" | "no_live_deploy" };
```

**Approval-gate guard on `enable`.** Re-enabling refuses (`reason: "no_live_deploy"`) when the skill's current `gitSha` has no `skill_deploys` row with `status = 'live'`. Without the guard, a denied first deploy (`skills.disabled = true`, `skill_deploys.status = 'denied'` at the rejected sha) could be smuggled past the approval gate via `/disable foo` then `/enable foo` — flipping `disabled = false` would activate code that never passed human review. Rolled-back skills still pass because the prior live deploy row remains in the append-only history.

**Key properties:**

- **Branch ≠ deploy.** Agent can push any feature branch freely. Only `register` advances `main`.
- **`main` is authoritative.** `refs/heads/main` in the bare repo and `skills.git_sha` in the DB always agree — both are written together inside the register transaction.
- **No race via direct push.** Pre-receive hook rejects non-Cogmo writes to `main`; advisory lock serializes Cogmo's own writes.
- **Idempotent.** Registering a branch whose tip is already `main` is a no-op. Safe to retry on network timeouts.
- **Git push is orthogonal.** Pushing branches to a user-configured remote (backup, multi-machine) neither triggers nor depends on registration.

## Cost tracking `[proposed]`

Two cost surfaces, measured separately:

**Compute** — `skill_runs.wall_clock_ms` from dispatcher; peak memory from cgroup stats (container tier) or isolate stats (WASM). Cheap to track, captures almost all "bad skill burned the machine" cases.

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
- **Automatic kill-switches** *(P3.4)* — a skill exceeding its cost cap, error-rate threshold, or wall-clock budget auto-disables and pings the user.

### Mapping to existing design

- **[evolution.md](evolution.md) graduation model** — start strict, auto-apply patterns that prove safe. The risk classifier is the "what's safe" function made explicit.
- **[integrations.md](integrations.md) permission tiers** — read-only / read-write auto / read-write approval. Same tiering, specialized to skills.

## Invocation `[proposed]`

Skills are invoked via Inngest events:

| Trigger | Source | Handling |
|-|-|-|
| **Manual (agent tool)** | LLM calls the skill's own tool (one tool per skill — see below) | Tool handler emits `skill/invoke` event → dispatcher → worker → result returned to the LLM |
| **Cron** | Inngest cron, one per scheduled skill | Dispatcher → worker. Result handled by skill itself (posts to channel, writes memory, etc.) |
| **Event-driven** (future) | Inngest event subscription | Same path as cron |

Manual invocations are synchronous from the LLM's perspective — tool result returned before the next turn. Cron invocations are fire-and-forget; skill output is whatever side effects the skill itself emits.

### One tool per skill

Each registered skill appears as its own entry in the LLM's tool list — the skill's `name` is the tool name, its `description` from `SKILL.md` is the tool description, its `inputs` schema is the tool's JSON Schema. No generic `invoke_skill` wrapper. This is what makes progressive disclosure work: the LLM sees `summarize_email` directly with its one-line description and knows to call it.

**Dynamic tool list per turn.** The orchestrator rebuilds the tool list at the start of each turn from `SkillRunner.list()`. Skills that registered since the last turn appear automatically; `/disable`d or rolled-back skills disappear. Same dynamism that already exists for the built-in tool registry — just driven by the DB state rather than a static module.

**Concrete shape:**

```typescript
// orchestrator, per turn
async function buildToolList(): Promise<ToolSpec[]> {
  const builtIn = [...coreTools, ...webTools, ...imageTools];
  const skills = await skillRunner.list();  // DB read, live + enabled skills
  const skillTools = skills.map((s) => defineTool({
    name: s.name,                            // e.g. "summarize_email"
    description: s.tier1Description,          // from SKILL.md header + `description` field
    schema: s.inputsSchema,                   // parsed from manifest, z-compiled
    handler: async (input) => {
      const result = await skillRunner.invoke({ name: s.name, inputs: input });
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

Layered, most to least aggressive:

1. **Inngest retries** — default `retries: 3` with exponential backoff. Catches transient failures (network blips, rate limits).
2. **Final-failure notification** — after retries exhausted, `skill_runs.status = 'error'` + emit `skill/failed` event. A listener sends a Telegram message: *"skill `X` failed: `<short error>`. Last success: `<timestamp>`."*
3. **Auto-disable after K consecutive failures** — on the Kth consecutive error (default K=3), set `skills.disabled = true`, send a single follow-up notification: *"skill `X` disabled after 3 failures. /enable X to retry or /rollback X to prior SHA."* No further runs until the user acts.
4. **Manual recovery** — `/enable <name>` resumes; `/rollback <name>` reverts `skills.git_sha` to the prior deploy.
5. **(Future, stage 3+ evolution) Agent-led repair** — on `skill/failed`, spawn an orchestrator run tasked with diagnosing and patching the skill, going through the normal register flow. Deferred until the evolution ladder reaches that stage.

This matches Temporal / Airflow / Lambda-plus-DLQ conventions.

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

`ctx` is a thin Python SDK shipped into every skill worker. Each method is an RPC back to the host over the same stdin/stdout pipe that dispatched the task. This mirrors the TS `Service` pattern used by in-process tools — same shape, projected over a pipe.

### v1 surface

| Method | Purpose |
|-|-|
| `ctx.secrets.get(name)` | Fetch a declared secret value (manifest-gated) |
| `ctx.memory.recall(query, ...)` | Semantic memory search |
| `ctx.memory.remember(content, ...)` | Persist memory |
| `ctx.attachments.upload(data, media_type)` | Upload to `AttachmentStore`, return path |
| `ctx.attachments.download(path)` | Fetch bytes |
| `ctx.files.read(path)` | Read UTF-8 text from per-user workspace (see [File workspace](#file-workspace-confirmed)) |
| `ctx.files.write(path, content)` | Create or overwrite workspace file |
| `ctx.files.list(prefix=None)` | List workspace entries |
| `ctx.llm.complete(prompt, model=...)` | LLM call via Cogmo's provider routing (cost-tracked, provider-fallback, prompt-cache aware) |
| `ctx.now()` | Canonical time (mockable in tests) |
| `ctx.user` | User identity object — `id`, `timezone`, `email` where available |
| `ctx.notify(channel, message)` | Send a message to the user via their preferred channel (Telegram in v1) |
| `ctx.log.info(msg, **fields)` | Structured logging to `skill_runs.logs` |

Every RPC: validates against the skill's manifest (allowlists, permission scopes) → executes → logs to `skill_context_calls` → returns a result or raises a typed Python exception.

### Not in v1 (deferred with the reason)

| Method | Why deferred |
|-|-|
| `ctx.http.*` (mediated HTTP) | Skills use `httpx` / `requests` directly. Wrapping costs ergonomics for marginal gain; revisit if rate-limiting or universal logging becomes a need. |
| `ctx.metrics.*` | Over-engineering at personal scale. `ctx.log` covers most visibility needs. |
| `ctx.skills.invoke(other_skill, ...)` | No inter-skill composition in v1 (see below). |
| `ctx.schedule(when, event)` | Scheduling handled externally via Inngest cron declared in `SKILL.md`. |

### File workspace `[confirmed]`

Skills share files across invocations through a per-user workspace exposed as `ctx.files`. This is the v1 mechanism for skill-to-skill state — one skill writes `notes/draft.md`, the next polishes it. Backed by the same S3-backed `service.files` store the agent's in-process `read_file` / `write_file` / `list_files` tools use, so the LLM and skills see one workspace.

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

Paths are logical (`notes/meeting.md`). The host enforces ACL — a skill cannot escape its user's prefix. The 100 KB read cap on `ctx.files.read` (matching the agent's `read_file` tool) is an LLM-output guardrail — its job is preventing a 50 MB string from landing in a tool result the LLM will then re-include in its context. POSIX `open()` does NOT inherit this cap and is bounded only by the substrate (Pyodide MEMFS by worker memory, sysbox tmpfs by mount size, Daytona Volume by quota); skills that need to materialise a large file end-to-end should use POSIX. Writes have no explicit cap on either path (bounded by S3 object limits).

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

- **JSPI in Pyodide.** Pyodide's filesystem hooks remain synchronous in 0.28.x; [#5720](https://github.com/pyodide/pyodide/discussions/5720) tracks moving FS to JSPI. When that lands AND Node ships JSPI default-on, the WASM tier could swap MEMFS staging for an async-FS adapter that resolves stdlib `open()` directly through `Service["files"]`. The `TierFs` interface is the swap point — skill code never changes.
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

Between tasks, the worker's Python process may still hold a previous task's fetched secret in GC-reachable memory until module cleanup runs. Bounded but not zero.

Accepted at personal scale because skills are Cogmo-authored and reviewed. Upgrade paths if the threat model changes:

- **Worker-per-skill-identity** — pool keyed by `(tier, skill_name)`. Skill X and Y never share a worker.
- **Recycle every task** — pays full import cost per invocation.
- **microVM per task** — full cleanup, highest overhead.

### Egress-proxy substitution `[research]` (future)

Pull model lets the skill see real secret values. A malicious skill can exfil its own declared secrets to an attacker endpoint — human review at merge is the defense, not runtime isolation.

Future upgrade: the skill only ever sees an opaque placeholder (UUID); Cogmo runs an egress HTTP proxy that intercepts outbound calls, validates the destination matches the secret's declared binding, and substitutes the placeholder for the real token on the way out.

```yaml
# SKILL.md
secrets:
  - name: slack_webhook
    binding:
      destination: "https://hooks.slack.com/services/*"
      substitute: url         # token is embedded in the URL path
  - name: github_token
    binding:
      destination: "https://api.github.com/*"
      substitute: "header:Authorization: Bearer {{value}}"
```

```python
webhook = ctx.secrets.get("slack_webhook")
# returns "cogmo-secret://abc-123-uuid" — an opaque placeholder
httpx.post(webhook, json={"text": "hi"})
# egress proxy sees the placeholder, validates destination matches
# slack.com, substitutes the real URL, forwards upstream
```

**What this buys:**

- Skill never has access to the real secret value, even in memory.
- Binding enforces "this secret can only reach `*.slack.com`" — skill can't redirect it to `attacker.com`.
- Every substitution audited at egress.

**Open implementation questions:**

- **URL-based vs header-based substitution** — URL-based (Slack webhooks, PATs in URL) is plaintext-substitutable, no TLS termination needed. Header-based (`Authorization: Bearer ...`) needs either MITM (skill worker trusts a Cogmo-issued CA) or a reverse-proxy model (skill calls `https://cogmo-proxy/bindings/github` and the proxy forwards upstream with real auth).
- **Non-HTTP protocols** (raw sockets, DB drivers, gRPC with bespoke auth) — fall back to pull model for those bindings.
- **Long-lived connections** (WebSockets, SSE) — substitution on connection setup only; can't modify payloads in flight without full termination.

Deferred until (a) trust boundary widens (third-party or remote-triggered skills), or (b) a skill handles a credential class that should be sandbox-invisible by policy (user financial tokens, PII-bearing credentials).

## Data model `[proposed]`

Owned by `src/skills/store/`.

```sql
CREATE TYPE skill_tier AS ENUM ('wasm', 'container');
CREATE TYPE skill_risk_tier AS ENUM ('auto', 'notify', 'approve');
CREATE TYPE skill_run_status AS ENUM ('running', 'success', 'error');
CREATE TYPE skill_run_trigger AS ENUM ('manual', 'cron', 'event');
CREATE TYPE skill_deploy_status AS ENUM ('pending_approval', 'approved', 'denied', 'live', 'rolled_back');

skills (
  id          UUID v7 PK,
  name        TEXT NOT NULL UNIQUE,        -- matches dir name
  tier        skill_tier NOT NULL,
  risk_tier   skill_risk_tier NOT NULL,    -- computed by classifier at deploy
  effects     JSONB NOT NULL,              -- SkillEffectsSchema (declared effects list)
  schedule    TEXT,                        -- nullable: cron expression; null = not scheduled
  git_sha     TEXT NOT NULL,               -- commit hash of current live version
  inputs      JSONB NOT NULL,              -- SkillIoSchema (opaque JSON Schema — see Manifest)
  outputs     JSONB,                       -- nullable: side-effect-only skills have no structured output. SkillIoSchema when present.
  disabled    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)

skill_deploys (
  id              UUID v7 PK,
  skill_id        UUID NOT NULL REFERENCES skills(id),
  git_sha         TEXT NOT NULL,           -- commit being deployed
  prior_git_sha   TEXT,                    -- nullable: null for first deploy; used for rollback
  risk_tier       skill_risk_tier NOT NULL,
  status          skill_deploy_status NOT NULL,
  approved_by     UUID REFERENCES user_identities(id),  -- nullable: null for auto/notify-tier (no human approval); set only when a human clicks Approve on approve-tier
  classifier_log  JSONB NOT NULL,          -- ClassifierLogSchema (classifier output + static analysis findings)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ              -- nullable: set when status transitions to live / denied / rolled_back
)

skill_runs (
  id          UUID v7 PK,
  skill_id    UUID NOT NULL REFERENCES skills(id),
  trigger     skill_run_trigger NOT NULL,
  inputs      JSONB NOT NULL,              -- SkillInvocationInputsSchema (matches skill's declared input JSON Schema at invoke time; Zod layer is pass-through)
  status      skill_run_status NOT NULL,
  output      JSONB,                       -- nullable: null on error. SkillInvocationOutputSchema when present (matches skill's declared output JSON Schema).
  error       TEXT,                        -- nullable: null on success
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ                  -- nullable: null while running
)

skill_context_calls (
  id         UUID v7 PK,
  run_id     UUID NOT NULL REFERENCES skill_runs(id),
  method     TEXT NOT NULL,                -- 'secrets.get' | 'memory.recall' | ...
  target     TEXT,                         -- nullable: the method's target (secret name, memory bank) — some ctx methods take no target (e.g. now()). NEVER the value.
  ok         BOOLEAN NOT NULL,
  error      TEXT,                         -- nullable: null on success
  called_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

`skills` is derived state — authoritative source is the git repo. Row synced from `SKILL.md` on deploy. `skill_runs` is append-only audit trail. `skill_context_calls` records every `ctx.*` RPC from the worker, scoped to a run — secret names and memory-bank names only, never values.

**JSONB schemas validated at the store boundary** (per CLAUDE.md — every JSONB column has a Zod schema parsed on read and write):

- `skills.inputs` / `skills.outputs` — `SkillIoSchema = z.record(z.unknown())`. Opaque at the Zod layer; the actual JSON Schema is enforced against task inputs/outputs at invoke time via `ajv`, not at the store boundary.
- `skills.effects` — `SkillEffectsSchema = z.array(z.enum(SKILL_EFFECTS))`.
- `skill_deploys.classifier_log` — `ClassifierLogSchema = z.object({ risk_tier, declared_effects, detected_effects, declared_secrets, validation_errors, classifier_version })`. Fully Cogmo-controlled, fully schema'd.
- `skill_runs.inputs` / `skill_runs.output` — `SkillInvocationInputsSchema` / `SkillInvocationOutputSchema`. Pass-through `z.unknown()` wrappers at the store layer; the per-skill schema is whatever the skill declared in its manifest and is validated at invoke (the store just needs "valid JSON").

## Module structure `[proposed]`

```text
src/skills/
  index.ts            — public SkillRunner interface, factory
  runner.ts           — Dispatcher + Pool coordination
  pool.ts             — worker lifecycle, state tracking
  worker-wasm.ts      — Pyodide isolate management
  worker-container.ts — sysbox container spawn (via Sandbox interface)
  protocol.ts         — JSON-RPC framing
  sync.ts             — git → DB sync on deploy
  store/
    schema.ts         — skills, skill_runs tables
    index.ts          — SkillStore interface + Drizzle impl
```

Public interface (canonical — see [Where the classifier runs](#where-the-classifier-runs) for the full RPC contract):

```typescript
interface SkillRunner {
  register(opts: { branch: string }): Promise<RegisterResult>;
  approveDeploy(opts: { pendingId: string }): Promise<RegisterResult>;
  denyDeploy(opts: { pendingId: string; reason?: string }): Promise<void>;
  rollback(opts: { name: string; toGitSha?: string }): Promise<RegisterResult>;
  deregister(opts: { name: string }): Promise<void>;
  list(): Promise<readonly SkillRow[]>;
  invoke(opts: { name: string; inputs: unknown }): Promise<SkillRunResult>;
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
| Review model | Risk-tiered auto-apply (`auto` / `notify` / `approve`) | Review-everything is friction. Classifier makes the "what's safe to auto-apply" function explicit; matches evolution graduation model and integrations.md permission tiers. |
| Classifier execution | Branch + `register` RPC | No repo-watching. Branch ≠ deploy. Atomic, synchronous, authoritative. Pre-commit hook deferred unless ~30s feedback lag becomes painful. |
| Who advances `main` | Only Cogmo's `register` RPC | Pre-receive hook rejects direct pushes to `main`. Makes "live on main" atomic with "classified and approved"; collapses transient "committed-but-rejected" states; structurally prevents force push. |
| Concurrency on register | Advisory lock + pending-deploy check | `pg_advisory_xact_lock` per skill name serializes concurrent registers. Refuse if a pending-approval deploy exists. Idempotent for no-op SHAs. Standard DB-backed state-machine pattern. |
| LLM tool surface | One tool per skill (dynamic per-turn tool list) | Matches progressive disclosure — skills appear in the tool list with their own name + description. No `invoke_skill` wrapper (would break discovery). Orchestrator rebuilds tool list each turn from `SkillRunner.list()`. |
| Manifest | Single `SkillManifestSchema` (Zod) parsed from `SKILL.md` frontmatter | Four consumers read it: register RPC, classifier, dispatcher, tool registrar. One schema prevents field drift. Superset of Anthropic SKILL.md. |
| State reset | Subinterpreter per task (3.13+), per-skill `recycle` opt-out | Fresh interpreter ≈ no state leakage, ~50ms. Opt-out handles C-extension hostile libraries. Flip default to `recycle` system-wide if widespread breakage. |
| Skill discovery | Progressive disclosure (SKILL.md) | Matches Anthropic standard. At <50 skills, tool list stays manageable. Retrieval (`search_skills`) added later when tool-list tokens or selection accuracy forces it. |
| Resource budgets | Declared in SKILL.md; cgroup slice (container) / V8 isolate limits (WASM) | Container tier reuses sandbox.md cgroup parent. WASM uses host-side timer + isolate memory cap. Per-skill override within tier hard ceilings. |
| Cost tracking | Wall-clock + peak memory + LLM tokens via `ctx.llm` + declared `cost_per_call_usd` | Measured per `skill_run`. Dispatcher enforces daily/monthly budget from SKILL.md. `auto` tier requires zero paid surface. |
| Cron failure handling | Inngest retries → final-failure notify → auto-disable after 3 consecutive | Standard Temporal/Airflow pattern. Agent-led repair deferred to evolution stage 3+. |
| Inter-skill composition | Not in v1; future via `ctx.skills.invoke()` through orchestrator | Agent composes at LLM level. Direct skill imports rejected — break permission scoping. |
| `ctx` v1 surface | secrets, memory, attachments, llm, now, user, notify, log | Eight methods cover what skills actually need. HTTP wrapping, metrics, composition, scheduling deferred. |
| Invocation | Inngest events | Durable execution, retry, scheduling — all free. Matches existing orchestration pattern. |
| Output delivery | JSON via tool result; binaries via `AttachmentStore` | Same pattern as `generate_image`. |
| Skill metadata | `SKILL.md` frontmatter | Matches Anthropic's progressive-disclosure standard, already referenced in [integrations.md](integrations.md). |
| Host access | `ctx` object projected over JSON-RPC | Mirrors TS `Service` pattern for tools — same shape, over a pipe. Covers secrets, memory, attachments uniformly. |
| Secrets access | Pull model — `ctx.secrets.get(name)` gated by manifest allowlist | Materializes secrets only at point of use; per-access audit; zero-touch rotation. Reads naturally in Python. |
| Secrets storage | Existing encrypted `secrets` table (per [infrastructure.md](infrastructure.md)) | Cogmo already has a minimal self-hosted vault. No external service at personal scale. |
| Egress-proxy substitution | Deferred (`[research]`) | Adds sandbox-invisible secrets via placeholder + egress proxy that validates destination and substitutes. Earns complexity only when trust boundary widens. |

## Open questions

Calibration-grade — settle during real usage, not before implementation:

- **Risk classifier thresholds** — starting boundary between `notify` and `approve` is a first pass. Relax or tighten based on observed false positives / actual incidents.
- **Pool sizing** — `min=0 / max=3`, replace every 500 tasks, 30 min idle shutdown are starting values. `min` and `idleShutdownMs` are operator-tunable via `COGMO_SKILLS_POOL_MIN` / `COGMO_SKILLS_POOL_IDLE_SHUTDOWN_MS` (see Warm pool). Tune on real workload.
- **Subinterpreter ecosystem** — track which C extensions need `isolation: recycle`. If the list grows large, flip default.
- **Skill testing story** — `test.py` is mentioned but not specified. Required at deploy? Optional? What runner? Settle when first non-trivial skill ships.
- **Retrieval-layer trigger** — when to add `search_skills()` (tool-list tokens > ~5k? selection accuracy drop?). Add metric first; threshold later.
