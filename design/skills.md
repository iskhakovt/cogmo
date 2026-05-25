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

**Local bare repo + synchronized remote, user-owned.** Shape:

```text
$COGMO_SKILLS_PATH/                # default /var/lib/cogmo/skills (configurable)
  HEAD                             # symbolic-ref → refs/heads/main
  hooks/
  objects/
  refs/                            # bare repo — no working tree
```

- Path configured via env var or `settings.local.json`.
- Cogmo initializes the bare repo on first boot if the path doesn't exist; `HEAD = refs/heads/main` and the `pre-receive` hook are reconciled on every boot so upgrades take effect.
- **A remote is required.** Any user-owned git URL (private GitHub repo, self-hosted Gitea, Forgejo, etc.) works — Cogmo treats `coding_repos.remote_url` as opaque transport material. Setup collects the URL via one of three operator choices:
  - **Use my own remote** — operator pastes a pre-created URL they've granted Cogmo's credentials access to. Validated via `git ls-remote` before persisting.
  - **Auto-provision on GitHub** — Cogmo calls `octokit.repos.createForAuthenticatedUser({ name: "cogmo-skills", private: true, auto_init: true })` and attaches the result as origin. Only available when a GitHub identity is already configured; gated to that one provider because the convenience lives in the wizard only — no permanent provider-specific surface.
  - **Skip** — defer configuration. `delegate_coding({ repo: "skills" })` fails with a clear message until the standalone `cogmo migrate-skills-remote` CLI is run.
- The local bare repo is **authoritative** for `register` (`update-ref` writes happen here, atomically). The remote is a synchronized mirror — every successful `register` immediately pushes the new `main` SHA to the remote, so a Daytona sandbox cloning from the remote always sees the latest skill set within the latency of one push.
- Coding delegation operates on this repo exactly like it operates on user-registered repos — feature-branch flow over the same [sandbox.md](sandbox.md) + [coding-delegation.md](coding-delegation.md) infrastructure. The skills repo's only specialness is the post-`register` push-to-remote step.

**Why local-authoritative with synchronized remote (rather than remote-authoritative):**
- Filesystem `update-ref` is atomic and provider-agnostic. Routing `register` through a provider API (`octokit.git.updateRef`, Gitea API equivalent) would couple Cogmo to per-forge clients for the one operation we most want to keep crisp.
- A network blip during the post-`register` push degrades to "register succeeded locally, remote sync deferred" — the local DB row and bare repo are consistent; the next `register` or a manual `git push origin main` reconciles. No half-committed states.
- The original v1 design relied on filesystem `update-ref` for atomicity. Keeping that, plus the new push leg, preserves the invariant while unblocking the cloud-sandbox transport.

**Why a remote at all (even for local-Docker bind-mount users):** off-host backup of the agent's skill library. A single-host failure should not erase the operator's accumulated personalisation. The marginal setup cost is one URL during the wizard.

**Provider-agnostic in the steady state:** every code path past setup uses plain `git` — clone, push, fetch — with credentials supplied via the askpass helper. The only provider-specific surfaces are (a) the wizard's optional GitHub auto-provision step and (b) the draft-PR opener (`design/coding-delegation.md` → Draft PR step), which currently knows only GitHub; non-GitHub remotes still receive pushes, with the PR step degrading to "branch pushed, open the PR yourself."

**Why not inside the Cogmo repo:** skills are personal, per-deployment. Committing them to a fork of Cogmo creates merge conflicts on upstream pull, leaks private workflows through misconfigured remotes, and couples release cadences that naturally diverge.

**Why not a single shared `cogmo-skills` repo across users:** personal skills shouldn't sit in a shared public repo. The auto-provision flow creates a *private* repo under the operator's own account — the model is "each operator owns their own `cogmo-skills`," not "Cogmo project hosts a shared one."

**Why no git server in Cogmo:** most commits auto-apply directly to `main` (see risk tiering below), so there's no PR UI to build. Operators bring their own forge (GitHub, Gitea, etc.) — Cogmo doesn't reimplement that surface.

**Bundled base skills:** none initially. Agent bootstraps by authoring skills as needed. If patterns emerge that should ship with Cogmo, promote them to a `base-skills/` directory inside the Cogmo repo in a later iteration.

### Repo invariants

Hard rules enforced on the skills repo:

- **`main` is advanced only by Cogmo's `register` RPC.** Direct pushes to `main` from any other source (agent, human, tool, CI) are rejected unconditionally. Agents work on feature branches; the orchestrator is the sole merger. This makes "classified and live" atomic with "present on `main`" — no transient "committed but rejected" state can exist.

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
    test.py              — optional smoke test
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

**Validation happens in five places — all reading the same schema:**

1. **`register` RPC** — parses manifest, rejects with `errors[]` on schema failure.
2. **Classifier** — reads validated manifest fields (`effects`, `secrets`, `tier`, `dependencies`) to assign risk tier.
3. **Dispatcher** — reads `inputs` schema to validate invocation arguments; reads `resources` to set cgroup/isolate caps; reads `budget` to check cost.
4. **Tool registrar** — reads `description` + `inputs` to build the LLM's per-skill tool entry.
5. **Dependency populator** — reads `dependencies` to verify the committed `requirements.lock` is current; reads it again at first-invoke to populate the venv. See [[Dependencies]].

Single schema, five consumers, zero drift.

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
6. **Verify lockfile.** If `manifest.dependencies` is non-empty, `git show <branch-tip>:requirements.lock` must exist. Spawn a short-lived sandbox session, run `uv pip compile --generate-hashes --no-header` against `manifest.dependencies`, and byte-compare against the committed lockfile. Mismatch → `errors: ["requirements.lock is stale; re-run 'uv pip compile --generate-hashes --no-header' and recommit"]`. Resolver failure → `errors: ["dependency resolution failed: <stderr>"]`. The session is destroyed regardless of outcome. See [[Dependencies]].
7. **Branch by tier:**
   - `auto` / `notify` → `git update-ref refs/heads/main <branch-tip>` (advances main), delete the feature branch, `UPSERT skills` (including `lockfile_hash = sha256(requirements.lock)` or `NULL` if no deps), insert `skill_deploys` with `status = 'live'`. The audit trail lives in `skill_deploys.git_sha` — the branch pointer itself is not the record, so cleanup is unambiguous.
   - `approve` → insert `skill_deploys` with `status = 'pending_approval'`. Branch **stays** until `approveDeploy` / `denyDeploy` resolves the deploy. `main` does not move. Fire Telegram prompt.
   - Validation errors → return `errors[]`, nothing persisted.
8. **Commit** (releases lock). Return result synchronously.

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

Empty `dependencies` is the common case — HTTP-only skills using `urllib` from the stdlib pay no populate cost and skip the venv-overlay activation entirely.

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

The `-py<major>.<minor>` suffix encodes the runtime's Python ABI so an image bump that changes Python minor (e.g. `python:3.14-slim` -> `python:3.15-slim`) routes to a fresh venv: populate writes `<hash>-py3.15/`, supervisor activates the same. The stale `<hash>-py3.14/` orphans cleanly and (on `shared-volume` backends) the reaper sweeps it on the next tick. Host doesn't need to know the image's ABI — populator (`python3 -c "..."`) + supervisor (`sys.version_info`) compute it from the runtime they share.

### Populate

First task using a given lockfile hash populates the venv. Concurrent populators on the same lockfile hash are serialised by `.ready` + `mv -T` rename failure — the marker file plus atomic rename is the synchronisation point; the loser of the race detects `.ready` on the target after its own rename fails and exits success without redundant work. No Postgres advisory lock is used.

```text
0. PY_ABI=$(python3 -c "import sys; print(f'py{sys.version_info.major}.{sys.version_info.minor}')")
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

Failure during steps 2-4 leaves an orphaned `<hash>-py<X.Y>.tmp.<workerId>/` directory. The populate script itself opportunistically sweeps `.tmp.*` entries older than 10 minutes at the top of every populate run — the per-hash reaper (`skill-venvs-reaper` Inngest cron) targets only published `<hash>-py<X.Y>/` directories (sha256 hex + ABI suffix), never in-flight tmp dirs.

`--only-binary=:all:` forbids source distributions by default — sdists require a build toolchain in the sandbox and run arbitrary `setup.py` code at install. A skill declaring a package available only as sdist fails at register. Sdist support is a future opt-in (`allow_sdist: true` in the manifest, automatic `approve` tier) when a real driver appears.

### Activation

Before forking the task child, the supervisor activates the skill venv. The path is constructed from the lockfile hash + the runtime's Python ABI — the populator (running in the same image) produces the same path, so the two agree without coordinating through the host:

```python
py_abi = f"py{sys.version_info.major}.{sys.version_info.minor}"
venv = f"/skill-venvs/{lockfile_hash}-{py_abi}"
os.environ["VIRTUAL_ENV"] = venv
os.environ["PATH"] = f"{venv}/bin:{os.environ['PATH']}"
sys.path[:0] = [f"{venv}/lib/python{sys.version_info[0]}.{sys.version_info[1]}/site-packages"]
```

The supervisor's own venv (`/opt/cogmo-skills/.venv`, where `cogmo_skills_runtime` lives) stays on `sys.path` — the runner needs it to keep serving the dispatcher protocol. The skill venv is *prepended*, so any name collision resolves to the skill's pinned version (`import httpx` → skill's `httpx==0.27.0`, not whatever the runtime happens to bundle). Skill code can technically reach `cogmo_skills_runtime` symbols; that's UX confusion at worst — the real isolation boundary is the sysbox container, not Python module visibility.

A skill with `lockfile_hash IS NULL` (empty `dependencies`) skips activation entirely — the task runs in a child with stdlib visible and nothing else.

### Tier 1 (WASM)

Pyodide consumes the parsed package specs from `requirements.lock` via `micropip.install(specs, keep_going=False)` at worker init. Hashes are dropped — micropip has no `--require-hashes` equivalent; see *Security posture* below for the asymmetry vs the sysbox tier. After install, `importlib.metadata.version(name)` is checked per declared dep and any mismatch (silent skip, bundled-vs-pin drift) raises a fatal init error surfaced as the task's `error`.

Pyodide-incompatible wheels (native extensions outside the [pre-built Pyodide list](https://pyodide.org/en/stable/usage/packages-in-pyodide.html) and not available as pure-Python wheels via `micropip`) fail at register. `src/skills/pyodide-compat.ts` reads `pyodide-lock.json` from the installed pyodide package and verifies each declared `name==version` is either bundled exactly or has a pure-Python wheel on PyPI; mismatches reject the register with `tier1_incompatible_dependency`. Skills depending on native-only wheels must declare `tier: container`.

Worker init (Pyodide load + micropip install + version verify) is capped at 60s by default — a hung micropip resolve against a slow PyPI surfaces as `worker_init_timeout` instead of wedging the worker. A per-lockfile-hash wheel cache for micropip-fetched wheels is deferred — Pyodide's built-in `packageCacheDir` covers the runtime's bundled packages only, so a moderately-deps'd skill re-downloads from PyPI on every worker boot today (todo.md).

### Cache reachability

A `<hash>-py<X.Y>/` directory is reachable iff some `skills` row (enabled or disabled, since disabled skills can re-enable) has `lockfile_hash = <hash>` AND `<X.Y>` matches the reaper sandbox's own Python ABI. The reaper computes `PY_ABI` from its own `sys.version_info` and builds the expected reachable set as `<hash>-$PY_ABI` per row; candidate dirs are compared against that full-name set. Stale ABI variants (e.g. `<hash>-py3.14/` left behind after an image bump to py3.15) don't match the current expected set, so they're unreachable from the current runtime and sweep on the next reaper tick once they age past the 7-day grace window. Same logic reaps legacy bare `<hash>/` dirs left over from before the ABI suffix shipped.

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

> **Precondition: tier-2 skills are mutually trusted code by the operator.** The shared `/skill-venvs` volume is mounted RW on every tier-2 worker under the same UID; any skill can write under `/skill-venvs/<other-hash>-py<X.Y>/` and pre-stage entries the next populator activates. Hash pinning at install time doesn't protect against this because the trivial bypass is `.ready`-pre-staging (creating the marker file + a stub Python layout at the path the populator will check) which skips `uv pip sync` entirely. Cogmo's v1 deployment model is single-operator with operator-authored / operator-audited skills; this section enumerates the threats accepted under that precondition. **Multi-author skill libraries require per-skill UID isolation (or per-hash bind-mount made read-only after publish) before the precondition holds.** See the `[research]` items below for the upgrade path.

- **Hash pinning via `--require-hashes`** is non-optional **on the sysbox tier**. The lockfile carries SHA-256 per wheel; `uv pip sync` refuses to install anything unhashed.
- **WASM-tier dependency install trusts public PyPI without wire integrity verification.** `micropip.install` has no `--require-hashes` equivalent and fetches wheels from PyPI's JSON API over TLS with no per-wheel hash check. A flash-malicious release between register (when uv pinned the resolution) and the first WASM-tier invocation gets installed silently — the lockfile-hash byte-compare at register catches *staleness*, not *integrity at fetch time*. Mitigation today: post-install version verification (catches silent skips and bundled-vs-pin drift) plus narrow classifier tier-bumps for security-relevant deps so anything sensitive lands on `tier: container`. Real closure requires either upstream `micropip --require-hashes` support or a sidecar pre-fetch that hash-verifies wheels and primes the cache before Pyodide opens. `[research]`.
- **`--only-binary=:all:`** forbids sdists by default. Sdists run arbitrary install-time code and need a build toolchain — both are surface the auto tier should not provide.
- **Public PyPI for v1.** Hash pinning makes the index untrusted-but-verified. A private pull-through mirror (Devpi / Bandersnatch) is the obvious next step when (a) the user base widens beyond single-operator or (b) we want quarantine windows on new package versions to catch flash-malicious publishes. `[research]`.
- **PEP 740 / Sigstore attestation verification.** 132k+ packages had attestations by Mar 2026 via PyPI Trusted Publishing. Verification via `pypi-attestations` is "free defense in depth" once the mirror is in place. `[research]`.
- **Shared venv cache assumes mutual trust between skills on the same Cogmo instance** (`shared-volume` backends only). On Local-Docker the `/skill-venvs` volume is mounted RW on every tier-2 worker. A compromised skill running in worker A can pre-stage `/skill-venvs/<hash>/bin/python` + `<hash>/.ready` for a hash it expects skill B to use; B's populate sees `.ready`, skips `uv pip sync` entirely, and activates A's venv. Hash pinning at sync time doesn't help because the sync is bypassed. Single-user / single-author scale absorbs this. Multi-author skill libraries widen the threat boundary — the upgrade path is per-skill identity (process UID per skill, or a per-skill-hash bind-mount made read-only after publish), tracked under `[research]`. `per-sandbox` backends don't share `/skill-venvs/` across workers and the cross-skill pre-stage path doesn't exist there.
- **`COGMO_SKILLS_DEPS_VOLUME` is `shared-volume`-only and multi-instance deployments must override per-deployment.** The default `cogmo-skills-deps-cache` is right for single-tenant single-host installs. Two Cogmos on the same Docker host using the default name share one cache, so the "pre-stage a poisoned `<hash>/.ready`" scenario spans every instance instead of every worker. Multi-instance operators scope per-deployment (`...-staging` / `...-prod`). The variable is silently ignored on `per-sandbox` backends — each sandbox's cache is container-local, so multi-instance cache sharing isn't representable there in the first place. `[research]`.

## Cost tracking `[proposed]`

Two cost surfaces, measured separately:

**Compute** — `skill_runs.resource_usage` JSONB blob (`SkillRunResourceUsageSchema`) carries `wallClockMs` (always set, host-derived from `finishedAt - createdAt`) and `peakMemoryBytes` (nullable). Tier-2 populates `peakMemoryBytes` from `getrusage(RUSAGE_SELF).ru_maxrss * 1024` inside `runner.py` just before emitting `task_result` — Linux `ru_maxrss` is in kilobytes. Tier-1 (Pyodide WASM) leaves `peakMemoryBytes` null because `getrusage` is process-wide and would inflate under concurrent workers; tier-2 synthesised results (wall-clock kill, supervisor watchdog) also leave it null since the synthesised path never sees the child's rusage. Cheap to track, captures almost all "bad skill burned the machine" cases.

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
  id            UUID v7 PK,
  name          TEXT NOT NULL UNIQUE,        -- matches dir name
  tier          skill_tier NOT NULL,
  risk_tier     skill_risk_tier NOT NULL,    -- computed by classifier at deploy
  effects       JSONB NOT NULL,              -- SkillEffectsSchema (declared effects list)
  schedule      TEXT,                        -- nullable: cron expression; null = not scheduled
  git_sha       TEXT NOT NULL,               -- commit hash of current live version
  lockfile_hash TEXT,                        -- nullable: null when manifest.dependencies is empty.
                                             -- sha256(requirements.lock @ git_sha). Drives venv cache
                                             -- key + reachability GC; updated atomically with git_sha.
                                             -- See Dependencies.
  inputs        JSONB NOT NULL,              -- SkillIoSchema (opaque JSON Schema — see Manifest)
  outputs       JSONB,                       -- nullable: side-effect-only skills have no structured output. SkillIoSchema when present.
  disabled      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
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
  id              UUID v7 PK,
  skill_id        UUID NOT NULL REFERENCES skills(id),
  trigger         skill_run_trigger NOT NULL,
  inputs          JSONB NOT NULL,           -- SkillInvocationInputsSchema (matches skill's declared input JSON Schema at invoke time; Zod layer is pass-through)
  status          skill_run_status NOT NULL,
  output          JSONB,                    -- nullable: null on error. SkillInvocationOutputSchema when present (matches skill's declared output JSON Schema).
  error           TEXT,                     -- nullable: null on success
  resource_usage  JSONB,                    -- nullable: SkillRunResourceUsageSchema. { wallClockMs, peakMemoryBytes }. Written at finalisation; null while running.
  idempotency_key TEXT,                     -- nullable: null for one-shot CLI/test invocations. UNIQUE(idempotency_key) — Postgres NULLs-are-not-equal default allows multiple null rows; see Exactly-once invocation.
  recovery_point  skill_run_recovery_point NOT NULL DEFAULT 'started',  -- 'started' | 'executed' | 'finished' — drives the replay branches in runner.invoke.
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ               -- nullable: null while running
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
- `skill_runs.resource_usage` — `SkillRunResourceUsageSchema = z.object({ wallClockMs: z.number().int().nonnegative(), peakMemoryBytes: z.number().int().nonnegative().nullable() })`. Populated at finalisation; null while running. Extensible to CPU / IO / fork counts via Zod-schema additions without a migration.

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

**Recovery branches.** Every `runner.invoke({idempotencyKey})` calls `startOrRecoverRun` first:

| recovered row state | runner action |
|-|-|
| `kind='new'` (no prior row) | Standard flow: execute → executed → finished |
| `recovered`, `recovery_point='finished'` | Return cached `SkillRunResult` reconstructed from the row. Runtime never touched. |
| `recovered`, `recovery_point='executed'` | Skip execute, replay output validation against stored output, transition to `finished`. Persist-failure retries land here. |
| `recovered`, `recovery_point='started'` | In-flight: either the prior attempt crashed mid-execute, or another worker is currently executing this same key. The runner can't tell those apart from the row state alone. Throw `SkillInflightError` — conservative refusal in both cases, since re-executing risks double-firing non-idempotent side effects (and in the concurrent case, the original is still running and will eventually finalize). Operator inspects. Future manifest flag `idempotent_invocation: true` would opt into optimistic re-execute. A heartbeat predicate (`created_at < now() - interval 'N min'`) would let the runner discriminate at runtime; deferred. |

**Caller key conventions** (deterministic per logical fire):

| Caller | Key shape |
|-|-|
| `skill-cron-fire` handler | `skill-cron:${skillId}:${scheduledFor}` — same shape as the event-bus dedup id |
| Agent-loop tool dispatch *(deferred — needs toolUseId plumbed through Service)* | `skill-tool:${conversationId}:${toolUseId}` |
| CLI / one-shot tests | Omit (no retry context) |

**Race safety.** Concurrent attempts with the same key are serialised by the `uniq_skill_runs_idempotency_key` UNIQUE constraint on `skill_runs.idempotency_key`. Postgres's default unique-constraint semantics treat NULLs as not-equal — multiple null-key rows (CLI / tests) coexist freely while non-null keys are constrained to one row. `startOrRecoverRun` uses `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`; the loser of the race gets zero rows back and follows up with `SELECT ... FOR UPDATE` to lock the existing row for its own transition. Plain UNIQUE was chosen over a partial unique index `(idempotency_key) WHERE idempotency_key IS NOT NULL` because both give identical semantics for this case but plain UNIQUE drops the `WHERE` predicate dance from every `ON CONFLICT` site — and from the comments explaining it. ([Postgres docs](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-UNIQUE-CONSTRAINTS) confirm the NULL-not-equal default.)

**Why DB-level over framework-level (Inngest step.run boundaries).** Framework-agnostic — survives engine swaps, works under Inngest today and bare `setTimeout` for CLI runs. Avoids Inngest's `Jsonify<Awaited<T>>` return-type friction. One code path for all callers. Survives crashes the framework can't see (LangGraph's specific critique). See PR #303 review thread and the [decision summary in todo](todo.md).

## Module structure

`src/skills/` is organised by concern. Use `ls src/skills/` for the live file list; the groupings below describe what lives where and why.

| Group | Subdirectory / key entrypoints | Responsibility |
|-|-|-|
| Public interface | `index.ts`, `runner.ts` | `SkillRunner` contract + Dispatcher / Pool coordination across register, approve, rollback, invoke |
| Manifest + classifier | `manifest.ts`, `classifier.ts`, `ast-classifier.ts`, `ast-rules.ts` | `SKILL.md` frontmatter parsing + risk-tier assignment (tree-sitter static analysis) |
| Dependency stack | `deps.ts`, `deps-reaper*.ts`, `pyodide-compat.ts` | Lockfile compile + verify at register, venv populate + activate at invoke, unreachable-venv reaper, tier-1 Pyodide compat check |
| Workers (tier 2) | `worker-sysbox/` | sysbox container host + in-container supervisor + warm pool |
| Workers (tier 1) | `worker-wasm/` | Pyodide isolate host + Node Worker entry + WASM-import lint + bundled `ctx` Python SDK |
| ctx RPC | `dispatcher.ts`, `ctx-handler.ts`, `protocol.ts` | Bi-directional NDJSON-over-stdio routing between worker + host, Zod-validated frames |
| Cron scheduler | `cron-ticker.ts`, `cron-fire-handler.ts` | Per-minute Inngest tick + per-skill cron invocation |
| Git plumbing | `git-ops.ts`, `repo.ts` | Bare-repo bootstrap, remote configuration, plumbing wrappers |
| Operator CLI | `cli.ts`, `configure-remote*.ts`, `migrations-cli.ts` | `cogmo skill ...` subcommands + bare-repo schema migrations |
| Agent surface | `skills-tool.ts`, `skills-service.ts`, `skill-tool-builder.ts`, `skills-keyboard.ts` | Per-turn tool list registration, per-conversation service, Anthropic SDK descriptor build, Telegram approve/deny keyboard |
| Store | `store/` | DB schema + `SkillStore` interface (`skills`, `skill_deploys`, `skill_runs`, `skill_context_calls` tables) |

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
| Manifest | Single `SkillManifestSchema` (Zod) parsed from `SKILL.md` frontmatter | Five consumers read it: register RPC, classifier, dependency populator, dispatcher, tool registrar. One schema prevents field drift. Superset of Anthropic SKILL.md. |
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
- **Skill testing story** — `test.py` is mentioned but not specified. Required at deploy? Optional? What runner? Settle when first non-trivial skill ships.
- **Retrieval-layer trigger** — when to add `search_skills()` (tool-list tokens > ~5k? selection accuracy drop?). Add metric first; threshold later.
