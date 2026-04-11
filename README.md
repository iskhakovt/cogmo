# Cogmo

[![Release](https://img.shields.io/github/v/release/iskhakovt/cogmo?label=release&color=blue)](https://github.com/iskhakovt/cogmo/releases)
[![ghcr](https://img.shields.io/github/v/release/iskhakovt/cogmo?label=ghcr&logo=docker&color=2496ED)](https://github.com/iskhakovt/cogmo/pkgs/container/cogmo)
[![CI](https://github.com/iskhakovt/cogmo/actions/workflows/ci.yml/badge.svg)](https://github.com/iskhakovt/cogmo/actions/workflows/ci.yml)

Personal agent runtime — modular system with persistent memory and self-evolution.

## What

An event-driven personal agent runtime built on raw provider SDKs and Inngest. Messages flow through a durable pipeline: channel adapters receive input, an orchestrator routes through an agentic loop (LLM calls + tool execution), and responses fan back out via events. No channel knows about any other channel. No framework — just typed interfaces and dependency injection.

See `design/` for the full architecture.

## Stack

- **TypeScript** on Node.js 24+
- **Anthropic SDK** + **OpenAI SDK** behind a provider-agnostic LLM interface
- **Inngest** (self-hosted) — event-driven durable execution, scheduling, queues
- **Hindsight** — self-hosted memory server (vector + extraction)
- **PostgreSQL 18+** with pgvector — application state and Hindsight storage. PG 18 ships native `uuidv7()`; older versions fall back to a SQL polyfill in `scripts/init-db.sql`.
- **Drizzle** — schema-as-code, forward migrations
- **Vitest** — three-tier tests (unit / integration / e2e) with PGlite and testcontainers

## Quick Start

Infra runs via testcontainers (no `docker-compose.yml`). `pnpm dev` starts Postgres, Redis, Inngest, and Hindsight, applies migrations, then runs the app:

```bash
ANTHROPIC_API_KEY=sk-... pnpm dev
```

Or run infra only and start the app yourself in another terminal:

```bash
ANTHROPIC_API_KEY=sk-... pnpm dev:infra   # prints env vars, leaves containers running
pnpm dev:app                              # tsx watch src/index.ts
```

Containers use `withReuse()` and survive across restarts. Stop them with `docker stop` when done.

Talk to the running cogmo from a separate terminal:

```bash
pnpm console
```

## Testing

```bash
pnpm test              # unit (PGlite, mocked LLM)
pnpm test:integration  # in-process pipeline + testcontainers + llmock
pnpm test:e2e          # app as subprocess against full container stack
pnpm test:all          # everything

pnpm typecheck && pnpm lint && pnpm test   # full local check
```

LLM calls in integration/e2e are served by `@copilotkit/aimock` from recorded fixtures. Re-record with `pnpm test:record` after changing prompts or tools.

## Architecture

```
Telegram / Direct / future channels
  → src/transport/    (channel adapters, sessions, debounce)
    → Inngest event: inbound/arrived
      → src/agent/    (orchestrator: prompt assembly + agentic loop)
        → src/llm/    (provider abstraction)
        → src/memory/ (Hindsight client)
      → Inngest event: response/ready
    → src/transport/  (delivery router → adapter)
```

Domain logic lives in `src/agent/`, `src/transport/`, `src/llm/`, `src/memory/`. Inngest functions in `src/inngest/` are thin wiring — zero business logic. See `design/architecture.md` and `design/transport/` for details.

## License

Private.
