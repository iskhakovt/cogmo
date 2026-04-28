# Coding Delegation

Cogmo delegates heavy coding tasks to Claude Code and Codex CLI, leveraging the user's existing Max/Pro/Plus subscriptions as the execution backend. Telegram is the control plane. Cogmo handles planning, gating, progress reporting, and review; the CLIs do the actual work.

## Purpose `[proposed]`

Enable flows like:

> *[Telegram]* "Please refactor the steering rules module to support per-channel scoping; run the integration tests; open a draft PR."

Cogmo:

1. Creates a sandboxed task container (worktree, git identity, tools).
2. Runs `claude -p` in plan mode first; posts the plan to Telegram with Approve / Revise / Cancel buttons (user-initiated tasks; automated triggers skip this gate).
3. On approval, executes the plan. Dangerous tool calls route to Telegram as approve/deny prompts via the stream-json permission channel (see *Autonomy Gates → Tool gate*).
4. Verifies (typecheck, lint, tests), commits, pushes, opens a draft PR.
5. Sends the PR URL to Telegram for final review.

Scope explicitly *not* in this doc: writing code inline in the agent's own responses. That's what the existing `files` capability in `Service` covers. This doc is about **delegating multi-step coding work to a specialized subprocess** that can run commands, install deps, execute tests.

## Execution Model `[confirmed]`

**Subprocess-wrap the user's logged-in CLIs.** No API keys, no Agent SDK. This is the sanctioned personal-use path.

| Backend | Invocation (shape) | Auth |
|-|-|-|
| Claude Code | `claude -p --output-format stream-json --include-partial-messages --input-format stream-json --permission-mode {plan,acceptEdits} [--resume <sid>] [--session-id <uuid>]` | User's Max/Pro subscription via existing login |
| Codex CLI | `codex exec resume <sid> --json` (or `codex exec resume --last --json`) — `resume` is a subcommand and must precede `--json` | User's ChatGPT Plus/Pro login |

Flag set is illustrative — pin and verify against the exact `claude` / `codex` versions baked into `cogmo/devbase`. Both CLIs evolve their flags quickly; the `CodingBackend` impl treats the argv vector as a versioned contract keyed on the image tag.

The Agent SDK explicitly requires API keys and **cannot use subscription auth** — confirmed behaviour, intentional boundary from Anthropic. Subprocess-of-the-CLI is the only path that honours the subscription. Personal single-user is the sanctioned use; Cogmo runs on the user's own host.

Output is parsed as JSONL. Both CLIs emit structured events (`system/init`, `stream_event` with `text_delta`, tool-use, `turn.completed` with tokens). Cogmo streams these as progress updates to Telegram.

`session_id` is captured on the first event and persisted in `coding_tasks.session_id`. Resume uses `--resume <sid>` (Claude) or the `resume` subcommand (Codex) — carries full conversation state across Cogmo restarts or multi-turn task flows.

## Backend Interface `[confirmed]` (slice 2 — `plan()` + `execute()`; `resume()` is implicit via `execute(ctx, sessionId)`)

Shared abstraction over both CLIs, lives in `src/agent/coding/`:

```typescript
interface CodingBackend {
  plan(ctx: BackendCallContext): AsyncIterable<CodingEvent>;
  execute(ctx: BackendCallContext, sessionId: string): AsyncIterable<CodingEvent>;
}

type CodingEvent =
  | { kind: "session_started"; sessionId: string }
  | { kind: "text_delta"; text: string }
  | { kind: "tool_call"; tool: string; input: unknown }
  | { kind: "tool_result"; tool: string; ok: boolean; summary?: string }
  | { kind: "permission_request"; tool: string; input: unknown; requestId: string }
  | { kind: "plan_ready"; plan: string }
  | { kind: "complete"; exitCode: number; usage?: BackendUsage; isError: boolean };
```

Two concrete impls: `ClaudeCodeBackend` (slices 1+2), `CodexBackend` (later). Selection per-task via `coding_tasks.backend`. `execute(ctx, sessionId)` resumes a prior session via `claude --resume <sid> --permission-mode acceptEdits` — there is no separate `resume()` method; both subcommands take the same flags. `permission_request` is reserved for slice 3 when the stream-json gate ships.

## Prompt Construction `[proposed]`

What Cogmo actually *tells* the CLI. The prompt is first-class — it governs how the CLI behaves on its own initiative (verifying, fixing, summarizing), how it interacts with the target repo's conventions, and what stays out of its hands (credentials, PR opening, tool policy).

### Skeleton

One template per phase (`plan`, `execute`, `resume`). Concrete for `execute`:

```md
# Task
<goal from coding_tasks.goal>

# Environment
- Repo root is /workspace. Stay inside it.
- Current branch: <branch>. Already created and checked out.
- Git credentials are available via credential helper; pushing requires your action.
- Do NOT open a PR. Cogmo opens the PR after verifying your work.

# Verify before declaring done
Run: <coding_repos.verify_command>
If it fails, fix what broke and rerun. Iterate until it passes or you conclude you're stuck.
If stuck, stop and explain what you tried, what's failing, and why — do NOT mark the task complete.

# Budget
Aim to finish within ~<task_token_budget> tokens. If you're running long, narrow scope rather than abandon verification.

# When finished
Produce a short summary under the heading "## Summary" describing what changed and why — Cogmo uses this verbatim in the PR body.
You may commit incrementally as you work. Do NOT push.
```

`plan` differs only in the final block: emit a `## Plan` section, no edits, await approval. `resume` injects the approved plan text and drops the `# Task` block (session already has it from the earlier turn).

Repo conventions are **not** inlined in the prompt — Claude Code's native memory system loads them (see *Injected context* below), which is tier-aware and handles size/precedence correctly without us re-implementing those concerns.

### Self-verify clause

This is the retry policy — resolved, was previously an open question.

**Cogmo does not operate a retry loop around the CLI.** The CLI's own agent loop already handles edit → test → fix iteration; that's what it's good at. Re-invoking it externally to "retry" is just the same loop at a more expensive layer.

Instead, three things replace the retry loop:

1. **The self-verify clause above** — tells the CLI to run the verify command itself and iterate until passing or stuck.
2. **Budget caps on `coding_repos`** (see schema update) — `task_token_budget` and `task_wall_time_seconds`. Cogmo kills the task subprocess if either is exceeded. Backstop against infinite loops. **Enforcement boundary:** Cogmo aggregates input+output tokens from each `turn.completed` event as the JSONL stream flows back; after each turn, if the running total is over budget, Cogmo sends `SIGTERM` between turns (never mid-turn — we never cut off a partial response that the CLI would retry in a loop). `task_wall_time_seconds` is enforced the same way by the streaming loop's wall-clock check on each event batch.
3. **Post-hoc verify** — after the CLI declares done, Cogmo runs the verify command *once more* from outside the session. Trust but verify. If it passes, push and open the draft PR. If it fails, mark task failed and notify the user — no feedback-loop retry. The CLI had its chance during its own loop; a post-hoc miss is a "stuck" signal worth a human eye, not more tokens.

Flakiness is not handled specially. A flaky test that fails only on the post-hoc run surfaces to the user as a failed task with a link to the worktree — they rerun and merge if it's spurious.

### Injected context

Claude Code has a memory system that `-p` mode loads identically to interactive mode ([official docs: Memory](https://docs.claude.com/en/docs/claude-code/memory)). We populate it rather than re-implement prompt-level injection.

**Loading behaviour, per the official docs.** Claude Code discovers memory files across several tiers and **concatenates all of them into the system context** — none of the tiers overrides or replaces another at the file-loading level. The tiers we care about, with exact paths on Linux (our deployment target):

| Tier | Path (inside task container) | Owner | Purpose in our design |
|-|-|-|-|
| **Managed policy** | `/etc/claude-code/CLAUDE.md` | Baked into `cogmo/devbase` image — immutable from the worktree's perspective | Cogmo invariants (e.g., "never force-push", "never open a PR — Cogmo does that"), plus explicit text asking Claude to treat this file's guidance as authoritative when conflicts arise with `/workspace/CLAUDE.md`. |
| **User-global** | `~/.claude/CLAUDE.md` | Cogmo writes at task start, inside the per-task home volume | Task-runner guidance — verify-command surface, workflow expectations, "commit incrementally, don't push" |
| **Project** | `/workspace/CLAUDE.md` | Target repo owns it | Repo's authored conventions. Cogmo does not read, parse, or re-inject — Claude Code loads it natively |

We do **not** populate `CLAUDE.local.md` variants; those are for personal, gitignored overrides and don't fit Cogmo's task-scoped delivery model.

**What "precedence" means here — being precise about the enforcement level.** All tiers concatenate into Claude Code's context; there is **no CLI-level or runtime mechanism that blocks, overrides, or silences `/workspace/CLAUDE.md`**. What we have are two distinct properties composing into an effective precedence:

1. **Immutability at the image layer.** `/etc/claude-code/CLAUDE.md` is a file in the `cogmo/devbase` image. The repo's worktree is bind-mounted at `/workspace` and has no write path to `/etc/claude-code/`. An adversarial repo cannot delete or modify the managed-policy file; it can only attempt to contradict it via its own `/workspace/CLAUDE.md` content.
2. **LLM-level authority resolution.** When the managed-policy content and the repo content conflict, the managed-policy file contains explicit text telling Claude to treat its guidance as authoritative. Claude follows that because it follows instructions, not because any runtime enforces it. If Claude were to be jailbroken or otherwise persuaded by the repo's content, the managed-policy text would lose.

So the practical guarantee is **"managed policy cannot be removed, and Claude is instructed to let it win on conflict"** — not "managed policy is hard-enforced." This is enough because (a) the repo owner is the person who registered the repo with Cogmo in the first place (trust boundary is human, not technical), and (b) the sandbox + draft-PR gate contain blast radius even if the instruction-following fails.

A prose "repo guidance is advisory" disclaimer in our prompt would add nothing on top of this — it would only repeat what the managed-policy file already says, and Claude already reads.

**Size limits.** Claude Code handles loading and budgeting; we do not truncate or validate tier contents. The `/memory` command (interactive only) is the human-facing inspection tool; `-p` mode does not expose it.

**Audit.** At task start, Cogmo `stat`s the three paths and stamps the byte sizes onto `coding_tasks.resource_usage` under `memory_bytes: { managed, user, project }`. Post-hoc diagnosis if a task misbehaves can cross-reference the recorded sizes with the task's session transcript.

**Coding-scoped steering rules.** Layered into the user-global tier at task start — `steering_rules WHERE profile_id IN (<coding-profile-id>)` renders into `~/.claude/CLAUDE.md` alongside the task-runner template. P2 phase (hard-coded template fills in P1).

### Per-backend shaping

Each `CodingBackend` impl owns the final serialization. Claude Code prefers structured markdown headers (shown above). Codex prefers terse bullet-style instruction. The skeleton's *content* is identical; only the formatting differs. Handled inside `ClaudeCodeBackend.buildPrompt()` / `CodexBackend.buildPrompt()`.

### What stays out of the prompt

- **Credentials.** Never in prompt text. Git sees them via `GIT_ASKPASS` only.
- **Tool-policy details.** The stream-json gate enforces; the prompt doesn't need to re-describe what's blocked.
- **Absolute host paths.** The container always sees `/workspace`; host paths leak implementation detail.
- **Session id / task id.** CLI manages its own session identity. Cogmo's DB id is not the CLI's business.
- **Cogmo architecture.** The CLI is editing a repo, not learning about its caller.

### Interaction with steering rules

Coding delegation introduces two new profiles in the existing `profiles` table: `coding-claude` and `coding-codex`. Each has the skeleton above as its base prompt. `steering_rules` rows scoped to these profiles layer on top via the existing `DefaultPromptSource` assembly pipeline.

Concrete payoff: when Stage 1 evolution observes a correction during a coding task ("don't ever modify lockfiles without re-running install"), the correction graduates into a `steering_rules` row scoped to `coding-claude` (or global, if the extraction LLM judges it cross-profile). Next task picks it up automatically. Same mechanism as conversational steering, no new pipeline.

Wiring this into `DefaultPromptSource` is P2 — P1 prompts are hardcoded templates with runtime slot fills.

## Task Model `[confirmed]` (slice 1 — `coding_repos` + `coding_tasks` with the slice-1 column set; `conversation_id` added to track triggering conversation)

**One coding task = one git worktree + one branch + one CLI session + one draft PR.** The task container from [sandbox.md](sandbox.md) is the execution environment; the worktree lives inside it (mounted from the host's worktree path).

```sql
-- Enumerated types (Drizzle pgEnum in the store schema)
CREATE TYPE coding_backend AS ENUM ('claude', 'codex');
CREATE TYPE coding_trigger_source AS ENUM ('user', 'evolution', 'signal_pipeline');
-- Naming convention: `awaiting_X` = waiting on a human gate;
-- `pending_X` = automatic transient (queued for the orchestrator, no human in the loop).
CREATE TYPE coding_task_status AS ENUM (
  'queued', 'planning', 'awaiting_approval', 'executing',
  'pending_verify', 'verifying', 'pushed', 'pr_open', 'failed', 'cancelled'
);

coding_tasks (
  id                      UUID v7 PK,
  repo_id                 UUID NOT NULL REFERENCES coding_repos(id),
  conversation_id         UUID,                                   -- triggering conversation; null for automated triggers (evolution, signal_pipeline). Not declared as an FK across module boundaries.
  goal                    TEXT NOT NULL,                          -- the task description (user-authored or machine-authored)
  trigger_source          coding_trigger_source NOT NULL,         -- determines gating (plan approval path)
  trigger_ref             TEXT,                                   -- optional pointer into the originating subsystem (evolution proposal id, signal batch id)
  backend                 coding_backend NOT NULL,
  worktree_assignment     JSONB,                                  -- WorktreeAssignmentSchema = { branch, worktreePath }; null until allocate-worktree step runs. Atomic by Zod-on-read-and-write — no half-allocated state.
  session_id              TEXT,                                   -- CLI session for resume
  container_id            UUID REFERENCES containers(id),         -- sandbox.md
  allow_privileged_runc   BOOLEAN NOT NULL,                       -- compat escape hatch; explicit at insert (no default)
  plan                    TEXT,                                   -- set after plan phase
  plan_approved_at        TIMESTAMPTZ,                            -- null for automated triggers (plan gate skipped)
  pr_url                  TEXT,
  status                  coding_task_status NOT NULL,
  failure_reason          TEXT,
  resource_usage          JSONB,                                  -- ResourceUsageSchema; nullable = no stats poll yet; populated by sandbox aggregator from turn.completed events
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
)

coding_repos (
  id                      UUID v7 PK,
  name                    TEXT NOT NULL UNIQUE,                   -- 'cogmo', 'notes'
  local_path              TEXT NOT NULL,                          -- host path to the git clone
  default_branch          TEXT NOT NULL,                          -- usually 'main'
  remote_url              TEXT NOT NULL,                          -- for push
  devcontainer            JSONB,                                  -- DevcontainerSpecSchema (subset of the upstream devcontainer.json schema we actually parse); null = use cogmo/devbase
  allowed_backends        coding_backend[] NOT NULL,              -- which CLIs can work on this repo
  verify_command          TEXT NOT NULL,                          -- shell command run via `bash -lc` inside the container — e.g. 'pnpm typecheck && pnpm lint && pnpm test'
  task_token_budget       INT NOT NULL,                           -- per-task token ceiling; see Prompt Construction → Self-verify clause for enforcement boundary
  task_wall_time_seconds  INT NOT NULL,                           -- per-task wall-time ceiling
  max_concurrent_tasks    INT NOT NULL,                           -- hard cap on active tasks per repo; default 1 (serial)
  identity_name           TEXT NOT NULL DEFAULT 'default',        -- selects `github_identity:<name>` row in the secrets table; one bot account per identity
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

`verify_command` is invoked as `bash -lc "<verify_command>"` so the login-shell PATH covers version-manager shims (nvm, pyenv, rbenv) and so pnpm/uv/cargo resolve correctly. Rows are admin-registered, so the shell-string trust model matches the rest of the repo registry.

Owned by `src/agent/store/` (fits the existing agent domain — tasks are agent work items). Consumer of `containers` from the sandbox store.

## Container Lifecycle `[confirmed: single-task plan→execute; reaper / sibling / proxy still proposed]`

> Slice 2 confirms the in-task lifecycle: per-task container (depth 0),
> bind-mounted worktree at `/workspace`, per-task home volume, idle TTL
> reuse-or-recreate via `--resume <sid>`, and grace-period teardown on
> terminal status. The reaper cron, sibling-container creation, the
> Docker socket proxy, and `networks` / `volumes` tables are still
> `[proposed]` — they earn their keep in slice 3 when execute-mode tool
> calls can spawn child containers.

**Invariant: one container per task.** Sharing a container across tasks causes state contamination — `pip install` in task A pollutes task B, long-running processes leak, failures cascade. Containers are cheap; clarity is worth the cold-start cost, which per-repo named cache volumes ([sandbox.md](sandbox.md) → Networks, Volumes, Images) flatten.

### What persists vs what's ephemeral

| Layer | Lifetime | Location |
|-|-|-|
| Worktree (files, git index, uncommitted edits) | Survives container death | Host filesystem, bind-mounted into container at a fixed path (`/workspace`) |
| CLI conversation | Survives container death, dies with task | Per-task named volume `cogmo-task-home-<task-id>` mounted at `/home/cogmo`, holds `~/.claude/projects/<project-hash>/<session-id>.jsonl` and the Codex equivalent |
| Git / registry credentials | Lifetime of the task | Same `cogmo-task-home-<task-id>` volume, wiped on terminal teardown |
| Dependency + build caches | Scope depends on integrity story — see [sandbox.md → Cache volume scoping](sandbox.md#cache-volume-scoping) | Global for integrity-checked download caches (npm/cargo/go/apt); per-repo for pip and build caches |
| In-container process state, `/tmp`, env vars | Dies with container | — |

**Fixed container-side cwd matters for resume.** Claude Code (and Codex) derive their project-hash from cwd. If the mount path inside the container differs between the original and resume run, the CLI creates a fresh project directory and fails to find the prior session. Pin the container-side mount to `/workspace` and never let it vary.

**Task-home volume is the simplest session store** — per-task scope, survives idle teardown, clean wipe on terminal state. Alternative (put session under the worktree at `.cogmo/.claude/`) works but pollutes the worktree with tool state; rejected.

### Sunset triggers

| Trigger | When | Teardown path |
|-|-|-|
| Terminal task status (`pr_open`, `failed`, `cancelled`) | Short grace period for log flush (default 120s, `CODING_TASK_GRACE_SECONDS`) | Orchestrator calls `sandbox.stopTask(id)` → root-task cascade |
| Idle TTL | No CLI activity for `CODING_TASK_IDLE_TTL` (default 20 min) | Sandbox reaper TTL pass. `session_id` preserved in DB. |
| Cogmo restart | Boot reconcile | Sandbox crash-recovery pass ([sandbox.md](sandbox.md) → Crash Recovery) |
| LRU eviction under resource pressure | Disk / RAM threshold crossed | Oldest idle task containers first; active tasks protected |

Grace period exists so a just-pushed PR's streaming logs and resource-usage poll can finish before the container disappears.

### Worktree persistence

No compression, no S3, no tar dumps by default. The git remote is the archive; the worktree is a disposable checkout. ~99% of a worktree is reproducible junk (`node_modules`, `.venv`, `target/`, build caches) that our per-repo named cache volumes ([sandbox.md](sandbox.md) → Networks, Volumes, Images) rehydrate in seconds. The ~1% that matters — commits and uncommitted edits — belongs in git refs.

Teardown policy keyed on worktree state:

| State at teardown | Action |
|-|-|
| Clean, branch pushed, draft PR open | `git worktree remove` — remote is authoritative |
| Dirty (uncommitted edits or unpushed commits) | Stage all, commit as `wip: <task-id>` on the task branch, push as `refs/cogmo-wip/<task-id>`, then remove |
| Failed before first commit with no remote yet (new repo bootstrap) | Fall back: tar under `~/.cogmo/archives/<task-id>.tar.zst` with 14-day TTL; only case that keeps a local dump |

Resume after full teardown replays this in reverse: `git worktree add <path> <branch>` (or the `refs/cogmo-wip/<id>` ref), cache volumes rewarm automatically, `--resume <session_id>` rehydrates the CLI. Costs a few extra seconds vs resume-within-TTL, which keeps the worktree live.

**`refs/cogmo-wip/<task-id>` retention.** These refs are append-only on the remote and accumulate if nothing prunes them. **P1: weekly cron** — prunes any WIP ref whose `coding_tasks` row is terminal and older than 30 days. Sufficient for personal scale; the refs live under `refs/cogmo-wip/` and don't clutter the branches list, so 30-day retention is low-pressure. Per-repo GitHub webhooks for minute-level cleanup on PR merge/close are a P3 optional — useful if hygiene becomes annoying, not worth the setup friction per registered repo at P1.

**S3 / remote object storage is opt-in, not default.** The motivating scenario — "my laptop died, I want the task back" — is already covered by remote refs for every case except the no-remote bootstrap. Deferred to a later remote-sandbox story.

### Resume procedure `[confirmed]`

"Resume" never means "same container" — it means *same state, fresh shell*. Slice 2 ships the in-task variant (plan-phase container reaped before approval; execute recreates):

1. Look up `coding_tasks` row by id. If `status` is terminal and the user didn't explicitly ask to re-open, treat as a new task instead.
2. Reuse-or-create check: `sandbox.listContainersForTask(taskId)` finds any live container row; `sandbox.inspectContainer(dockerId)` verifies it's still `running` according to Docker. If yes, derive a fresh handle via `sandbox.getTaskContainer(dockerId)` and skip step 3.
3. `sandbox.createTaskContainer(spec)` with the same `worktree_path`, `repo_id`, and cache volumes. Fresh container, same mounts. Insert a new `containers` row; update `coding_tasks.container_id`.
4. (Slice 4+ for cross-task resume) Re-inject git credentials from the vault (short-lived, per-task).
5. `backend.execute(ctx, sessionId)` → `claude -p --resume <session_id> --permission-mode acceptEdits` (or Codex equivalent). CLI rehydrates its conversation from its session file in the per-task home volume.

Cost: ~1–3s container start under sysbox plus cache-volume mount when the recreate path is taken. Acceptable because reuse is the common case (default 20-minute idle TTL covers most approve-tap intervals).

### "Addition" disambiguation

When the user sends a follow-up ("also add X", "now do Y"), Cogmo resolves to resume-vs-new using the last referenced task's state:

| Prior task state | Default resolution |
|-|-|
| Non-terminal (`planning` / `executing` / `pending_verify` / `verifying`) | Resume — same task, same branch, same session |
| `pr_open`, PR still draft | Ask — follow-up commit on the branch (resume) vs new task |
| `pr_open`, PR merged | New task, new branch; repo-knowledge from Hindsight carries context |
| `pr_open`, PR closed unmerged | Ask — retry on the same branch vs new task |
| `failed` / `cancelled` | New task by default; resume is opt-in |
| No prior task referenced | New task |

Conversation context is the primary signal — a follow-up inside an active task thread defaults to resume; a fresh thread defaults to new task. Ambiguity triggers an explicit question, never a silent choice.

## Concurrency `[proposed]`

Per-repo concurrency is capped by `coding_repos.max_concurrent_tasks` (default 1). New tasks beyond the cap queue and the user is told on Telegram that they're queued behind an active task.

**Branch and PR ownership is a non-issue.** Each task owns its own branch (`cogmo/<task-id-short>`) and its own draft PR. Two tasks editing the same files produce two PRs; the merge conflict surfaces at human review time, same as with any two humans on the same repo. No coordination required.

**The real tension is cache contention.** Our cache volumes are shared across tasks (see [sandbox.md → Cache volume scoping](sandbox.md#cache-volume-scoping)) so concurrent `pnpm install`s on the same store can race. Three ships considered:

| Option | Mechanism | Trade-off |
|-|-|-|
| **A. Serialize per repo** (P1 default) | `max_concurrent_tasks = 1` | Zero races, zero parallelism |
| **B. Install-lock per repo** (P3, the relaxation path) | Parallel worktrees + containers. `<pkg-manager> install` acquires a flock on a lock file in the shared cache volume; compile, test, edit run unlocked | Install (10–30% of task time) serializes per repo; rest parallel. Cheap, targets the one real failure mode. |
| **C. Narrow the lock to racers only** (refinement of B) | Only pip and apt hold the lock in practice — npm's cacache, cargo, and go modules handle concurrent reads + atomic writes cleanly | Measurement-driven follow-up once B ships. |

Rejected:

- **Per-task cache namespaces** — full isolation but loses the shared-cache disk win and forces cold installs per task. Only worth it if install-lock proves too painful.
- **Overlayfs copy-on-write** — full parallelism with shared-cache benefit preserved, but real complexity (overlayfs inside sysbox, merge-back semantics). Over-engineered for personal scale.

Industry analog: Devin, Copilot coding agent, Cursor background agents all give each parallel task a fully isolated environment (equivalent to per-task namespaces) and let git-level conflicts surface at review. They sidestep shared-cache contention by not sharing at all, at cloud-scale cost. Shared caches plus install-lock is the pragmatic single-host version of the same idea.

## Admission & Rate Limiting `[proposed]`

Automated trigger sources (`evolution`, `signal_pipeline`) can in principle queue tasks without human attention. Without guardrails, a misbehaving evolution loop can burn subscription tokens, eat host resources, and flood the PR list with noise. Every task passes admission control before it starts executing; `status = 'queued'` rows sit in the queue until they pass.

### Admission checks

Applied in order:

1. **Per-repo cap** — `coding_repos.max_concurrent_tasks`. Covered in Concurrency.
2. **Global cap** — `CODING_MAX_CONCURRENT_TASKS` (default 3). Host-level ceiling; protects CPU/RAM/disk regardless of per-repo math.
3. **Per-source quota** — rolling 24-hour task count, per `trigger_source`:
   - `user` — unlimited
   - `evolution` — default 3/day, overridable via `CODING_EVOLUTION_DAILY_QUOTA`
   - `signal_pipeline` — default 1/day, overridable via `CODING_SIGNAL_PIPELINE_DAILY_QUOTA`
4. **Failure backoff** — if the last K tasks from a given source all failed (plan unparseable, verify fail, container crash), pause that source for T hours. Exponential on recurrence (1h → 4h → 24h), resets on a successful task. Defaults: K=3, T=1h. Applied per source, not per task type.
5. **Priority** — when capacity frees up, queued `user` tasks always start before queued automated tasks. Inside a single priority tier, FIFO.

### Scheduler

Inngest cron ticking every ~30s (durable, retryable, fits the existing event-driven shape). Each tick:

1. Query `coding_tasks WHERE status = 'queued' ORDER BY (trigger_source = 'user') DESC, created_at ASC`.
2. Walk in order; for each, evaluate the admission checks against current state.
3. Advance the first admissible task out of `queued` and hand off to the orchestrator, which runs worktree allocation, container creation, and plan generation as a single durable Inngest workflow.
4. Stop when either the global cap is hit or no more admissible tasks remain.

Derivation beats new tables — rolling quota counts come from `SELECT count(*) FROM coding_tasks WHERE trigger_source = $s AND created_at > now() - interval '24 hours'`. No `source_quota_state` row to keep in sync.

### Scope — what this replaces

- **Per-repo `max_concurrent_tasks`** from Concurrency stays as written — it's now one of the checks admission runs.
- **`task_token_budget` / `task_wall_time_seconds`** from the Prompt Construction section stay as written — they're enforcement *during* a task, not admission before it.
- **Subscription-side rate limits** (Claude Max 5-hour cap, Codex session limits) are external — we catch the error from the CLI, mark the task `failed` with an informative reason, and count it toward the backoff window above.

Lands as part of P2 phase 12 (automated self-modification surface). Without it, `evolution` tasks ship disabled.

## Flow `[proposed]`

```text
[Telegram: "refactor steering rules to support per-channel scoping"]
        │
        ▼
Cogmo orchestrator
  1. Resolve repo (keyword match or ask)
  2. Insert coding_tasks row, status='queued'
  3. Allocate git worktree on host: git worktree add <path> -b cogmo/<id-short>
  4. sandbox.createTaskContainer → task container up with worktree mounted, git creds injected
        │
        ▼
ClaudeCodeBackend.plan()
  claude -p --permission-mode plan "<goal>" ...
  Stream events back as Telegram progress
        │
        ▼
plan_ready event
  · trigger_source=user        → Telegram inline keyboard [Approve] [Revise] [Cancel]
  · trigger_source=evolution/
    signal_pipeline            → auto-proceed (plan_approved_at stays null)
        │
        ▼ (on Approve or auto-proceed)
ClaudeCodeBackend.execute()
  claude -p --resume <sid> --permission-mode acceptEdits --input-format stream-json
  Dangerous tool calls surface as stream-json permission requests → Telegram approve/deny
  Text + tool-use events stream to Telegram progress message (edited in place)
        │
        ▼
Verify step (inside container):
  pnpm typecheck && pnpm lint && pnpm test
        │
        ▼
Push + PR:
  git push origin cogmo/<id-short>
  gh pr create --draft --title "..." --body "<plan summary + test results>"
        │
        ▼
Telegram: "Task done. Draft PR: <url>. Review from GitHub mobile when ready."
```

Failure at any stage: `status = 'failed'`, reason written, sandbox torn down, user notified with a link to the partial worktree for manual inspection.

### Inngest step boundaries

Same pattern as `handle-message` ([crash-recovery.md](crash-recovery.md)) — durable around the boundaries, non-durable through the streaming middle.

| Step | Kind | Notes |
|-|-|-|
| `allocate-worktree` | `step.run` | Idempotent reconcile: (1) if the host path already exists and `git -C <path> rev-parse --is-inside-work-tree` succeeds and HEAD resolves to `cogmo/<id-short>`, adopt it and return. (2) If the branch `cogmo/<id-short>` already exists without a worktree, `git worktree add <path> cogmo/<id-short>`. (3) Otherwise, `git worktree add -b cogmo/<id-short> <path>`. Handles crashes between `worktree add` and the DB insert without the raw `add` failing on "path/branch already exists". |
| `create-container` | `step.run` | `sandbox.createTaskContainer`; on retry, reuses existing container row if still healthy |
| *plan streaming* | non-durable | Spawns `claude -p --permission-mode plan`, streams JSONL to Telegram. Not wrapped in `step.run` — can't replay a stream. On retry, re-invoked with `--resume <sid>` so it continues the same session instead of replanning from scratch |
| `persist-plan` | `step.run` | Writes `coding_tasks.plan`, status `awaiting_approval` |
| `wait-for-approval` | `step.waitForEvent` | Hours-to-days acceptable; Inngest durably parks the run |
| *execute streaming* | non-durable | Same pattern as plan streaming — `--resume <sid>`, permission responses over stdin |
| `verify` | `step.run` | Single post-hoc execution of `<coding_repos.verify_command>` inside the container (via `bash -lc`). **No retry loop in this step.** Iterating on failure was the CLI's job during the execute phase per *Prompt Construction → Self-verify clause*; this step exists only to confirm the CLI's "done" claim. Pass → proceed to push + PR; fail → mark task failed with the verify output. Budget caps (`task_token_budget`, `task_wall_time_seconds`) enforce termination of the execute phase upstream; this step is bounded by a single command timeout, not by a retry count. |
| `push` | `step.run` | `git push origin cogmo/<id-short>`; non-fast-forward fails the task, no force |
| `create-pr` | `step.run` | `gh pr create --draft`; idempotent — if a PR already exists for the branch, update body instead |
| `teardown` | `step.run` | WIP-ref push if dirty, worktree remove, `sandbox.stopTask(id)` — always runs, even on failure, via `onFailure` hook |

Streaming sections re-execute on retry. `--resume <sid>` plus idempotent durable steps around them keeps the task convergent — replays don't produce double commits, double pushes, or double PRs. Mirrors the tradeoff we already accepted for `handle-message` message streaming.

## Autonomy Gates `[proposed]`

Three gates, mapped onto Cogmo's existing `explicit_permission` rules. Plan gate is `[confirmed]` (slice 2); tool gate is `[confirmed]` (slice 3); merge gate remains `[proposed]`.

### Plan gate `[confirmed]`

Before any writes. Invoke the backend in plan mode (`claude -p --permission-mode plan` or Codex equivalent). Plan text is captured in `coding_tasks.plan` regardless of trigger source.

Gating depends on `trigger_source`:

- **`user`** — Plan posted to Telegram with inline keyboard: **Approve**, **Revise** (cancels the task and asks the user to describe what should change; the agent's next turn issues a fresh `delegate_coding`), **Cancel**. No edits happen until approved. Approval writes `plan_approved_at` and emits `coding/task/plan-approved`, which triggers the execute orchestrator. Identity check: `callback.from.id` resolves via `transportStore.resolveUser` to a Cogmo `userId` and must match the conversation owner — strangers in the same chat get `identity_rejected`.
- **`evolution` / `signal_pipeline`** — Plan proceeds to execute automatically. `plan_approved_at` stays null. The PR merge gate remains the single human checkpoint; no interactive approval on Telegram.

This keeps automated self-improvement flows non-blocking while preserving a human veto where it matters — at PR review. An automated task that produces a bad plan wastes its own tokens and parks a draft PR; it cannot modify the system without the human reviewer.

**Approval does not expire.** Once a plan is approved (`plan_approved_at` set), that approval stands until the task reaches a terminal state. The plan text lives durably in `coding_tasks.plan`; the task's branch is isolated from base-branch drift until merge; container resources are freed by the idle-TTL path independently of approval freshness. If execution is resumed hours or days after approval, the preserved `session_id` rehydrates the same plan into a fresh container. State-based invalidation (code SHA drift) is the industry norm here, not time-based; our task-branch isolation makes even that a non-issue. P3 polish: post a "still want to proceed?" confirmation if execution would start >24h after approval — reminder, not expiry.

**Approval idempotency.** `approvePlanIfPending` is atomic: a second tap returns `task_already_approved` without re-emitting the event. Telegram surfaces the duplicate as "already approved" toast and no state change.

### Tool gate `[confirmed]`

During execute phase. Every tool call the CLI wants to run is gated against our policy before it executes.

**Mechanism: stream-json `control_request` bidirectional.** Claude Code's `PreToolUse` hook runs as a synchronous subprocess with a default ~60s timeout — not workable when the user is asleep or away from Telegram for hours. Slice 3.0d drops `--permission-mode acceptEdits` so the CLI emits `control_request` frames with `subtype: can_use_tool` on stdout for every tool call; Cogmo writes a `control_response` back on stdin. The CLI blocks until each request is answered, so the orchestrator's policy + decision-log + Telegram round trip drives back-pressure naturally. Same channel is how we inject follow-up messages during a multi-turn task.

**Defaults are loose. The container + Docker proxy + sysbox runtime are the security boundary; the gate is for visibility into externally-visible side effects, not in-container damage prevention** (the container's ephemerality is the recovery story; genuinely-dangerous things like `Privileged=true`, host-net, host-path binds, dangerous caps are blocked at the proxy layer where they belong).

Policy:

- **Always allow:** all file ops anywhere in container (Read/Edit/Write/Glob/Grep/MultiEdit/NotebookEdit), all read-only Bash, test/build/lint/format/typecheck, package installs (`pnpm install`, `cargo build`, `pip install`, etc.), local docker actions (`docker ps`, `docker run`, `docker compose up`), in-container `rm`. Most calls hit always-allow and reply in microseconds with no Telegram round trip.
- **Prompt:** narrow set of external state changes — `git push`, `gh pr create / merge / review / close / edit / comment / ready / reopen`, `gh issue` mutations, `gh release / repo create / delete / edit`, `npm/pnpm/yarn publish | unpublish`, `cargo publish | yank`, `uv publish`, `twine upload | publish`, HTTP writes via `curl -X POST/PUT/DELETE/PATCH` or `wget --post-data` to non-localhost URLs.
- **Deny:** empty static set. The proxy + sysbox boundary handles the genuinely-dangerous side. The decision log can still record an explicit user-denied response (`scope=once`, `decision=deny`).

Compound commands prompt if any sub-command is in the prompt set (worst-case wins): `pnpm test && git push` shows the push explicitly rather than letting it ride a blanket allow.

**Telegram surface.** Prompts are inline-keyboard messages: **Once** / **Task** / **Deny**. callback_data uses single-char wire codes (`o`/`t`/`d`) to fit Telegram's 64-byte limit alongside a full UUID taskId + 16-char requestId prefix. Identity-checked: `callback.from.id` resolves via `transportStore.resolveUser` and must match the conversation owner.

**Decision log replay.** Each user response writes a row to `coding_tool_decisions` (per-task). On every subsequent request, the orchestrator builds a canonical pattern (`Bash(git push *)`, `Bash(gh pr create *)`, etc.) and replays the log newest-first; the most recent task-scoped match wins immediately, no Telegram round trip. Audit-only `once`-scoped rows are ignored on replay. No "Allow forever" / cross-task scope — that's the static policy's territory, edited out-of-band by the user (avoids the "poisoned plan in task A normalises a dangerous pattern for task B" failure mode).

**Block indefinitely on Telegram outage.** Slice 3 design: the CLI just waits. Implementation uses a 7-day `step.waitForEvent` timeout as an abandoned-task safety net, not a deny-on-timeout. If a prompt hits the safety-net deny, it's logged for surfacing to the operator.

### Merge gate

The final artifact is a **draft PR**. Cogmo never pushes to `main`, never merges, never marks ready-for-review. The user reviews the diff in GitHub Mobile (or desktop) using their normal review flow — branch protection, required checks, and reviewers apply.

## Git Identity `[proposed]`

**P1 (slice 4):** Fine-grained PAT + Ed25519 SSH signing keypair on a dedicated `cogmo-bot` GitHub account. The PAT and signing key for one bot account are inseparable — they're stored as a single JSON-encoded bundle (`{ pat, sshPrivateKey, sshPublicKey }`, validated by `GitHubIdentitySchema`) in Cogmo's `secrets` table under the name `github_identity:<name>`. The setup wizard provisions `github_identity:default`; multiple identities can coexist and each repo selects one via `coding_repos.identity_name`.

**Setup wizard (slice 4.0b):** prompts for the PAT, validates against `GET https://api.github.com/user`, generates an Ed25519 keypair via `micro-key-producer/ssh.js` (returns OpenSSH-armored `privateKey` + `publicKey` strings + SHA-256 fingerprint), and prints the public key with a `https://github.com/settings/ssh/new` link instructing the operator to install it as a **signing key**. The private key never leaves the encrypted DB. Non-interactive setup accepts `COGMO_GITHUB_PAT` (with `_FILE` variant); pre-supplied private keys are not yet importable (slice 4 always generates a fresh keypair and prints the public key for installation).

**Per-task delivery (slice 4.0d):** the PAT is materialised into a per-task `GIT_ASKPASS` helper file under `/run/cogmo/askpass/<task-id>/`; the SSH private key is dropped alongside and referenced via `git config user.signingkey <path>`. Both are wiped on teardown.

**SSH commit signing:** `git config gpg.format ssh` + the per-task signing key file. Commits show "Verified" on GitHub. Uses OpenSSH, no GPG faff.

**P2+:** Migrate to GitHub App with installation tokens. Short-lived tokens per task, cleaner audit trail, standard practice (Dependabot, Renovate, Copilot cloud agent all use this). Deferred because App setup is fiddly for a one-user tool and P1's PAT model is functionally equivalent for audit trail + signing.

### Credential delivery: disk vs vault socket

Two viable patterns, each with real costs:

**A. Disk-based credential helper (P1 proposal)** — generate a per-task PAT-backed `~/.git-credentials` and `~/.netrc` inside the container at start, wipe at teardown. `GIT_ASKPASS=<script>` for the git path, same file covers `gh`, `npm`, `pip`, `curl`.

- ✅ Zero custom code — every CLI already understands these files.
- ✅ Easy to debug — `cat` reveals state.
- ✅ Works uniformly across git, gh, npm, pip, curl, cargo.
- ❌ Credentials sit on disk for the task's lifetime. If the container is breached or a backup captures the layer, they leak. Our no-dump worktree policy mitigates the backup path; layer snapshots remain a small residual risk.
- ❌ A rogue subprocess can read the files and exfiltrate before teardown.

**B. Vault socket (P2+ proposal)** — a helper binary inside (or adjacent to) the container exposes credentials on a Unix socket. `GIT_ASKPASS` becomes a tiny script that `curl`s the socket. Backed by Cogmo's encrypted secrets store.

- ✅ Credentials never land on container disk. Revocable instantly by closing the socket.
- ✅ Per-task scoping is natural — socket path identifies the task, same mechanism as the Docker proxy.
- ✅ Matches Cogmo's capability-interface philosophy: tool asks for credential, vault decides.
- ❌ ~200–300 lines of custom code (helper binary + client shim). Yet another moving piece.
- ❌ Compat drift — every tool that needs auth must funnel through a helper Cogmo controls. Git via `GIT_ASKPASS` is easy; `npm` / `pip` / `cargo` may need per-tool helpers or environment shims.
- ❌ Harder to debug — auth failures surface as opaque "permission denied" from the client.

**P1 decision: ship pattern A.** Pair it with short-lived PATs (fine-grained, per-repo, quarterly rotation on the bot account) and aggressive teardown. Revisit vault socket in P2 alongside the GitHub App migration, when we'll have installation tokens that auto-expire in 1 hour and benefit most from no-disk storage.

**Slice 4.0d wiring (concrete shape).** The orchestrator provisions a per-task askpass directory before `createTaskContainer`:

```
${SANDBOX_ASKPASS_DIR}/<rootTaskId>/
  helper           0700  — `#!/bin/sh; exec /bin/cat /.cogmo-askpass/pat`
  pat              0600  — bot account's fine-grained PAT
  signing-key      0600  — OpenSSH-armored Ed25519 private key
  signing-key.pub  0644  — corresponding `ssh-ed25519 ...` line
```

The directory is bind-mounted **read-only** at `/.cogmo-askpass/` inside the container. `provisionAskpass` returns env vars to thread into `exec` — `GIT_ASKPASS=/.cogmo-askpass/helper` and `GIT_TERMINAL_PROMPT=0`; commit signing happens via `git -c gpg.format=ssh -c user.signingkey=/.cogmo-askpass/signing-key` (env vars don't drive the signing path). `LocalInProcessSandbox.stopTask` calls `cleanupAskpass` in its `try/finally`, idempotent under retries and a no-op when the directory was never provisioned. See `src/sandbox/askpass.ts`.

## Repo Registry `[proposed]`

Repos are first-class. A repo must be registered (via CLI or control command) before Cogmo will work on it:

```bash
cogmo repo add <name> --path /path/to/clone --remote git@github.com:user/repo.git
cogmo repo list
cogmo repo remove <name>
```

**Telegram surface (slice 4.0c):** `/repo add` with no positional args opens a guided three-step dialog (name → remoteUrl → confirm). On confirm Cogmo clones the remote into `${COGMO_REPOS_DIR}/${name}` itself, threading the default GitHub identity's PAT through a one-shot `GIT_ASKPASS` helper (host-side, wiped on completion — see `src/secrets/git-askpass.ts`). The positional `/repo add <name> <path> <url>` form stays for scripting and for already-cloned repos (no PAT, no clone, just register).

Each repo can override:

- **Devcontainer**: `.devcontainer/devcontainer.json` in the repo takes precedence; if absent, falls back to `cogmo/devbase` (opinionated image with node, python, common CLIs, claude, codex).
- **Allowed backends**: some repos might restrict to Claude only, or opt out of Codex.
- **Test command**: verify step needs to know how to run tests for this repo.

## Memory Layers `[proposed]`

Four layers, clean separation:

| Layer | Scope | Storage |
|-|-|-|
| **In-session** | A single CLI invocation's rolling context | Claude/Codex's own session file, resumed via `session_id` |
| **Task** | The lifetime of one `coding_tasks` row — plan, approvals, tool decisions, resource usage | Cogmo DB |
| **Task-runner (user-global)** | Cogmo's task-runner guidance, coding-profile steering rules | `~/.claude/CLAUDE.md` in the per-task home volume, rendered from template at task start |
| **Repo-knowledge** | Cross-task facts about a repo — "tests always require PG running", "this module is getting rewritten" | The target repo's own `/workspace/CLAUDE.md`, authored by humans or proposed by Cogmo as a `CLAUDE.md`-edit coding task |

**Why repo-knowledge lives in the repo, not in Hindsight.** The natural sink for a fact like "this repo needs PG running for tests" is the place humans and Claude Code both already look — the repo's `CLAUDE.md`. Putting it in a Cogmo-private vector store creates a shadow copy of information the repo should own, splits the canonical source from the one humans read, and adds a Hindsight dependency for coding that its vector-recall shape doesn't particularly fit. Hindsight stays scoped to conversational memory.

**Observer for coding tasks** ([memory.md](memory.md)) runs post-task but its sink is a proposed `CLAUDE.md` edit, filed as a small follow-up coding task (`trigger_source = 'evolution'`, goal like "update `CLAUDE.md` with lesson from task `<id>`: `<fact>`"). The usual PR gate applies. Humans review and merge, and the knowledge then loads natively on every future task via Claude Code's project-tier memory. No separate store, no dual-writes, no recall-filtering.

This reuses the whole coding-delegation pipeline (sandbox, plan gate for user triggers, draft PR) for its own metacognition, which keeps one pattern rather than two.

## Base Image `[proposed]`

**`cogmo/devbase`** — the default task container image when a repo has no `.devcontainer/`. Contents:

- Node 24 LTS + pnpm
- Python 3.12 + uv
- Go, Rust toolchains (via version managers, not pre-installed)
- Common CLIs: git, gh, ripgrep, fd, jq, yq, curl, docker client
- Claude Code CLI and Codex CLI preinstalled
- `/etc/claude-code/CLAUDE.md` — managed-policy memory file containing Cogmo's non-negotiable invariants (see [Prompt Construction → Injected context](#injected-context)). Baked into the image so the repo cannot override or remove it.
- Non-root user `cogmo` (UID mapping via sysbox handles the userns side)

Images are pinned versions in Cogmo's deployment; updates happen via image rebuilds, not in-container installs. Managed-policy memory updates = image rebuild, same cadence as toolchain updates.

**Session-file layout is an upstream contract we depend on.** Claude Code writes sessions to `~/.claude/projects/<project-hash>/sessions/<session-id>.jsonl` (project-hash derived from the git repo root, not cwd). Resume correctness hinges on this layout. Mitigation:

- `cogmo/devbase` pins both `claude` and `codex` to exact versions; upgrades are explicit image rebuilds, never floating `:latest`.
- A smoke test in the integration tier runs a plan-only task and asserts that the expected session file exists at the expected path before declaring the image green. A silent upstream layout change fails the test rather than the first production resume.

Cache volumes mounted into the container according to the scoping rules in [sandbox.md → Cache volume scoping](sandbox.md#cache-volume-scoping): global shared volumes for integrity-checked download caches (`~/.npm`, `~/.cargo/registry`, `~/go/pkg/mod`, apt); per-repo volumes for caches without ecosystem integrity (`~/.cache/pip`, `~/.cache/go-build`, Rust `target/`). Installed trees (`node_modules`, `.venv`) live in the worktree and are never cached cross-task.

## Progress UX `[proposed]`

One Telegram message per task, edited in place as the task progresses. Format:

```text
🔧 refactor steering rules to support per-channel scoping
   repo: cogmo · branch: cogmo/rvc1 · backend: claude
   
   ● plan approved · 4 files to edit · 2 new tests
   ▶ executing: edit src/agent/steering-rules.ts (3/4)
   
   tokens: 12.4k in / 3.8k out · elapsed: 2m14s
```

Editing one message keeps the chat clean and matches established patterns ([RichardAtCT/claude-code-telegram](https://github.com/RichardAtCT/claude-code-telegram), [gergomiklos/heyagent](https://github.com/gergomiklos/heyagent)).

Diffs are not rendered in Telegram. Link to GitHub for review. GitHub Mobile (since April 2026) natively supports reviewing Copilot cloud-agent diffs from a phone — Cogmo draft PRs use the same surface.

## Failure Modes `[proposed]`

| Failure | Handling |
|-|-|
| Plan LLM output unparseable | Retry once with clarification; if still failing, post raw output to Telegram and fail task |
| Subscription rate-limited | Detect from CLI error; mark task `failed` with informative reason; the failure counts toward the source's backoff window (see *Admission & Rate Limiting → Failure backoff*). User can retry manually once the subscription window resets. |
| Tool approval denied | Feed the denial back into the session so the CLI can try a different approach; if it keeps trying denied tools, fail task |
| Tests fail in post-hoc verify | Mark task `failed` with the verify output. No Cogmo-side retry — the CLI's own agent loop had its iteration budget during execute (see *Prompt Construction → Self-verify clause*). User sees the failing output and decides whether to resume, file a fix as a new task, or merge as-is. |
| Git push rejected (non-ff, protected) | Report error, do not force — user decides how to reconcile |
| Task container crash | Mark task `failed`; sandbox reaper cleans up orphans; `session_id` preserved so the user can explicitly resume |
| Cogmo restart mid-task | Sandbox crash recovery reconciles containers on boot. Non-terminal tasks are *not* auto-resumed — they stay in their last status with `session_id` intact, and the next user turn on that task triggers the resume path from [Container Lifecycle](#container-lifecycle-proposed). Avoids silent side-effects after a potentially long outage. |

## Why this design `[confirmed]`

Lines up with documented industry patterns (late 2025 / Q1 2026):

- **Plan-first gating** is standard — Claude Code's plan mode, Cursor's plan mode, Cursor Auto's classifier-reviewed actions all converge here.
- **Draft PR as merge gate** is universal — GitHub Copilot coding agent, Devin, Cursor background agents all end tasks with a draft PR rather than trying to render diffs in chat.
- **Worktree-per-task** is Claude Code's own `-w` flag shape and Codex's experimental multi-agent pattern.
- **Session resume** via `--resume` or `--continue` is both CLIs' native feature — use it, don't reinvent.
- **Telegram UX** patterns (inline approvals, progress-in-one-message, ANSI stripping) are well-trodden in the reference bots.

## Implementation Phases `[proposed]`

Ship order. Each phase is independently useful — stop at any point and the prior phases still work.

### P1 — core loop

1. **Sandbox primitives.** `containers`, `cogmo_instances`, `networks`, `volumes` tables; sibling-container creation against host daemon with sysbox runtime; label injection; root-task cascade on teardown; reaper cron (TTL + orphan + stale-row passes). Proxy is **body-level pass-through** on `POST /containers/create` (no `HostConfig` filtering yet — P2 adds the Privileged/NetworkMode/Binds/CapAdd denies). Endpoint-category blocks (`/swarm/*`, `/plugins/*`, `/nodes/*`) are *always on* regardless of phase — they're structural, not body policy.
2. **Claude backend, plan-only.** Subprocess wrap with `--permission-mode plan`, JSONL parsing, session capture. Stream plan text to Telegram. Emit `plan_ready` with inline keyboard. No execute path wired yet.
3. **Plan approval + execute.** Approval writes `plan_approved_at`, orchestrator resumes session with `--permission-mode acceptEdits`. Text-delta streaming into a single edited Telegram message.
4. **Tool gate.** Permission prompts over `stream-json` stdin → Telegram inline keyboards → decision back to stdin. Default policy table from Autonomy Gates applies.
5. **Verify + push + draft PR.** In-container `pnpm typecheck && pnpm lint && pnpm test`, git commit + sign + push, `gh pr create --draft`. Teardown policy (worktree persistence table) executes. Resource usage written to `coding_tasks.resource_usage`.

After (5): end-to-end working flow for the single-backend, trusted-repo case.

### P2 — breadth + hardening

6. **Codex backend.** Second `CodingBackend` impl, same interface. Selection per-task via `coding_tasks.backend`.
7. **Proxy policy enforcement.** Deny `Privileged`, `NetworkMode=host`, out-of-scope host binds, dangerous caps. Runtime injection. Registry allowlist.
8. **Devcontainer parsing.** Full `.devcontainer/devcontainer.json` support via the devcontainer CLI or equivalent — `image`, `features`, `postCreateCommand`, forwardPorts. Falls back to `cogmo/devbase` when absent.
9. **Vault socket for credentials.** Replace disk-based `.git-credentials` with a per-task Unix socket helper. Enables short-lived GitHub App installation tokens without writing them to disk.
10. **GitHub App migration.** Replace bot PAT with a Cogmo GitHub App and installation tokens. ~1-hour token expiry, per-task minted via the App's private key.
11. **Extract sandbox proxy to sidecar.** Second subcommand on the same image (`cogmo sandbox-proxy`), communicating with `cogmo serve` over tRPC. See [sandbox.md → Deployment Topology](sandbox.md#deployment-topology). Triggered when an in-process crash first disrupts a live task.
12. **Automated self-modification surface.** For `trigger_source IN ('evolution', 'signal_pipeline')`, expose read/write access to non-code configuration — `steering_rules`, `profiles.base_prompt`, and similar DB-backed assets — as direct domain operations, not through coding-delegation. Data changes don't need a diff, a PR, or a sandbox; they're atomic DB writes gated by which evolution stage holds the capability. Code/skill changes continue to flow through coding-delegation with its draft-PR gate. Specified properly in [evolution.md](evolution.md); this phase is the wiring from evolution stages into those capabilities.

### P3 — polish

13. **Parallel tasks on the same repo.** Raise `max_concurrent_tasks` past 1; add the install-lock (Concurrency option B) on shared cache volumes. Narrow the lock to known racers (pip, apt) after measurement (option C).
14. **BuildKit policy enforcement.** Basic `buildx` works from P1 via transparent pipe on `/session`. This phase adds gRPC-level inspection via the BuildKit SDK for fine-grained policy — blocking `FROM` lines against unapproved registries, inspecting secret mounts, rejecting builds that would escape worktree scope.
15. **Observer repo-knowledge loop.** Post-task Observer extracts durable repo-facts and files a small follow-up coding task (`trigger_source = 'evolution'`) whose goal is to propose a `CLAUDE.md` edit. Normal PR gate applies. Once merged, Claude Code loads the new knowledge natively on every future task — no Cogmo-private store.

Each phase has a clear "done" bar: the prior phase's feature works unchanged, and the new one is opt-in behind config (not a silent behavior change).

## Open Questions

_All resolved; placement of follow-on questions will be added here as they arise._
