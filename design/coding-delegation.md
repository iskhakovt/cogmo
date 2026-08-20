# Coding Delegation

Cogmo delegates heavy coding tasks to Claude Code and Codex CLI, leveraging the user's existing Max/Pro/Plus subscriptions as the execution backend. Telegram is the control plane. Cogmo handles planning, gating, progress reporting, and review; the CLIs do the actual work.

## Purpose `[proposed]`

Enable flows like:

> *[Telegram]* "Please refactor the steering rules module to support per-channel scoping; run the integration tests; open a PR."

Cogmo:

1. Creates a sandboxed task container (worktree, git identity, tools).
2. Runs `claude -p` in plan mode first; posts the plan to Telegram with Approve / Revise / Cancel buttons (user-initiated tasks; automated triggers skip this gate).
3. On approval, executes the plan. Tool calls run unattended inside the sandbox container — the sandbox isolation is the security boundary, not a runtime permission gate (see *Autonomy Gates → Sandbox isolation*).
4. Verifies (typecheck, lint, tests), commits, pushes, opens a PR.
5. Sends the PR URL to Telegram for final review.

Scope explicitly *not* in this doc: writing code inline in the agent's own responses. That's what the existing `files` capability in `Service` covers. This doc is about **delegating multi-step coding work to a specialized subprocess** that can run commands, install deps, execute tests.

## Execution Model `[confirmed]`

**Subprocess-wrap the user's logged-in CLIs.** No API keys, no Agent SDK. This is the sanctioned personal-use path.

| Backend | Invocation (shape) | Auth |
|-|-|-|
| Claude Code | `claude -p --output-format stream-json --include-partial-messages --input-format stream-json --permission-mode {plan,bypassPermissions} [--resume <sid>] [--session-id <uuid>]` | User's Max/Pro subscription via long-lived OAuth token, see [Subscription Auth](#subscription-auth-proposed) |
| Codex CLI | `codex exec resume <sid> --json` (or `codex exec resume --last --json`) — `resume` is a subcommand and must precede `--json` | User's ChatGPT Plus/Pro login (file-mount path TBD, see [Subscription Auth → Codex parallel](#subscription-auth-proposed)) |

Flag set is illustrative — pin and verify against the exact `claude` / `codex` versions baked into `cogmo/devbase`. Both CLIs evolve their flags quickly; the `CodingBackend` impl treats the argv vector as a versioned contract keyed on the image tag.

The Agent SDK explicitly requires API keys and **cannot use subscription auth** — confirmed behaviour, intentional boundary from Anthropic. Subprocess-of-the-CLI is the only path that honours the subscription. Personal single-user is the sanctioned use; Cogmo runs on the user's own host.

Output is parsed as JSONL. Both CLIs emit structured events (`system/init`, `stream_event` with `text_delta`, tool-use, `turn.completed` with tokens). Cogmo streams these as progress updates to Telegram.

`session_id` is captured on the first event and persisted in `coding_tasks.session_id`. Resume uses `--resume <sid>` (Claude) or the `resume` subcommand (Codex) — carries full conversation state across Cogmo restarts or multi-turn task flows.

### Subscription Auth `[proposed]`

The *Execution Model* table claims "User's Max/Pro subscription". This subsection specifies how that subscription reaches the per-task container, since the host's `~/.claude/` is *not* shared with the sandbox (per-task home volume is fresh and ephemeral, see [Isolation → What persists vs what's ephemeral](#what-persists-vs-whats-ephemeral)).

**`CLAUDE_CODE_OAUTH_TOKEN` env var, sourced from the encrypted secrets table.** Anthropic's official headless path ([authentication docs](https://code.claude.com/docs/en/authentication) → *Generate a long-lived token*).

| Step | Where |
|-|-|
| User runs `claude setup-token` once on a machine with a browser | Claude.ai OAuth flow, prints a 1-year token to stdout. The CLI does *not* persist it — copy required. |
| User pastes the token into Cogmo's setup wizard | Stored as `claude_code_oauth_token` in the encrypted `secrets` table ([infrastructure.md](infrastructure.md) → Secrets). Setup is re-runnable, so re-pasting is the rotation path. |
| Non-interactive bootstrap path | `COGMO_CLAUDE_CODE_OAUTH_TOKEN` (and `_FILE` variant) migrates into the secrets table on first boot, same pattern as `daytona_api_key` and the GitHub PAT. Not consulted thereafter. |
| Orchestrator reads before `create-container` step | `secretsStore.get("claude_code_oauth_token")` runs as a fail-fast gate alongside identity resolution — never throw away a container or askpass dir on a missing token. Threaded into `sandbox.create()` via a new `env` field on `SessionSpec` (backend-agnostic; any future `SandboxClient` impl must honour or explicitly reject the field). |
| Supervisor injects on container create | `Docker.createContainer({ ..., Env: [\`CLAUDE_CODE_OAUTH_TOKEN=${token}\`] })`. The token lives only in the container's process env — never lands on the home volume, never gets `docker cp`'d in. |

**Why not bind-mount `~/.claude/`.** The host login pair (`access_token` + `refresh_token` in `~/.claude/.credentials.json`) mutates on refresh. A container would either race with the host on refresh writes or fail to refresh in non-interactive mode entirely ([anthropics/claude-code#28827](https://github.com/anthropics/claude-code/issues/28827)). On macOS the host stores credentials in Keychain, not as a file — bind-mount isn't even possible. The long-lived token sidesteps both problems.

**Why not `apiKeyHelper`.** Pattern is strictly more flexible (vault-fetched short-lived tokens, same shape as the *Git/Registry Credentials → Vault socket* P2 proposal in this doc), but adds an in-container helper script and a host-side credential server for no immediate gain when the alternative is one env var with a 1-year TTL. Defer to P2 alongside the GitHub-App migration, where short-lived helper auth applies uniformly across git, gh, and Claude.

**Why not `ANTHROPIC_API_KEY`.** Bills against Console (API), not the user's Max/Pro subscription — defeats the entire premise of *Execution Model*. It also wins precedence over `CLAUDE_CODE_OAUTH_TOKEN` if both are set ([authentication docs](https://code.claude.com/docs/en/authentication) → *Authentication precedence*), so Cogmo must never set `ANTHROPIC_API_KEY` on the coding container's env, even by accident from the host shell.

**Token rotation.** 1-year TTL. The secrets row already carries `created_at`; re-running the wizard's auth step replaces the secret in place. Token expiry at runtime surfaces as `claude -p` exiting with an auth failure on the next task — recorded into `coding_tasks.failure_reason` as a new `claude_auth_failed` discriminator alongside the existing `auth_failed` (push-PAT-specific, defined in *Flow → push step*) and `branch_conflict` arms. **Pro-active expiry warning is deferred** — surfacing "X days to rotation" via `/status` belongs in a follow-up once the conversation-status `/status` command grows a configuration-health section. Tracked in `todo.md` as a `p3`.

**Codex parallel.** Out of scope for slice 2. Codex CLI does not currently have a headless-token equivalent of `claude setup-token`; the Codex auth path will likely require seeding `~/.codex/auth.json` into the per-task home volume from a value held in the secrets table — same "freshly seeded per task, never bind-mounted" discipline. Tracked as a P2 follow-up; design slot reserved here so the secrets-table key namespace stays consistent (`codex_auth_json` alongside `claude_code_oauth_token`).

**Bare mode caveat.** `claude --bare` does not read `CLAUDE_CODE_OAUTH_TOKEN` ([authentication docs](https://code.claude.com/docs/en/authentication)). Cogmo invokes `claude -p` (full mode), not `--bare`, so this works as written. If a future invocation moves to bare, the auth path must change to `apiKeyHelper`.

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
  | { kind: "plan_ready"; plan: string }
  | { kind: "complete"; exitCode: number; usage?: BackendUsage; isError: boolean };
```

Two concrete impls: `ClaudeCodeBackend` (slices 1+2), `CodexBackend` (later). Selection per-task via `coding_tasks.backend`. Both `plan(ctx)` and `execute(ctx, sessionId)` return `AsyncIterable<CodingEvent>` directly — there is no bidirectional control-channel handle. `execute` resumes a prior session via `claude --resume <sid>`; session id is captured during the plan phase. Neither runner passes `--permission-prompt-tool stdio`, so the CLI resolves every tool decision locally and emits no `control_request` frames. Both runners write the prompt as a single stream-json `user` frame and immediately close stdin — the CLI treats stdin EOF as the graceful-shutdown signal under `--input-format stream-json`. See [Sandbox isolation](#sandbox-isolation-confirmed) for the security-boundary rationale.

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
3. **Post-hoc verify** — after the CLI declares done, Cogmo runs the verify command *once more* from outside the session. Trust but verify. If it passes, push and open the PR. If it fails, mark task failed and notify the user — no feedback-loop retry. The CLI had its chance during its own loop; a post-hoc miss is a "stuck" signal worth a human eye, not more tokens.

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

So the practical guarantee is **"managed policy cannot be removed, and Claude is instructed to let it win on conflict"** — not "managed policy is hard-enforced." This is enough because (a) the repo owner is the person who registered the repo with Cogmo in the first place (trust boundary is human, not technical), and (b) the sandbox + PR gate contain blast radius even if the instruction-following fails.

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

**One coding task = one working tree + one branch + one CLI session + one PR.** The task container from [sandbox.md](sandbox.md) is the execution environment; the working tree lives inside it (mounted from the host's worktree path). On bind-mount backends the tree is a **standalone clone** of the registered parent repo (`git clone --no-hardlinks`, `origin` set to `remote_url`), never a linked `git worktree`: a linked worktree's `.git` is a file pointing at an absolute gitdir inside the parent repo, which doesn't exist in the container once the tree is mounted at `/workspace` — and mounting the parent `.git` read-write would hand the sandbox write access to config/hooks that host-side git later executes. The self-contained clone is the same shape the Daytona backend gets from cloning inside the sandbox.

> **In-container ownership assumption (tracked follow-up).** In-container git over the bind-mounted clone assumes the container CLI user's uid matches the host worktree-owner uid; otherwise git's CVE-2022-24765 dubious-ownership check fires on the first command (`git status --porcelain` in `runCommitAndPush`). This holds today via sysbox id-mapped mounts plus the `vscode(1000) == cogmo(1000)` contract, so nothing sets `safe.directory` in production — but a `runc` deployment with mismatched uids would break it untested. The `worktree-in-container` integration test sets `safe.directory=/workspace` to scope itself to gitdir resolution, so it does not exercise this path. Hardening (a universal in-container `safe.directory`, a `chown` at create time, or a mismatched-uid test) is tracked as a `p2` in `todo.md`.

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
  conversation_id         UUID REFERENCES conversations(id),       -- triggering conversation; null for automated triggers (evolution, signal_pipeline). Nullable FK (ON DELETE no-action — same agent-store module, conversations are not pruned).
  goal                    TEXT NOT NULL,                          -- the task description (user-authored or machine-authored)
  trigger_source          coding_trigger_source NOT NULL,         -- determines gating (plan approval path)
  trigger_ref             TEXT,                                   -- optional pointer into the originating subsystem (evolution proposal id, signal batch id)
  backend                 coding_backend NOT NULL,
  worktree_assignment     JSONB,                                  -- WorktreeAssignmentSchema — discriminated union: {type:"host-path",branch,worktreePath} (bind-mount) | {type:"git-remote",branch} (git clones inside the sandbox). Null until allocate-worktree runs. Atomic by Zod-on-read-and-write — no half-allocated state.
  session_id              TEXT,                                   -- CLI session for resume
  container_id            UUID REFERENCES containers(id),         -- sandbox.md
  allow_privileged_runc   BOOLEAN NOT NULL,                       -- compat escape hatch; explicit at insert (no default)
  plan                    TEXT,                                   -- set after plan phase
  plan_approved_at        TIMESTAMPTZ,                            -- null for automated triggers (plan gate skipped)
  pr_metadata             JSONB,                                  -- PrMetadataSchema = { url, number, branchSha, openedAt }; null until 4.0g opens the PR. Atomic-by-Zod — no half-recorded state. Replaces the previous `pr_url TEXT` column.
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
  verify_timeout_seconds  INT NOT NULL DEFAULT 600,                -- wall-clock cap for the post-hoc verify step (slice 4.0e)
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

`verify_command` is invoked as `bash -lc "<verify_command>"` so the login-shell PATH covers version-manager shims (nvm, pyenv, rbenv) and so pnpm/uv/cargo resolve correctly. Rows are admin-registered, so the shell-string trust model matches the rest of the repo registry.

`remote_url` is **required and non-empty** for every row, including the auto-managed `skills` row. Empty-string was a pre-Daytona artefact and is rejected at every insert path (`validateRepoInput` for user-added repos; `ensureSkillsCodingRepo` skips the insert when no origin is attached and lets the wizard / `cogmo migrate-skills-remote` CLI heal the repo).

**Skills repo special case.** One `coding_repos` row is auto-bootstrapped at boot with `name = 'skills'` and `local_path = $COGMO_SKILLS_PATH` — see [skills.md → Repo location](skills.md#repo-location). It's the only row whose `local_path` is a **bare** repo (no working tree), and the only row where `register` (an operation outside coding-delegation) writes the authoritative `main` SHA and then pushes it to `remote_url` so the Daytona sandbox cloning from the remote sees the latest skill set. Every coding-delegation step downstream (allocate-worktree, push, fetch-feature-branch) treats this row identically to any other — `fetchFeatureBranch` already branches on bareness when writing the agent's feature branch back (`src/agent/coding/git-as-transport.ts`).

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
| Terminal task status (`pr_open`, `failed`, `cancelled`) | Short grace period for log flush (default 120s, `CODING_TASK_GRACE_SECONDS`) | Orchestrator calls `sandbox.deleteByTaskId(taskId)` → root-task cascade |
| Idle TTL | No CLI activity for `CODING_TASK_IDLE_TTL` (default 20 min) | Sandbox reaper TTL pass. `session_id` preserved in DB. |
| Cogmo restart | Boot reconcile | Sandbox crash-recovery pass ([sandbox.md](sandbox.md) → Crash Recovery) |
| LRU eviction under resource pressure | Disk / RAM threshold crossed | Oldest idle task containers first; active tasks protected |

Grace period exists so a just-pushed PR's streaming logs and resource-usage poll can finish before the container disappears.

### Worktree persistence

No compression, no S3, no tar dumps by default. The git remote is the archive; the worktree is a disposable checkout. ~99% of a worktree is reproducible junk (`node_modules`, `.venv`, `target/`, build caches) that our per-repo named cache volumes ([sandbox.md](sandbox.md) → Networks, Volumes, Images) rehydrate in seconds. The ~1% that matters — commits and uncommitted edits — belongs in git refs.

Teardown policy keyed on worktree state:

| State at teardown | Action |
|-|-|
| Clean, branch pushed, PR open | remove the clone — remote is authoritative |
| Dirty (uncommitted edits or unpushed commits) | Stage all, commit as `wip: <task-id>` on the task branch, push as `refs/cogmo-wip/<task-id>`, then remove |
| Failed before first commit with no remote yet (new repo bootstrap) | Fall back: tar under `~/.cogmo/archives/<task-id>.tar.zst` with 14-day TTL; only case that keeps a local dump |

Resume after full teardown replays this in reverse: re-materialize the clone on `<branch>` (or fetch the `refs/cogmo-wip/<id>` ref), cache volumes rewarm automatically, `--resume <session_id>` rehydrates the CLI. Costs a few extra seconds vs resume-within-TTL, which keeps the worktree live.

**`refs/cogmo-wip/<task-id>` retention.** These refs are append-only on the remote and accumulate if nothing prunes them. **P1: weekly cron** — prunes any WIP ref whose `coding_tasks` row is terminal and older than 30 days. Sufficient for personal scale; the refs live under `refs/cogmo-wip/` and don't clutter the branches list, so 30-day retention is low-pressure. Per-repo GitHub webhooks for minute-level cleanup on PR merge/close are a P3 optional — useful if hygiene becomes annoying, not worth the setup friction per registered repo at P1.

**S3 / remote object storage is opt-in, not default.** The motivating scenario — "my laptop died, I want the task back" — is already covered by remote refs for every case except the no-remote bootstrap. Deferred to a later remote-sandbox story.

### Run-branch cleanup `[confirmed]`

The git-remote transport pushes a `cogmo/run/<task-id>` ref to the remote at `allocate-worktree` time so the sandbox can clone it. Once the task reaches a terminal status (`pr_open` for success, `failed` for any failure path), that ref is dead weight on the remote. Cleanup follows a hybrid event-driven primary + cron safety-net pattern; full design lives in [sandbox.md → Daytona Backend → Orphan branch cleanup](sandbox.md#orphan-branch-cleanup-confirmed). At a glance: `cleanup-run-branch.ts` subscribes to `coding/task/pr-opened` and `coding/task/failed` and deletes immediately; `cleanup-orphan-run-branches.ts` runs weekly and sweeps anything missed.

The slice-4 PR namespace `cogmo/<idShort>` (different from `cogmo/run/*`) stays untouched — GitHub's `delete_branch_on_merge` setting cleans it up on merge, and the WIP-ref cron above prunes `refs/cogmo-wip/<task-id>` independently.

### Identity loading and `step.run`

Identity bundles (PAT + SSH private key) follow [scheduling.md → Don't return secrets through `step.run`](scheduling.md#dont-return-secrets-through-steprun-confirmed): `loadIdentity` is called inline (never wrapped in a step), and when consumed inside step bodies (`buildWorktreeSpec` → `sandbox.create`, the cleanup cron's per-ref deletes) the PAT is used internally and never returned. The orchestrator and `cleanup-orphan-run-branches.ts` both follow this pattern.

### Resume procedure `[confirmed]`

"Resume" never means "same container" — it means *same state, fresh shell*. Slice 2 ships the in-task variant (plan-phase container reaped before approval; execute recreates):

1. Look up `coding_tasks` row by id. If `status` is terminal and the user didn't explicitly ask to re-open, treat as a new task instead.
2. Reuse-or-create check: `sandbox.tryResumeByTaskId(taskId)` returns the live root session for the task or null. The local-Docker backend implements this by querying its `containers` table for `depth=0` rows and inspecting Docker; managed backends query their provider-side API. A non-null return means the prior session is still alive and the orchestrator skips step 3.
3. `sandbox.create(spec)` with the worktree spec the orchestrator's `allocate-worktree` step persisted (host-path or git-remote — see below). Fresh sandbox, same per-task lineage label. Local-Docker inserts a new `containers` row and stamps `coding_tasks.container_id`; managed backends leave the column null and rely on the sandbox's task-id label.
4. Re-attach a session handle on the orchestrator side via `sandbox.resume(sessionState)` — handles aren't JSON-serializable so they can't cross step boundaries; the state is.
5. `backend.execute(ctx, sessionId)` → `claude -p --resume <session_id> --permission-mode bypassPermissions` (or Codex equivalent). CLI rehydrates its conversation from its session file in the per-task home volume (Local-Docker named volume; Daytona auto-persists FS across stop/start). `bypassPermissions` matches the sandbox-is-the-boundary stance from the [Sandbox isolation](#sandbox-isolation-confirmed) section: every tool call resolves locally with no prompt. `acceptEdits` would still prompt on `Bash`, which the CLI routinely uses for `cat > file << EOF` writes and would silently deny in the absence of a stdio `--permission-prompt-tool`.

Cost: ~1–3s container start under sysbox plus cache-volume mount when the recreate path is taken. Acceptable because reuse is the common case (default 20-minute idle TTL covers most approve-tap intervals).

### "Addition" disambiguation

When the user sends a follow-up ("also add X", "now do Y"), Cogmo resolves to resume-vs-new using the last referenced task's state:

| Prior task state | Default resolution |
|-|-|
| Non-terminal (`planning` / `executing` / `pending_verify` / `verifying`) | Resume — same task, same branch, same session |
| `pr_open`, PR open unmerged | Ask — follow-up commit on the branch (resume) vs new task |
| `pr_open`, PR merged | New task, new branch; repo-knowledge from Hindsight carries context |
| `pr_open`, PR closed unmerged | Ask — retry on the same branch vs new task |
| `failed` / `cancelled` | New task by default; resume is opt-in |
| No prior task referenced | New task |

Conversation context is the primary signal — a follow-up inside an active task thread defaults to resume; a fresh thread defaults to new task. Ambiguity triggers an explicit question, never a silent choice.

## Concurrency `[proposed]`

Per-repo concurrency is capped by `coding_repos.max_concurrent_tasks` (default 1). New tasks beyond the cap queue and the user is told on Telegram that they're queued behind an active task.

**Branch and PR ownership is a non-issue.** Each task owns its own branch (`cogmo/<task-id-short>`) and its own PR. Two tasks editing the same files produce two PRs; the merge conflict surfaces at human review time, same as with any two humans on the same repo. No coordination required.

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

## Flow `[confirmed]`

```text
[Telegram: "refactor steering rules to support per-channel scoping"]
        │
        ▼
Cogmo orchestrator
  1. Resolve repo (keyword match or ask)
  2. Insert coding_tasks row, status='queued'
  3. Allocate working tree per `sandbox.capabilities.workingTreeTransport`:
     - bind-mount: git clone --no-hardlinks <repo> <path> && git checkout -B cogmo/<id-short>
     - git-remote: pushTaskBranchToRemote pushes default-branch tip to cogmo/run/<task-id>
  4. sandbox.create({worktree, ...}) → task container up; askpass mounted (Local-Docker) or uploaded (Daytona)
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
  claude -p --resume <sid> --permission-mode bypassPermissions --input-format stream-json
  Sandbox is the boundary; tool calls resolve inside the container with no per-call gate
  Text + tool-use events stream to Telegram progress message (edited in place)
        │
        ▼
Verify step (inside container):
  pnpm typecheck && pnpm lint && pnpm test
        │
        ▼
Push + PR:
  git push origin cogmo/<id-short>
  gh pr create --title "..." --body "<plan summary + test results>"
        │
        ▼
Telegram: "Task done. PR: <url>. Review from GitHub mobile when ready."
```

Failure at any stage: `status = 'failed'`, reason written, sandbox torn down, user notified with a link to the partial worktree for manual inspection.

### Inngest step boundaries

Same pattern as `handle-message` ([crash-recovery.md](crash-recovery.md)): Inngest re-invokes the whole function body at **every** step boundary, on success — not only on retry — so everything expensive, billable, or irreversible sits inside a `step.run`. The claude sessions and the verify suite included: a step body may stream to Telegram for minutes and only its small return value has to be JSON-serializable, and those live pushes are suppressed on replay, which is exactly what the progress UI wants. See [.claude/rules/inngest.md](../.claude/rules/inngest.md).

Re-entry guards live inside a conditional-UPDATE step, never as a bare-body status read. A guard like `if (task.status !== "pending_verify") return skipped` sitting above the step that writes `verifying` self-destructs on the next boundary — the re-invoked body reads its own write and abandons the run, stranding the task in a non-terminal status with no failure event to reconcile against. All three orchestrators open with the durable form — `set-status-planning` (`queued → planning`), `set-status-executing` (`awaiting_approval → executing`), `set-status-verifying` (`pending_verify → verifying`) — where the UPDATE fires only from the expected prior status and the body branches on the memoized result. Each sits where a lost race returns before the failure/teardown machinery, so a duplicate event can't flip a task another run owns to `failed`, and each returns `skipped` when it matches no row.

That transition is also the durable half of duplicate-event protection. Every hand-off event carries a `<verb>-<taskId>` idempotency id — `task-start-`, `plan-approved-`, `task-failed-` — which collapses a re-send inside the bus's dedup window; the transition is what holds outside it. Both matter for `coding/task/start` in particular, because the plan orchestrator's next moves are `sandbox.create` and a billable claude session.

| Step | Kind | Notes |
|-|-|-|
| `set-status-planning` | `step.run` | Conditional `queued → planning`. The plan run's ownership claim and its re-entry guard: a duplicate `coding/task/start` matches no row and returns `skipped` before a second container or a second plan session exists. Sits ahead of the try block so a lost race can't reach the failure machinery. |
| `allocate-worktree` | `step.run` | Branches on `sandbox.capabilities.workingTreeTransport`. **bind-mount:** idempotent host reconcile of a standalone clone — adopt when a clone already sits at the path on the right branch; otherwise stage `git clone --no-hardlinks` + `git checkout -B <branch>` + `git remote set-url origin <remote_url>` into `<path>.partial` and atomically rename into place (a legacy linked worktree found at the path is removed and re-materialized). **git-remote:** persists `{type:"git-remote", branch:"cogmo/<idShort>"}`, calls `pushTaskBranchToRemote` (`src/agent/coding/git-as-transport.ts`) which fetches `origin/<defaultBranch>` and force-pushes it to `cogmo/run/<task-id>` on the remote under one askpass helper. Identity is loaded inline from the secrets table — NOT inside `step.run` — so the PAT + SSH key never become a step return value. |
| `create-container` | `step.run` | Returns just `sessionState` (the discriminated `SandboxSessionState` blob). `sandbox.create()` builds the right `WorktreeSpec` variant via `buildWorktreeSpec`: bind-mount → `host-path` pointing at the host worktree; git-remote → `git-remote` pointing at `cogmo/run/<task-id>` with HTTPS basic-auth (`x-access-token`:`<pat>`). The Daytona SDK's `sandbox.git.clone()` materializes the run-branch inside the sandbox. Auth resolution happens INSIDE the step body — the PAT is consumed by `buildWorktreeSpec` and never returned, so Inngest doesn't persist it. |
| `plan-cli` | `step.run` | Spawns `claude -p --permission-mode plan` and threads its JSONL events into the plan stream and the DB. Durable because it is billable and has no `--resume` on the plan flags: a bare-body call replans from scratch at every later boundary and re-renders the plan into the user's message each time. The session-id write and the text pushes fire live from inside the body and are suppressed on replay; the return value is just the plan text plus an error flag, which also pins the step graph that branches on it. |
| `persist-container-id` | `step.run` (local-docker only) | Stamps `coding_tasks.container_id` with the local-Docker FK target. Skipped on managed backends (column stays null; lineage carried by sandbox-side task-id labels). Split out of `create-container` so a DB-write failure doesn't lose the container — `containerCreated` flag is set OUTSIDE the create step (Inngest replay safety) and the catch path's `deleteByTaskId` reaps via the task-id label regardless of whether the FK row was inserted. |
| `checkout-feature-branch` | `step.run` (git-remote only) | Post-clone `git checkout -B cogmo/<idShort>` inside the sandbox so `runCommitAndPush(branch="cogmo/<idShort>")` works unchanged. On the verify orchestrator's clone of the run-branch, HEAD already points at claude's executed commits (pushed by the execute-orchestrator's `commit-and-push-execute-changes` step), so the feature branch is created at that tip. Idempotent: `checkout -B` resets the branch to current HEAD if it already exists. Skipped on bind-mount (the worktree is already on the right branch from `allocate-worktree`). |
| `persist-plan` | `step.run` | Writes `coding_tasks.plan`, status `awaiting_approval` |
| `notify-plan-finalized` | `step.run` | Renders the finished plan into the user's message. Durable so the auto-approve path's two trailing boundaries don't re-render it. Subscriber errors are swallowed inside the body — status is already committed, and a delivery failure must not regress the task to `failed`. |
| *approval wait* | separate function | Not a `step.waitForEvent`: the plan run ends at `awaiting_approval`, and the Telegram Approve callback emits `coding/task/plan-approved`, which triggers `coding-task-execute` as its own run. Hours-to-days parking is free because nothing is held open. |
| `try-resume` | `step.run` (execute) | Calls `sandbox.tryResumeByTaskId` and returns the state or null. A non-null return means the execute orchestrator skips the create-fresh branch entirely — no fresh clone, no checkout, no auth resolution. |
| `execute-cli` | `step.run` | `claude -p --resume <sid>`, permission responses over stdin. Durable for the same reason as `plan-cli` — a billable session, re-run once per remaining boundary if left bare. Emits the `execute_started` banner and all text/tool pushes from inside the body, so the user sees one run's worth of progress. Returns `{isError, failureReason?, usage?}`. |
| `provision-askpass` | `step.run` (git-remote only) | Writes the per-task askpass dir on the host (PAT + signing key + helper script) before `create-container` so the execute sandbox can mount it. Returns the safe-to-persist paths (no secrets in the step return). Skipped on bind-mount: the host worktree is shared with the verify sandbox via the bind mount, so no separate transport step is needed and the verify orchestrator's own `provision-askpass` is the only call site. |
| `commit-and-push-execute-changes` | `step.run` (git-remote only) | After execute streaming succeeds and before `set-status-pending-verify`. Calls `runCommitAndPush` from inside the execute sandbox with `branch=cogmo/<idShort>` (local) and `remoteBranch=cogmo/run/<task-id>` (push refspec). claude's edits land on the run-branch on origin, where the verify sandbox's fresh clone will pick them up. Push failure marks the task `failed` with a descriptive `failure_reason` and skips the pending-verify transition. |
| `emit-cli-done` | `step.run` | Hand-off to the verify orchestrator via `coding/task/cli-done` event. Emitted after the durable `pending_verify` transition. |
| `run-verify` | `step.run` | Single post-hoc execution of `<coding_repos.verify_command>` inside the container (via `bash -lc`). **No retry loop in this step.** Iterating on failure was the CLI's job during the execute phase per *Prompt Construction → Self-verify clause*; this step exists only to confirm the CLI's "done" claim. Pass → proceed to push + PR; fail → mark task failed with the verify output. Budget caps (`task_token_budget`, `task_wall_time_seconds`) enforce termination of the execute phase upstream; this step is bounded by `coding_repos.verify_timeout_seconds`. Durable because it runs the repo's entire test suite — minutes of compute that a bare body would repeat at every later boundary — and because `ok` selects disjoint step sets downstream. `runVerifyStreaming` caps the captured `output` at 8 KiB, so the step return stays small. |
| `commit-and-push` | `step.run` | `git push origin cogmo/<idShort>` via slice 4.0f's `runCommitAndPush`. Non-fast-forward / rejected → `branch_conflict`; PAT auth fail → `auth_failed`; both surface as task failure with discriminated reason, no force push. Backend-agnostic: `runCommitAndPush` shells out via `execStreaming` inside the sandbox, so the same code path serves bind-mount and git-remote. The identity's PAT reaches the runner through the askpass env and the enclosing closure, never as a step argument or return. |
| `read-head-sha` | `step.run` (clean-tree path only) | `git rev-parse HEAD` when `commit-and-push` returned `nothing_to_commit` and there is no commit sha to reuse. Durable so the PR head is pinned to one value instead of being re-read — and possibly re-answered — at each later boundary. Conditional on `commit-and-push`'s memoized `kind`, so the step plan is identical on every replay. |
| `open-pr` | `step.run` | `octokit.pulls.create()` (ready for review, no draft flag) via slice 4.0g. Captured into `coding_tasks.pr_metadata` (atomic JSONB blob). Durable because opening a PR is irreversible and not idempotent upstream: 422 "already exists" surfaces as `validation_failed`, which the orchestrator reads as a task failure — so a bare-body call would let the run that had just opened the PR go on to mark its own task `failed`. The PAT is a closure argument, not a step argument, and `OpenPrResult` carries only the PR's public metadata. |
| `fetch-feature-branch` | `step.run` (git-remote only) | After PR open, host-side `fetchFeatureBranch` updates `refs/remotes/origin/cogmo/<idShort>` in the local mirror so the host's commit graph reflects the sandbox's push. Best-effort — origin is the source of truth. Skipped on bind-mount (the host worktree IS the source of truth). |
| `emit-task-failed` | `step.run` | On any failure path in plan / execute / verify, emits `coding/task/failed` so cleanup subscribers (run-branch deletion, future telemetry) hook in without polling the row. |
| `teardown-worktree` | `step.run` (host-path assignments only) | `safeTeardownWorktree` removes the clone on clean, `git add -A && commit && force-push HEAD:refs/cogmo-wip/<task-id>` on dirty/unpushed. git-remote assignments have no host worktree — the helper early-returns. |
| `teardown` | `try/finally` | `sandbox.deleteByTaskId(taskId)` cascades sandbox kill + clears the per-task askpass dir (slice 4.0d). Runs whether the orchestrator path succeeded or threw. The catch-path catch always calls `deleteByTaskId` when `containerCreated` is true — flag is set OUTSIDE the create step body so it survives Inngest replay. |

**Slice 4.0h orchestrator function.** The verify → push → PR sequence runs in its own Inngest function (`coding-task-verify`), triggered by `coding/task/cli-done` which the execute orchestrator emits after the durable `pending_verify` transition. The hand-off pattern keeps each function's retry policy independent and lets the execute container be torn down cleanly before verify spins up a fresh one with the askpass mount bound. Fires `coding/task/verify-complete`, `coding/task/pushed`, and `coding/task/pr-opened` events for observability + Telegram delivery.

Session handles can't cross a step boundary, so every step body that needs a container re-attaches via `sandbox.resume`. That is a live provider call, and the bare body runs once per boundary, so each orchestrator resolves it through a lazy per-invocation memo rather than eagerly at the top — the round-trips then scale with the container work actually performed rather than with the replay count. Same shape as `handle-message`'s durable `llm-iter<N>` sections; see [crash-recovery.md](crash-recovery.md).

### Per-callsite exec timeouts `[confirmed]`

Every `execStreaming()` call inside the orchestrator pair (plan + execute) and the verify orchestrator carries an explicit `timeoutMs` (total wall-clock) and `idleTimeoutMs` (no-byte-flow watchdog), so a wedged transport — Daytona WS half-close, hijacked Docker socket stall — surfaces as a fast `ExecTimeoutError` rejection on `wait()` instead of an indefinite block. Defaults live at the callsite, not on the backend; the backend interface defaults to "no cap" for any caller that omits them. See [sandbox.md → Wall-clock and idle timeouts](sandbox.md#wall-clock-and-idle-timeouts-confirmed) for the cleanup semantics.

| Callsite | `timeoutMs` | `idleTimeoutMs` | Rationale |
|-|-|-|-|
| `checkoutFeatureBranchInSandbox` (`git checkout -B`) | 60 s | 30 s | Fast op (~1 s in steady state). Both timeouts tight because there is no legitimate slow path. |
| `runClaudePlan` / `runClaudeExecute` (plan + execute streams) | 30 min | 5 min | Total cap is the absolute upper bound for one CLI invocation against current models. Idle cap catches WS-wedged-mid-stream while still allowing legitimate gaps between tool calls and thinking blocks. |
| `runCommitAndPush` (`git add`, `git commit -S`, `git push`) | 60 s for local-mutating commands; 5 min for `git push` (network upload) | 30 s | Push can take longer on a large delta; idle cap protects against a hung TLS connection mid-upload. |
| `run-verify` (`bash -lc <verify_command>`) | `coding_repos.verify_timeout_seconds` (default 600 s) | — | Verify keeps its existing `Promise.race(setTimeout)` total cap because the semantics differ: a genuine verify timeout produces `exitCode = TIMEOUT_EXIT_CODE (124)` persisted as the row's `failure_reason`, distinct from the `ExecTimeoutError` class. An idle cap on this callsite is a follow-up; verify is the last exec before sandbox teardown, so a wedged transport is bounded by the outer cleanup. |

A timeout fire is mapped to a task-level failure by the caller — `checkoutFeatureBranchInSandbox` rethrows the `ExecTimeoutError` so the orchestrator's outer `catch` sees it (which writes `failure_reason: "git checkout -B … timed out after 60s"` and emits `coding/task/failed`); `runCommitAndPush` rethrows; the claude runners turn it into a `complete` event with `isError: true` and a `failureReason` describing the cap.

## Autonomy Gates `[proposed]`

Two gates remain: plan approval (human reviews + approves the plan before execute) and merge (human reviews + merges the PR). The execute phase runs unattended inside the sandbox container — there is no per-tool-call runtime permission gate.

### Plan gate `[confirmed]`

Before any writes. Invoke the backend in plan mode (`claude -p --permission-mode plan` or Codex equivalent). Plan text is captured in `coding_tasks.plan` regardless of trigger source.

Gating depends on `trigger_source`:

- **`user`** — Plan posted to Telegram with inline keyboard: **Approve**, **Revise** (cancels the task and asks the user to describe what should change; the agent's next turn issues a fresh `delegate_coding`), **Cancel**. No edits happen until approved. Approval writes `plan_approved_at` and emits `coding/task/plan-approved`, which triggers the execute orchestrator. Identity check: `callback.from.id` resolves via `transportStore.resolveUser` to a Cogmo `userId` and must match the conversation owner — strangers in the same chat get `identity_rejected`.
- **`evolution` / `signal_pipeline`** — Plan proceeds to execute automatically. `plan_approved_at` stays null. The PR merge gate remains the single human checkpoint; no interactive approval on Telegram.

This keeps automated self-improvement flows non-blocking while preserving a human veto where it matters — at PR review. An automated task that produces a bad plan wastes its own tokens and parks a PR; it cannot modify the system without the human reviewer.

**Approval does not expire.** Once a plan is approved (`plan_approved_at` set), that approval stands until the task reaches a terminal state. The plan text lives durably in `coding_tasks.plan`; the task's branch is isolated from base-branch drift until merge; container resources are freed by the idle-TTL path independently of approval freshness. If execution is resumed hours or days after approval, the preserved `session_id` rehydrates the same plan into a fresh container. State-based invalidation (code SHA drift) is the industry norm here, not time-based; our task-branch isolation makes even that a non-issue. P3 polish: post a "still want to proceed?" confirmation if execution would start >24h after approval — reminder, not expiry.

**Approval idempotency.** `approvePlanIfPending` is atomic: a second tap returns `task_already_approved` without re-emitting the event. Telegram surfaces the duplicate as "already approved" toast and no state change.

**Per-profile auto-approve.** `profiles.coding_autoapprove_mode` (enum `off`/`on`, default `off`) lets a user opt a profile out of the Telegram approve/revise/cancel round trip. Resolved once per plan run via `coding_tasks → conversations → profiles`; null (task without a conversation) is treated as `off`. When `on` and `trigger_source = 'user'`, the plan orchestrator calls `approvePlanIfPending` itself once the plan text is persisted, takes the same `approved` branch the Telegram callback takes, and emits `coding/task/plan-approved` durably via `step.sendEvent`. The plan still streams to Telegram for visibility; only the gating round trip is skipped. `evolution` / `signal_pipeline` triggers already bypass the plan gate by design and are unaffected. Toggle via `/profile autoapprove <name> [on|off]`. Race-safe because `approvePlanIfPending` is atomic — if the user managed to tap Cancel between `set-status-awaiting` and the auto-approve step, the auto-approve becomes a no-op and the cancellation stands.

### Sandbox isolation `[confirmed]`

During execute phase. **The sandbox container is the security boundary.** There is no runtime per-tool-call permission gate; the CLI runs to completion against its prompt without bidirectional control-channel back-pressure. Two reasons this is the right call:

1. **The CLI doesn't expose the gate we'd need without explicit opt-in.** Anthropic's stream-json control protocol routes per-tool decisions through stdin/stdout only when `--permission-prompt-tool stdio` is passed (verified by reading the `@anthropic-ai/claude-agent-sdk` source: the SDK adds that flag only when a `canUseTool` callback is supplied, and OAuth-token auth is ToS-blocked from using the Agent SDK at all). Cogmo's CLI invocation doesn't pass it, so the CLI resolves every tool decision locally; a wrapper that reads `control_request` frames and writes `control_response` is reading frames that never arrive.
2. **The blast radius is bounded by sandbox + credential hygiene.** sysbox / Daytona isolates the filesystem; the Docker socket proxy blocks privileged / host-net / host-path / dangerous-caps creates; the configured `github_identity:<name>` PAT is the only credential capable of reaching outside, and the PAT's GitHub permissions cap what `git push` / `gh` can do. The remaining surface is "Claude burns cycles on a long-running command" — bounded by the per-task wall-clock and idle timeouts on `claude -p`.

**CLI invocation contract:**

| Flag | Plan | Execute | Why |
|-|-|-|-|
| `-p` | ✅ | ✅ | Headless mode. |
| `--output-format stream-json` | ✅ | ✅ | Required for stream-json output. |
| `--input-format stream-json` | ✅ | ✅ | Lets us frame the prompt as a `{type:"user"}` JSON line. |
| `--include-partial-messages` | ✅ | ✅ | Streams `text_delta`s so the user sees progress. |
| `--verbose` | ✅ | ✅ | Required by `--output-format stream-json`. |
| `--permission-mode plan` | ✅ | ❌ | Plan mode is read-only by CLI contract. |
| `--permission-mode bypassPermissions` | ❌ | ✅ | Default mode prompts on every tool call; with no stdio `--permission-prompt-tool` the CLI denies its own prompts and gives up after a few turns. Sandbox isolation is the boundary, not a per-tool gate. |
| `--resume <sessionId>` | ❌ | ✅ | Execute resumes the plan-phase session. |
| `--permission-prompt-tool stdio` | ❌ | ❌ | Would open the bidirectional control channel. We don't want it — sandbox is the boundary. |
| `--bare` | ❌ | ❌ | Skips CLAUDE.md / hooks / MCP / skills / plugins auto-discovery. Skipped because we *do* want the repo's CLAUDE.md to influence Claude (if the repo ships one). Reconsider per-repo if the auto-discovery cost matters. |

**Shutdown contract.** Stream-json input mode uses **stdin EOF as the CLI's graceful-shutdown signal**. Both runners write one user frame and close stdin immediately; the CLI emits `result` and exits. The contract is pinned by `src/agent/coding/claude-cli.integration.test.ts` against `cogmo-devbase:test` over `LocalDockerSandboxClient` (dockerode-hijacked stream): the test writes one user frame, closes stdin, and asserts both plan + execute flows emit `complete` within 4 min — well under the CLI's 5-min idle backstop. On `LocalDockerSandboxClient`, `stdin.end()` flows through dockerode's hijacked stream as a real pipe close. On `DaytonaSandboxClient`, `attachStdin: true` execs route to the PTY backend (`exec-pty.ts`); the prompt is uploaded to a tmpfile and the PTY shell runs `exec bash --norc --noprofile -c 'cat /tmp/... | exec <argv> 2> /tmp/stderr'`. The outer bash swap (`--norc --noprofile`) replaces Daytona's default interactive shell with a non-interactive one so neither readline echo nor `PROMPT_COMMAND` OSC sequences leak onto stdout. The inner `cat | exec` pipes the prompt so the CLI sees a pipe FD on stdin (claude 2.1.138 silently exits 0 when stream-json input arrives via a regular file FD — discovered while building the chat -> skill integration test). (Daytona's session-command HTTP path has no remote-EOF channel — `runAsync: true` commands pin the FIFO open with a long-running sleep by design — so any caller that needs stdin EOF must take the PTY path. See `design/sandbox.md` → Streaming exec.) The behaviour was originally cross-checked against `@anthropic-ai/claude-agent-sdk` (the official Node SDK published by Anthropic): the `query()` API's single-turn path closes stdin after writing the input message, then awaits the CLI's `result` event before exit. Re-verify against the SDK at any CLI version bump.

**External reach.** What can actually escape the sandbox today:
- **`git push` / `gh` writes** — bounded by the PAT's GitHub scope. Mitigation: provision the bot account with write access only to repos in `coding_repos`.
- **Outbound HTTP** — the container has network egress. Cost surface (API spend), not safety surface.
- **`docker run` via the proxy** — child containers inherit the proxy policy (no privileged, no host-net, no host-path); same cap as the parent.

No deny list, no auto-approve, no decision log, no Telegram inline keyboard, no `coding_tool_decisions` table. The user sees `tool_call` / `tool_result` events render in the task's progress stream — observability without runtime pause-points.

### Merge gate `[confirmed]`

The final artifact is a **ready-for-review PR**. Cogmo never pushes to `main` and never merges — the merge is the human-approval gate. The PR opens ready rather than as a draft: creation is already gated on the verify step passing, the sole reviewer is the user, and the draft state would only add a manual "ready for review" click (and suppress review-request notifications and some CI configurations) without guarding anything the merge gate doesn't. The user reviews the diff in GitHub Mobile (or desktop) using their normal review flow — branch protection, required checks, and reviewers apply.

## Git Identity `[confirmed]`

**P1 (slice 4):** Fine-grained PAT + Ed25519 SSH signing keypair on a dedicated `cogmo-bot` GitHub account. The PAT and signing key for one bot account are inseparable — they're stored as a single JSON-encoded bundle (`{ pat, sshPrivateKey, sshPublicKey }`, validated by `GitHubIdentitySchema`) in Cogmo's `secrets` table under the name `github_identity:<name>`. The setup wizard provisions `github_identity:default`; multiple identities can coexist and each repo selects one via `coding_repos.identity_name`.

**Setup wizard (slice 4.0b):** prompts for the PAT, validates against `GET https://api.github.com/user`, generates an Ed25519 keypair via `micro-key-producer/ssh.js` (returns OpenSSH-armored `privateKey` + `publicKey` strings + SHA-256 fingerprint), and prints the public key with a `https://github.com/settings/ssh/new` link instructing the operator to install it as a **signing key**. The private key never leaves the encrypted DB. Non-interactive setup accepts `COGMO_GITHUB_PAT` (with `_FILE` variant); pre-supplied private keys are not yet importable (slice 4 always generates a fresh keypair and prints the public key for installation).

**Per-task delivery (slice 4.0d):** the PAT is materialised into a per-task `GIT_ASKPASS` helper file under `${SANDBOX_ASKPASS_DIR}/<task-id>/` (default `/var/lib/cogmo/askpass/`); the SSH private key is dropped alongside and referenced per-invocation via `git -c gpg.format=ssh -c user.signingkey=<path> commit -S` (no global config — the per-`-c` form keeps the signing scope to the single commit and avoids polluting the in-container repo's `.git/config`). Both files are wiped on teardown.

**SSH commit signing:** OpenSSH key + the per-invocation `-c gpg.format=ssh -c user.signingkey=<path>` flags above. Commits show "Verified" on GitHub once the public key is registered as a *signing key* on the bot account. No GPG faff.

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

**Slice 4.0d wiring (concrete shape).** The orchestrator provisions a per-task askpass directory before `sandbox.create`:

```
${SANDBOX_ASKPASS_DIR}/<rootTaskId>/       (parent dir is 0700)
  helper           0755  — `#!/bin/sh; exec /bin/cat /tmp/cogmo-askpass/pat`
  pat              0644  — bot account's fine-grained PAT
  signing-key      0600  — OpenSSH-armored Ed25519 private key (ssh-keygen -Y sign refuses anything broader)
  signing-key.pub  0644  — corresponding `ssh-ed25519 ...` line
```

Helper script + PAT + public key are world-readable so the container's non-root CLI user can read them through the bind mount under runtimes that map container-uid to a host subordinate-uid (plain runc with userns, idmapped mounts without shift). Confidentiality stays with the parent dir's `0700`. The signing key is `0600` by necessity — `ssh-keygen -Y sign` refuses to load a key with broader permissions and aborts.

The directory is bind-mounted **read-only** at `/tmp/cogmo-askpass/` inside the container (Local-Docker) or uploaded via `fs.uploadFiles` then mode-set with `fs.setFilePermissions` (Daytona — same path layout, same modes). `/tmp` because Daytona's toolbox uploads as the sandbox image's non-root user (`vscode` in cogmo-devbase), which can't `mkdir /<anything>` at the container root. `provisionAskpass` returns env vars to thread into `exec` — `GIT_ASKPASS=/tmp/cogmo-askpass/helper` and `GIT_TERMINAL_PROMPT=0`; commit signing happens via `git -c gpg.format=ssh -c user.signingkey=/tmp/cogmo-askpass/signing-key` (env vars don't drive the signing path). The sandbox client's `deleteByTaskId` calls `cleanupAskpass` in its `try/finally`, idempotent under retries and a no-op when the directory was never provisioned. See `src/sandbox/askpass.ts` and `src/sandbox/daytona/askpass-upload.ts`.

## Repo Registry `[confirmed]`

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

This reuses the whole coding-delegation pipeline (sandbox, plan gate for user triggers, PR) for its own metacognition, which keeps one pattern rather than two.

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

Diffs are not rendered in Telegram. Link to GitHub for review. GitHub Mobile (since April 2026) natively supports reviewing Copilot cloud-agent diffs from a phone — Cogmo PRs use the same surface.

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
| Inngest worker stops responding mid-step | The `coding-task-reconcile` subscriber (see [Worker-death reconciliation](#worker-death-reconciliation-confirmed) below) listens on the system event `inngest/function.failed`, flips any non-terminal `coding_tasks` row whose `function_id` matches a coding orchestrator to `failed`, and emits `coding/task/failed` so the existing cleanup chain (run-branch delete, sandbox reap) fires. |

### Worker-death reconciliation `[confirmed]`

The in-worker `try/catch` inside `runCodingTask` / `runCodingExecute` writes `status='failed'` and emits `coding/task/failed` on every failure path it observes — but Inngest's `connect_worker_stopped_responding` terminal outcome (worker crash, OOM, SIGKILL, or the WS-wedge described in [sandbox.md → Streaming exec](sandbox.md#streaming-exec-proposed)) abandons the run *before* the catch can execute. The cogmo row is left in `planning` / `executing` indefinitely; the orphan-run-branch sweeper deliberately skips non-terminal rows ([cleanup-orphan-run-branches.ts](../src/agent/coding/cleanup-orphan-run-branches.ts) — "Non-terminal tasks are NEVER swept regardless of age — they may be stuck pending approval; the user owns that"), so the run-branch leaks too. This was the observed wedge that motivated the timeout pair above; the worker-death class is broader than the WS hang alone.

A per-function `onFailure` handler is **not** the right hook for this. Inngest's documented contract says `onFailure` fires "after maximum retries" ([handling-failures](https://www.inngest.com/docs/reference/functions/handling-failures)), and the open issue [inngest/inngest#3549](https://github.com/inngest/inngest/issues/3549) reports the symptom — runs stuck after a connect-mode worker disconnect, no clean terminal transition. The reliable hook is the system event [`inngest/function.failed`](https://www.inngest.com/docs/reference/system-events/inngest-function-failed), which fires environment-wide on every terminal-failed run regardless of how the worker exited.

A dedicated Inngest function `coding-task-reconcile` subscribes to that event with a CEL filter pinning it to the coding orchestrators (`coding-task-start`, `coding-task-execute`, `coding-task-verify`). The function body uses **two separate durable steps**, not one:

1. `step.run("reconcile", …)` — pull `function_id` + `event.data.event.data.taskId`, conditional UPDATE: flip non-terminal → `failed` with `failure_reason = "inngest run terminated abnormally (run_id <id>, function_id <fn>): <error.message>"`. Returns a discriminated result; the `reconciled` variant carries `failureReason` so the next step has the payload.
2. `step.sendEvent("emit-failed", { …codingTaskFailed.create({…}), id: \`reconcile-${run_id}\` })` — durable bus emit with an explicit idempotency `id` so a retry of this step after a transient send blip is deduplicated at the bus.

The split is load-bearing. Putting the emit inside the cached `step.run` is a durability bug: a transient `inngest.send` failure inside the body throws the step, Inngest retries, but the DB UPDATE committed on the first attempt — so the retry's conditional UPDATE returns `already_terminal` and the function returns `skipped`. The event never gets emitted. `cleanup-run-branch` never fires. Discovered in PR #267 review; pinned by the wrapper-level tests in `reconcile-on-failure.test.ts`.

Branch logic:
- `reconciled` (we wrote the row to `failed`) → run step 2.
- `already_terminal` (in-worker catch already wrote `failed` and emitted) → no step 2; double-emit would re-fire `cleanup-run-branch`.
- `not_found` / `missing_task_id` / `not_coding_orchestrator` → no step 2.

`retries: 3` on the reconcile function — DB blips during reconcile shouldn't lose a recovery — and the two-step split keeps retries safe: step 1's conditional UPDATE is idempotent on the DB side; step 2's `id` is idempotent on the bus side. Concurrency keyed on `event.data.run_id` prevents a duplicate event from doing duplicate work.

The 7-day permission-prompt wait is not at risk: it's a `step.waitForEvent`, not a `step.run`, so the run is parked durably and only terminates on event arrival or timeout — neither path emits `inngest/function.failed`. A genuine 7-day timeout would expire the wait and the orchestrator's normal path runs `set-status-failed`, so the reconcile sees a terminal row and no-ops.

**Multi-consumer idempotency contract for `coding/task/failed`.** Both paths above can emit the same logical "task failed" signal under different idempotency `id`s — the in-worker catch emits `task-failed-${taskId}`, the reconcile emits `reconcile-${run_id}`. The bus does NOT dedup across different ids, so a DB-blip path lands two events on the bus for the same task. Today's only consumer `cleanup-run-branch` collapses via function-level idempotency on `event.data.taskId` (`createRunBranchCleanupSubscriber` in [`src/agent/coding/cleanup-run-branch.ts`](../src/agent/coding/cleanup-run-branch.ts)), so the double-emit is harmless. **Any future subscriber on `coding/task/failed` must apply the same `taskId`-keyed idempotency** — single-event-id dedup is not safe to assume.

## Why this design `[confirmed]`

Lines up with documented industry patterns (late 2025 / Q1 2026):

- **Plan-first gating** is standard — Claude Code's plan mode, Cursor's plan mode, Cursor Auto's classifier-reviewed actions all converge here.
- **PR as merge gate** is universal — GitHub Copilot coding agent, Devin, Cursor background agents all end tasks with a PR rather than trying to render diffs in chat. (Multi-tenant products open drafts because their PRs land in repos with many watchers; Cogmo opens ready-for-review since the single user is the only reviewer — see Merge gate.)
- **Worktree-per-task** is Claude Code's own `-w` flag shape and Codex's experimental multi-agent pattern.
- **Session resume** via `--resume` or `--continue` is both CLIs' native feature — use it, don't reinvent.
- **Telegram UX** patterns (inline approvals, progress-in-one-message, ANSI stripping) are well-trodden in the reference bots.

## Implementation Phases `[proposed]`

Ship order. Each phase is independently useful — stop at any point and the prior phases still work.

### P1 — core loop

1. **Sandbox primitives.** `containers`, `cogmo_instances`, `networks`, `volumes` tables; sibling-container creation against host daemon with sysbox runtime; label injection; root-task cascade on teardown; reaper cron (TTL + orphan + stale-row passes). Proxy is **body-level pass-through** on `POST /containers/create` (no `HostConfig` filtering yet — P2 adds the Privileged/NetworkMode/Binds/CapAdd denies). Endpoint-category blocks (`/swarm/*`, `/plugins/*`, `/nodes/*`) are *always on* regardless of phase — they're structural, not body policy.
2. **Claude backend, plan-only.** Subprocess wrap with `--permission-mode plan`, JSONL parsing, session capture. Stream plan text to Telegram. Emit `plan_ready` with inline keyboard. No execute path wired yet.
3. **Plan approval + execute.** Approval writes `plan_approved_at`, orchestrator resumes the session via `--resume <sid>`. Text-delta streaming into a single edited Telegram message. Tool calls render as observability events (`tool_call` / `tool_result`); the sandbox container is the security boundary.
4. **Verify + push + PR.** In-container `pnpm typecheck && pnpm lint && pnpm test`, git commit + sign + push, `gh pr create`. Teardown policy (worktree persistence table) executes. Resource usage written to `coding_tasks.resource_usage`.

After (5): end-to-end working flow for the single-backend, trusted-repo case.

### P2 — breadth + hardening

6. **Codex backend.** Second `CodingBackend` impl, same interface. Selection per-task via `coding_tasks.backend`.
7. **Proxy policy enforcement.** Deny `Privileged`, `NetworkMode=host`, out-of-scope host binds, dangerous caps. Runtime injection. Registry allowlist.
8. **Devcontainer parsing.** Full `.devcontainer/devcontainer.json` support via the devcontainer CLI or equivalent — `image`, `features`, `postCreateCommand`, forwardPorts. Falls back to `cogmo/devbase` when absent.
9. **Vault socket for credentials.** Replace disk-based `.git-credentials` with a per-task Unix socket helper. Enables short-lived GitHub App installation tokens without writing them to disk.
10. **GitHub App migration.** Replace bot PAT with a Cogmo GitHub App and installation tokens. ~1-hour token expiry, per-task minted via the App's private key.
11. **Extract sandbox proxy to sidecar.** Second subcommand on the same image (`cogmo sandbox-proxy`), communicating with `cogmo serve` over tRPC. See [sandbox.md → Deployment Topology](sandbox.md#deployment-topology). Triggered when an in-process crash first disrupts a live task.
12. **Automated self-modification surface.** For `trigger_source IN ('evolution', 'signal_pipeline')`, expose read/write access to non-code configuration — `steering_rules`, `profiles.base_prompt`, and similar DB-backed assets — as direct domain operations, not through coding-delegation. Data changes don't need a diff, a PR, or a sandbox; they're atomic DB writes gated by which evolution stage holds the capability. Code/skill changes continue to flow through coding-delegation with its PR gate. Specified properly in [evolution.md](evolution.md); this phase is the wiring from evolution stages into those capabilities.

### P3 — polish

13. **Parallel tasks on the same repo.** Raise `max_concurrent_tasks` past 1; add the install-lock (Concurrency option B) on shared cache volumes. Narrow the lock to known racers (pip, apt) after measurement (option C).
14. **BuildKit policy enforcement.** Basic `buildx` works from P1 via transparent pipe on `/session`. This phase adds gRPC-level inspection via the BuildKit SDK for fine-grained policy — blocking `FROM` lines against unapproved registries, inspecting secret mounts, rejecting builds that would escape worktree scope.
15. **Observer repo-knowledge loop.** Post-task Observer extracts durable repo-facts and files a small follow-up coding task (`trigger_source = 'evolution'`) whose goal is to propose a `CLAUDE.md` edit. Normal PR gate applies. Once merged, Claude Code loads the new knowledge natively on every future task — no Cogmo-private store.

Each phase has a clear "done" bar: the prior phase's feature works unchanged, and the new one is opt-in behind config (not a silent behavior change).

## Open Questions

_All resolved; placement of follow-on questions will be added here as they arise._
