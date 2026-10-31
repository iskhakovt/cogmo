# Cogmo

Personal agent runtime — modular system with persistent memory and self-evolution.

Glossary of core terms (Tool, Agent, Service, Channel, Conversation, Profile, Orchestrator, Steering Rules, Observer, etc.): see [design/overview.md](design/overview.md) → Glossary.

The rules in [`.agents/rules/`](.agents/rules/) are part of these instructions. Each section below that links one summarizes it; the file is the rule, so read it before working in its area. A new rule file gets a section here and an `@` import in `CLAUDE.md`.

## Design Doc Confidence Markers

Sections and decisions in `design/` docs carry a confidence marker:

| Marker | Meaning | How to act |
|-|-|-|
| `[confirmed]` | Validated and ready to implement. | Implement directly. Follow the spec. |
| `[proposed]` | Designed but not validated against real usage or best practices. | Research best practices before implementing. Challenge assumptions — the design may be wrong. Propose changes if research contradicts. |
| `[research]` | Captured from external research, not yet evaluated for this project. | Do not implement without evaluation. Check whether it applies to our constraints (single user, personal scale). Discuss with user before adopting. |

When a `[proposed]` or `[research]` item gets validated and implemented, upgrade its marker to `[confirmed]` in the doc.

## Architecture

Read `design/` for the full picture. Key docs:

| Doc | Contents |
|-|-|
| [overview.md](design/overview.md) | Vision, constraints, glossary |
| [architecture.md](design/architecture.md) | Topology, data flow, component map |
| [memory.md](design/memory.md) | Hindsight, 4 networks, Observer extraction, retrieval |
| [evolution.md](design/evolution.md) | 6-stage self-evolution ladder, safety patterns |
| [observation.md](design/observation.md) | Observer by turn — turn unit, per-turn state machine, failure modes, backfill, rollout |
| [scheduling.md](design/scheduling.md) | Inngest, event-driven orchestration, job types, agent self-scheduling |
| [agents.md](design/agents.md) | Agentic loop, sub-agents, crash recovery |
| [crash-recovery.md](design/crash-recovery.md) | Durability map of `handle-message`, what re-executes on retry, test contract |
| [context-management.md](design/context-management.md) | Token counting, compaction pipeline, model registry |
| [prompt-caching.md](design/prompt-caching.md) | Byte-stable prompt prefix, per-turn context on the user message, provider-neutral cache intent, usage accounting |
| [transport/](design/transport/) | Messaging architecture — adapters, sessions, debounce, routing, identity |
| [voice.md](design/voice.md) | Voice messages — speech-to-text inbound, text-to-speech outbound, pluggable providers |
| [operator-facade.md](design/operator-facade.md) | Plan to split `Transport` into the channel contract and an operator-command surface |
| [web-ui.md](design/web-ui.md) | Browser cockpit — in-process UI server, oRPC admin API, SSE chat, auth, Ledger design system |
| [integrations.md](design/integrations.md) | Channel adapters, skill library, permission tiers, plugin extensibility |
| [integrations/mcp.md](design/integrations/mcp.md) | MCP client — server config, lifecycle, sandboxing, schema pinning, profile filtering |
| [providers.md](design/providers.md) | Multi-provider LLM routing, `llm_providers` table, profile FK, provider dispatch |
| [image-generation.md](design/image-generation.md) | Image gen via Vercel AI SDK, fal.ai provider, outbound delivery, why AI SDK for images but not text LLMs |
| [sandbox.md](design/sandbox.md) | Container sandbox — sysbox-default runtime, Docker API proxy, lineage tracking, reaper |
| [skills.md](design/skills.md) | Skill execution — Python, two-tier runtime (Pyodide WASM + sysbox), warm pool, git-backed library |
| [coding-delegation.md](design/coding-delegation.md) | Claude Code / Codex CLI subprocess delegation, worktree + draft-PR flow, autonomy gates |
| [pipelines.md](design/pipelines.md) | User-defined pipelines — free text compiled to typed stage definitions, DB-backed runs, gates, bounded loops |
| [agent-resilience.md](design/agent-resilience.md) | Failure taxonomy, in-loop repair, degraded reply, stuck-loop detection |
| [setup.md](design/setup.md) | Guided setup wizard UX contract — interactive flow, re-runnable behavior, non-interactive mode |
| [infrastructure.md](design/infrastructure.md) | Runtime requirements, Docker Compose, secrets (encrypted DB, master key, HKDF, `_FILE` convention), deployment |
| [data-model.md](design/data-model.md) | Table index — points to schemas in domain docs, deferred tables, design decisions |
| [testing.md](design/testing.md) | Local dev, unit/integration/LLM tests, mocking, evaluation dataset |
| [tooling.md](design/tooling.md) | Dev stack — runtime, build, ORM, testing, logging, linting, Kotlin-feel patterns |
| [decisions.md](design/decisions.md) | All decisions with rationale, eliminated options, adopted patterns |

## Skills

Skills live in [`.agents/skills/`](.agents/skills/), one `SKILL.md` folder each: `next` picks up the next task from `todo.md`, `cogmo-review` runs the conformance review, `dependency-sweep` bumps dependencies, `html` renders a Markdown file to HTML. Codex reads them there and invokes one as `$<name>`; Claude Code reads each through a symlink in `.claude/skills/` and invokes it as `/<name>`, so a new skill needs that symlink too.

## Task Tracking

`todo.md` has three sections:

| Section | Purpose |
|-|-|
| **Next** | Actionable now, priority-ordered; work is picked from the top. Subheaded by topic; priorities still sort within each subsection. |
| **Later** | Future-phase work. Promote to Next when the phase begins. Subheaded by topic; priorities still sort within each subsection. |
| **Blocked** | Waiting on something external. Only the user moves these to Next. |

- **Priorities:** `p1` (do soon — core, unblocks work), `p2` (do eventually), `p3` (do if bored — polish, cleanup). Format: `` `p1` `` tag before the task text.
- When completing a task, **delete the entry** from `todo.md`, check off the corresponding item in progress.md, and drop a fragment in [`changelog.d/`](changelog.d/). **All three changes land in the same PR as the implementation, before the PR opens** — so when the PR merges, `main` already has the correct state. Don't open a PR with stale todo/progress entries planning to clean up post-merge: that leaves a brief window where `main` has the entry shipped but not removed, and risks the cleanup never landing if you forget.
- The changelog fragment is the durable record (`todo.md` doesn't keep a graveyard). Filename: `YYYY-MM-DD-short-slug.md` — pick a slug specific enough that two parallel PRs the same day won't collide (use words from the actual change, not generic ones). Body is plain Markdown — the rich prose entry, no leading date or table syntax. Never edit existing fragments. One fragment per PR avoids merge conflicts on parallel PRs.

Other tracking docs:

| Doc | Purpose |
|-|-|
| [progress.md](progress.md) | Phased delivery plan — big picture |
| [changelog.d/](changelog.d/) | Significant changes log — one Markdown fragment per PR |

## Stack

- **Language:** TypeScript on Node.js
- **Framework:** None — raw Anthropic SDK + OpenAI SDK (for OpenAI-compatible providers); Vercel AI SDK for image generation only ([design/image-generation.md](design/image-generation.md))
- **Memory:** Hindsight (self-hosted server + HTTP client) — PostgreSQL + pgvector managed by Hindsight
- **Orchestration:** Inngest (self-hosted) — event-driven durable execution, scheduling, queues
- **Interface:** Telegram (primary) and a browser web UI, adapter pattern for others
- **Storage:** PostgreSQL via Drizzle; S3-compatible object storage for files and attachments
- **Deployment:** one Docker image running a single Node.js process ([deploy.md](deploy.md))

## Module Structure

**Workspace layout.** The repo is a pnpm workspace. The backend is the `cogmo` package at **`apps/server/`** — every `src/...` path in this file, `.agents/rules/`, and `design/` is relative to it (the package's internal layout is unchanged by the workspace split). The other members are `apps/web/` (the web UI SPA) and `packages/contracts/` (shared by both apps — Transport DTOs/enums + the oRPC `webContract`; ships TS source, no build). The repo root holds workspace config (`pnpm-workspace.yaml`, root `package.json`, `biome.json`), the docs (`design/`, `todo.md`, `progress.md`, `changelog.d/`), and tooling. Root `pnpm lint` and `pnpm typecheck` cover the whole workspace; `pnpm test` and `pnpm build` proxy to `--filter cogmo`. See [design/web-ui.md](design/web-ui.md).

| Module | Responsibility | Rule |
|-|-|-|
| `src/agent/` | Agentic loop, tool registry, service interface, prompt assembly, tools (memory, web, file, core memory, image, sub-agents, scheduling), Observer/evolution, coding delegation, pipelines, model catalog | Domain logic — how the agent thinks and acts |
| `src/transport/` | Channel adapters (Direct, Telegram, Web), delivery router, attachment store, session management, identity | Transport — how messages arrive and responses are delivered |
| `src/db/` | Connection pool, transaction helper | Pure infrastructure — no schemas, no business logic |
| `src/inngest/` | Inngest client, event definitions, the `Durable` step port and its `fromStepTools` adapter, `EventPublisher` | Orchestration infrastructure — client setup, event schemas and the port use cases plan steps through; no business logic. See [design/architecture.md](design/architecture.md) → Orchestration Coupling |
| `src/llm/` | LLM provider interface, SDK adapters (Anthropic, OpenAI-compatible), canonical types (ContentBlock, StreamEvent, ImageBlock) | Single LLM call — provider abstraction, request/response translation |
| `src/memory/` | Memory provider interface, Hindsight adapter | Memory access — provider abstraction, HTTP client |
| `src/cli/` | `cogmo` operator commands — one cmd-ts command tree per command group, the shared runner (`run.ts`) and argument parsers (`args.ts`) | Transport edge — parses the command line and calls use-cases; a handler loads its own dependencies and resolves to the exit code. Domain modules never import from here. |
| `src/mcp/` | MCP client — server registry, connections, tool approval, `mcp_servers` store | Domain logic — MCP servers as a tool source |
| `src/skills/` | Skill library — git-backed repo, dispatcher, Pyodide and sysbox workers, `ctx` handler, cron, `skills` store | Domain logic — user skills and their runtime |
| `src/sandbox/` | Container sandbox — supervisor, Docker API proxy, Daytona backend, reaper, lineage store | Domain logic — isolated execution for coding and skills |
| `src/voice/` | TTS/STT providers, voice-mode resolution | Domain logic — voice input and output |
| `src/secrets/` | Encrypted secrets store (AES-256-GCM, HKDF), GitHub/SSH credential helpers | Domain logic — credentials at rest |
| `src/setup/` | `cogmo setup` wizard, non-interactive setup, seed, reset | Transport edge — operator setup over the domain use cases |
| `src/boot/` | Staged `cogmo serve` bootstrap (core → sandbox → skills → runtime) and shutdown | Composition root — wires implementations to interfaces; no domain logic |
| `src/web/` | Web UI server — promoted health router, oRPC admin API over `Transport`, fail-closed session auth (`web_sessions`), static SPA serving | Transport edge — a thin HTTP/RPC adapter that calls `Transport`/use-cases, no domain logic |
| `src/util/` | Cross-cutting pure helpers (retry, etc.) | Stateless utilities only — no I/O ownership, no domain logic. If a helper needs DI, it belongs in a domain module instead. |

**Infrastructure modules (`db/`, `inngest/`, `llm/`, `memory/`) contain only core setup and abstractions.** Business logic that uses them lives in domain modules (`agent/`, `transport/`, `skills/`, `sandbox/`, `mcp/`, …). Example: the Inngest event definitions live in `src/inngest/events.ts`, but the `handle-message` orchestrator function that uses them lives in `src/agent/`. Every Inngest function lives in the domain module that owns its work, never in `src/inngest/`.

## Store Pattern

Per-domain store layout, the `tx`-first method shape, use-case files, and the REPEATABLE READ default. See [.agents/rules/store-pattern.md](.agents/rules/store-pattern.md).

## Commits & PRs

- **Conventional Commits** — all commit messages and PR titles must follow the [Conventional Commits](https://www.conventionalcommits.org/) spec. Format: `type(scope): description`. The description must start with a **lowercase letter** — commitlint's `subject-case` rule rejects sentence-case, even for proper nouns (write `telegram` not `Telegram`). This drives semantic-release — wrong format means no release. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full type→version-bump table, examples, and the CI/release workflow.
- **No force pushes** — always create new commits to address review feedback. Force pushes erase review context, break comment threading, and make it impossible to see what changed between rounds. Amending is only acceptable before the first push of a branch.
- **Merge over rebase** — use `git merge` to incorporate upstream changes, not `git rebase`. Merge preserves the original commit graph, keeps review comments attached to their commits, and avoids the force push that rebase requires.
- **PR bodies and commit messages: pass markdown via `--body-file`, never via shell heredoc.** Backticks (`\``) and triple-backtick fences inside a heredoc-built `--body "$(cat <<'EOF' ... EOF)"` get mangled — `gh` (or the shell) escapes them to literal `\\\`` sequences that GitHub renders as a backslash next to a backtick. Same risk for any embedded `$`, `!`, or shell-special character. Write the body to a tempfile with a file-writing tool, not the shell, and pass `gh pr create --body-file /tmp/pr-body.md` (or `git commit -F /tmp/msg.md`); no shell interpolation, no escape surprises. Verify after with `gh pr view <n> --json body -q .body | head` — if you see `\\\``, the file went through a heredoc.
- **PR bodies: no per-file breakdowns or LOC counts.** Don't restate the diff. A list of changed files with `+N / -M` annotations duplicates what GitHub already renders and wastes the reviewer's attention. State *what* changed and *why*; let the file tree do its job. **Exception:** when a single logical change is intentionally distributed as small adjustments across many files (a rename refactor, a mechanical migration touching dozens of callsites, a cross-cutting flag rollout), a brief grouping helps the reviewer scan — call it out only then.
- **Before opening a PR, audit test coverage on the changed surface.** New behavioral branches with no test, error paths that silently degrade with no regression test, contracts only exercised indirectly through happy-path tests — find them and either add coverage or flag the gap explicitly in the PR body. Reviewers should not be the ones discovering "the failure path isn't tested." When you add a try/catch that swallows errors into a degraded return, that catch deserves a test before the PR opens.

## Code Style

TypeScript idioms, naming, imports, error handling, casts, encapsulation. See [.agents/rules/code-style.md](.agents/rules/code-style.md).

## Testing

Principles, test tiers, PGlite store tests, record/replay mocks, integration test isolation. See [.agents/rules/testing.md](.agents/rules/testing.md).

## Sub-agents

Constraints every sub-agent brief must carry, and how to run several without them colliding. See [.agents/rules/subagent-briefs.md](.agents/rules/subagent-briefs.md).

## Working with Tools

- **IMPORTANT: Research the documented approach first.** Before implementing anything that involves infrastructure, library integration, testing patterns, or deployment — search for the official docs and best practices. The documented approach is almost always better than a workaround. This has been validated repeatedly: Docker Compose profiles, Inngest connect mode for testing, testcontainers patterns. Don't debug symptoms when the root cause is "we're not using the tool the way it was designed." If you catch yourself iterating through trial-and-error, stop and google.
- **Check versions** — before adding a dependency, check the latest version on the registry and read the official setup/migration guide. Don't assume versions or config from memory — they go stale and may not exist. Verify the specific version you pin actually exists upstream before committing. Check both the latest release and the latest LTS; if they differ, ask the user which to use.
- **Verify runtime compatibility** — when a pinned tool has runtime requirements (engine fields, etc.), check that the execution environment provides what it needs. Don't assume CI runners, dev machines, or base images have a compatible runtime by default.
- **Review existing tools** — before committing to a bespoke implementation, check if a maintained library or built-in feature covers the use case. Prefer battle-tested solutions.

## Autonomy

- Adding/updating dev dependencies, editing existing files, running tests — go ahead.
- Adding a new **runtime dependency** — discuss first (affects deployment size and RAM).
- Changing architecture patterns or data model — discuss first.
- **Scope the domain before implementing.** Walk through real use cases and challenge every abstraction before writing code. Ask: what are the entities, how do they relate, what changes independently? If two things evolve at different rates or serve different consumers, they're separate concerns — don't merge them because they happen to be available together. E.g.: "what the user said" and "how it was delivered" feel like one thing at arrival time, but one is conversation history and the other is transport — different lifecycles, different consumers, different tables.

## Verification

After making changes, run: `pnpm typecheck && pnpm lint && pnpm test`

**Conformance review:** the `cogmo-review` skill checks a change against these rules (idioms, architecture, state machines, Inngest, data, tests, bookkeeping) with `cogmo-review code <PR | branch | range>`, and a design doc against [state-machines.md](.agents/rules/state-machines.md) with `cogmo-review design <path>`. Its checklist is [reviewer.md](.agents/skills/cogmo-review/reviewer.md); Claude Code runs it in the read-only `cogmo-reviewer` agent. Run it before opening a PR and before approving a design, alongside a bug review (`/code-review` in Claude Code).

**Bug fixes: verify-then-act.** Prove the symptom (failing test or repro steps), identify root cause, propose fix, write a regression test. No shotgun debugging.

## Design Philosophy

- **Build for the long term, not just the next feature.** This is not an MVP hack — it's a system designed to grow. Before implementing, think about how each piece interacts with the rest: how will this work with memory extraction? With multi-channel? With evolution? If a shortcut now creates a rewrite later, take the longer path. Stop and think about how pieces fit together before writing code.
- **Early abstractions pay off** — define interfaces and typed contracts upfront. A clean LLM provider interface costs nothing now and saves a rewrite later.
- **Event decoupling** — components communicate via Inngest events, not direct imports. The orchestrator emits `response/ready`; channel adapters listen independently. Adding a new channel never touches the orchestrator.
- **Thin infrastructure layers** — Inngest functions are controllers: receive event, call domain services, emit events. Domain logic lives in the domain modules and is testable without Inngest.
- **Domain owns logic, infra owns wiring** — use cases plan durable steps through the `Durable` port in `src/inngest/`, not Inngest's `step` (single-step handlers may call `step` directly; the multi-step exceptions are listed there); the functions themselves are Inngest's by design (design/architecture.md → Orchestration Coupling). If swapping Anthropic for OpenAI, only `src/llm/anthropic.ts` changes.
- **Design for pluggability** — prompts, tools, LLM providers, and channels each have an explicit interface (`LlmProvider`, `Service`, `Adapter`, `Transport`, etc.) that defines the plugin contract. All code depends on these interfaces, never on concrete implementations. Today they're in-process; in the future they become the boundary for external plugins (WASM, MCP, containers). Every new extension point must define its interface first. See `design/integrations.md`.
- **Service interface for tools** — tools access external systems exclusively through `Service`, never via direct service references. The orchestrator scopes the service per request (e.g., memory scoped to the current user's bank) and controls what each tool can access (ACL boundary). This is the same interface whether tools run in-process or in WASM. Tool inputs are validated at runtime — Zod for in-process TypeScript tools, JSON Schema validator for future plugins. See `design/agents.md` → Tool Architecture.

## Architecture Rules

Transactions, UUIDv7 PKs, NOT NULL by default, JSONB+Zod, migrations from `pnpm db:generate`, secrets handling. See [.agents/rules/architecture-rules.md](.agents/rules/architecture-rules.md).

## State Machines

Anything with a lifecycle is an explicit state machine: a durable unit, a `pgEnum` status, a transition table and a failure-mode table in the design before code; conditional-UPDATE transitions, exhaustive matching and `Result` errors in the code. See [.agents/rules/state-machines.md](.agents/rules/state-machines.md).

## Inngest

Replay model (per-boundary re-invocation on success), what belongs in a step, step-id determinism, tool durability policy. See [.agents/rules/inngest.md](.agents/rules/inngest.md).
