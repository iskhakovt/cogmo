# Assistant

Personal AI assistant runtime — modular agent system with persistent memory and self-evolution.

## What

An event-driven AI assistant built on the Anthropic SDK and Inngest. Processes messages through a durable pipeline: channel adapters receive input, an orchestrator routes through an agentic loop (LLM calls + tool execution), and responses flow back via event fan-out. No channel knows about any other channel. No framework — just typed interfaces and dependency injection.

## Stack

- **TypeScript** on Node.js 24
- **Anthropic SDK** — provider-agnostic LLM layer (Anthropic first, others plug in)
- **Inngest** — event-driven durable execution (self-hosted, dev mode)
- **PostgreSQL** + pgvector — conversations, messages, steering rules, vector memory
- **Drizzle** — ORM, schema-as-code, forward migrations
- **Vitest** — unit + integration tests with testcontainers

## Quick Start

```bash
# Start infrastructure (postgres, redis, inngest)
docker compose up -d

# Apply migrations
pnpm db:migrate

# Run the assistant (needs ANTHROPIC_API_KEY)
ANTHROPIC_API_KEY=sk-... pnpm dev
```

## Testing

```bash
# Unit tests (fast, no Docker needed)
pnpm test

# Integration tests (spins up all containers via testcontainers)
pnpm test:integration

# Everything
pnpm test:all
```

## Architecture

```
CLI / Telegram / API
  → Inngest event: message/received
    → handle-message (orchestrator)
      → load context → assemble prompt → agentic loop → persist
      → emit: message/response
    → cli-respond / telegram-respond (channel adapters)
```

Domain logic in `src/agent/`, `src/llm/`, `src/channels/`. Inngest functions in `src/inngest/` are thin wiring — zero business logic. See `design/` for the full architecture docs.

## License

Private.
