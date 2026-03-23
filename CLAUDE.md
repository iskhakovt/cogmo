# Assistant

Personal AI assistant runtime — modular agent system with persistent memory and self-evolution.

## Architecture

Read `design/` for the full picture. Key docs:

| Doc | Contents |
|-|-|
| [overview.md](design/overview.md) | Vision, constraints, what exists on nucleus |
| [architecture.md](design/architecture.md) | Topology, data flow, component map |
| [memory.md](design/memory.md) | Hindsight, 4 networks, Observer extraction, retrieval |
| [evolution.md](design/evolution.md) | 6-stage self-evolution ladder, safety patterns |
| [scheduling.md](design/scheduling.md) | BullMQ, job types, agent self-scheduling |
| [agents.md](design/agents.md) | Agentic loop, sub-agents, channel registry, crash recovery |
| [integrations.md](design/integrations.md) | MCP, Telegram adapter, skill library |
| [infrastructure.md](design/infrastructure.md) | NixOS service, PostgreSQL, Redis, secrets, deployment |
| [data-model.md](design/data-model.md) | PostgreSQL schema — all tables, relationships, migrations |
| [testing.md](design/testing.md) | Local dev, unit/integration/LLM tests, mocking, evaluation dataset |
| [tooling.md](design/tooling.md) | Dev stack — runtime, build, ORM, testing, logging, linting, Kotlin-feel patterns |
| [decisions.md](design/decisions.md) | All decisions with rationale, eliminated options, adopted patterns |

## Tracking

| Doc | Purpose |
|-|-|
| [PROGRESS.md](PROGRESS.md) | Phased delivery plan — what's done, what's next |
| [CHANGELOG.md](CHANGELOG.md) | Significant changes log |

When completing work, update both: check off items in PROGRESS.md and add a dated entry to CHANGELOG.md.

## Stack

- **Language:** TypeScript on Node.js
- **Framework:** None — raw Anthropic SDK
- **Memory:** Hindsight (`@vectorize-io/hindsight-client`) + PostgreSQL + pgvector
- **Scheduling:** BullMQ + Redis (port 6380)
- **Interface:** Telegram (primary), adapter pattern for others
- **Deployment:** NixOS systemd service on nucleus (ASUS NUC, 8GB RAM)

## Code Style

- **Idiomatic TypeScript** — use classes, interfaces, enums where they make the domain clear. Prefer `interface` over `type` for object shapes (extendable). Use generics for reusable components.
- **Prefer libraries over bespoke code** — check if a well-maintained library solves the problem before writing a custom implementation. See `design/tooling.md` for the approved stack.
- **Use the stack** — Remeda for collection processing (not hand-rolled loops), neverthrow for Result types, ts-pattern for pattern matching, Zod for validation, Drizzle for queries. Don't reinvent what these provide.
- **Generalise where reasonable** — extract interfaces and shared types when two or more consumers exist. Don't over-abstract for hypothetical future use.
- **Tests** — write tests for new functionality. Use Vitest. Mock external services, test real logic. See `design/testing.md`.

## Working with Tools

- **IMPORTANT: Check versions** — before adding a dependency, check the latest version on npm and read the official setup/migration guide. Don't assume versions or config from memory — they go stale fast.
- **Research before building** — before implementing a feature, search for how it's done idiomatically in the framework/library you're using. Google "how to do X in Fastify/Drizzle/BullMQ" before writing custom code.
- **Review existing tools** — before committing to a bespoke implementation, check if a maintained library or built-in feature covers the use case. Prefer battle-tested solutions.

## Verification

After making changes, run: `pnpm typecheck && pnpm lint && pnpm test`

## Architecture Rules

- No frameworks — raw SDK only. Core loop ~30 lines, full orchestration ~200 lines.
- Memory writes are always additive. Dedup runs async via `reflect()`.
- Sub-agents never see API keys. Orchestrator makes all external calls.
- Every LLM call uses typed contracts (Zod schema in, Zod schema out) with retry + feedback injection.
- Self-evolution changes are gated: instruction file edits auto-apply, code/skill changes require human approval.
- Secrets via sops-nix `LoadCredential`, never in env files or git.
