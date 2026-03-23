# Assistant

Personal AI assistant runtime — modular agent system with persistent memory and self-evolution.

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
| [overview.md](design/overview.md) | Vision, constraints |
| [architecture.md](design/architecture.md) | Topology, data flow, component map |
| [memory.md](design/memory.md) | Hindsight, 4 networks, Observer extraction, retrieval |
| [evolution.md](design/evolution.md) | 6-stage self-evolution ladder, safety patterns |
| [scheduling.md](design/scheduling.md) | Inngest, event-driven orchestration, job types, agent self-scheduling |
| [agents.md](design/agents.md) | Agentic loop, sub-agents, channel registry, crash recovery |
| [integrations.md](design/integrations.md) | MCP, Telegram adapter, skill library |
| [infrastructure.md](design/infrastructure.md) | Runtime requirements, Docker Compose, secrets, deployment |
| [data-model.md](design/data-model.md) | PostgreSQL schema — all tables, relationships, migrations |
| [testing.md](design/testing.md) | Local dev, unit/integration/LLM tests, mocking, evaluation dataset |
| [tooling.md](design/tooling.md) | Dev stack — runtime, build, ORM, testing, logging, linting, Kotlin-feel patterns |
| [decisions.md](design/decisions.md) | All decisions with rationale, eliminated options, adopted patterns |

## Custom Commands

- `/next` — pick up the next task from `todo.md`

## Task Tracking

`todo.md` has four sections:

| Section | Purpose |
|-|-|
| **Next** | Actionable now, priority-ordered. `/next` picks from top. |
| **Later** | Future-phase work. Promote to Next when the phase begins. |
| **Blocked** | Waiting on something external. Only the user moves these to Next. |
| **Done** | Completed. |

- **Priorities:** `p1` (do soon — core, unblocks work), `p2` (do eventually), `p3` (do if bored — polish, cleanup). Format: `` `p1` `` tag before the task text.
- Mark tasks `[x]` and move to Done when completed.
- When completing a task, also check off the corresponding item in PROGRESS.md and add a dated entry to CHANGELOG.md (newest first — descending order).

Other tracking docs:

| Doc | Purpose |
|-|-|
| [PROGRESS.md](PROGRESS.md) | Phased delivery plan — big picture |
| [CHANGELOG.md](CHANGELOG.md) | Significant changes log |

## Stack

- **Language:** TypeScript on Node.js
- **Framework:** None — raw Anthropic SDK
- **Memory:** Hindsight (`@vectorize-io/hindsight-client`) + PostgreSQL + pgvector
- **Orchestration:** Inngest (self-hosted) — event-driven durable execution, scheduling, queues
- **Interface:** Telegram (primary), adapter pattern for others
- **Deployment:** Standard Node.js process (systemd, Docker, etc.)

## Code Style

- **Idiomatic TypeScript** — use classes, interfaces, enums where they make the domain clear. Prefer `interface` over `type` for object shapes (extendable). Use generics for reusable components.
- **Naming** — lowercase-hyphenated filenames (`steering-rules.ts`), `.test.ts` suffix for tests. PascalCase for classes/types/interfaces, camelCase for functions/variables.
- **Imports** — ESM with `.js` extensions (`import { foo } from "./bar.js"`). Named imports over default exports. Biome organises imports automatically.
- **Error handling** — `Result<T, E>` (neverthrow) at service boundaries and anywhere failure is expected. Exceptions only for programmer errors (bugs). Never `catch` and silently swallow.
- **Prefer libraries over bespoke code** — check if a well-maintained library solves the problem before writing a custom implementation. See `design/tooling.md` for the approved stack.
- **Use the stack** — Remeda for collection processing (not hand-rolled loops), neverthrow for Result types, ts-pattern for pattern matching, Zod for validation, Drizzle for queries. Don't reinvent what these provide.
- **Generalise where reasonable** — extract interfaces and shared types when two or more consumers exist. Don't over-abstract for hypothetical future use.
- **Tests** — write tests for new functionality. Use Vitest. Mock external services, test real logic. See `design/testing.md`.

## Working with Tools

- **IMPORTANT: Check versions** — before adding a dependency, check the latest version on npm and read the official setup/migration guide. Don't assume versions or config from memory — they go stale fast.
- **Research before building** — before implementing a feature, search for how it's done idiomatically in the framework/library you're using. Google "how to do X in Inngest/Drizzle/Fastify" before writing custom code.
- **Review existing tools** — before committing to a bespoke implementation, check if a maintained library or built-in feature covers the use case. Prefer battle-tested solutions.

## Autonomy

- Adding/updating dev dependencies, editing existing files, running tests — go ahead.
- Adding a new **runtime dependency** — discuss first (affects deployment size and RAM).
- Changing architecture patterns or data model — discuss first.

## Verification

After making changes, run: `pnpm typecheck && pnpm lint && pnpm test`

**Bug fixes: verify-then-act.** Prove the symptom (failing test or repro steps), identify root cause, propose fix, write a regression test. No shotgun debugging.

## Architecture Rules

- No frameworks — raw SDK only. Core loop ~30 lines, full orchestration ~200 lines.
- Memory writes are always additive. Dedup runs async via `reflect()`.
- Sub-agents never see API keys. Orchestrator makes all external calls.
- Every LLM call uses typed contracts (Zod schema in, Zod schema out) with retry + feedback injection.
- Self-evolution changes are gated: instruction file edits auto-apply, code/skill changes require human approval.
- Secrets never in env files or git. Use host secret management in production.
