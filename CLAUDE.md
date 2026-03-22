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
| [decisions.md](design/decisions.md) | All decisions with rationale, eliminated options, adopted patterns |

## Stack

- **Language:** TypeScript on Node.js
- **Framework:** None — raw Anthropic SDK
- **Memory:** Hindsight (`@vectorize-io/hindsight-client`) + PostgreSQL + pgvector
- **Scheduling:** BullMQ + Redis (port 6380)
- **Interface:** Telegram (primary), adapter pattern for others
- **Deployment:** NixOS systemd service on nucleus (ASUS NUC, 8GB RAM)

## Rules

- No frameworks — raw SDK only. The agentic loop is ~30 lines.
- Memory writes are always additive. Dedup runs async via `reflect()`.
- Sub-agents never see API keys. Orchestrator makes all external calls.
- Every LLM call uses typed contracts (Zod schema in, Zod schema out) with retry + feedback injection.
- Self-evolution changes are gated: instruction file edits auto-apply, code/skill changes require human approval.
- Secrets via sops-nix `LoadCredential`, never in env files or git.
