# Cogmo

[![Release](https://img.shields.io/github/v/release/iskhakovt/cogmo?label=release&color=blue)](https://github.com/iskhakovt/cogmo/releases)
[![ghcr](https://img.shields.io/github/v/release/iskhakovt/cogmo?label=ghcr&logo=docker&color=2496ED)](https://github.com/iskhakovt/cogmo/pkgs/container/cogmo)
[![CI](https://github.com/iskhakovt/cogmo/actions/workflows/ci.yml/badge.svg)](https://github.com/iskhakovt/cogmo/actions/workflows/ci.yml)

<!--
  Drop the cuttlefish mascot here when ready.
  Suggested: `docs/assets/cogmo.svg` (vector for logos) or `.png` (digital identity),
  rendered with: <p align="center"><img src="docs/assets/cogmo.svg" width="200" alt="Cogmo"></p>
-->

Self-hosted personal agent runtime with persistent memory, a Telegram interface, and an evolving prompt that learns from every conversation. Built for a single technical user who wants their own assistant running on infrastructure they control — not a SaaS, not a multi-tenant platform.

## What it is

A long-running Node.js process that orchestrates an agentic loop (raw Anthropic + OpenAI SDKs, no framework), keeps facts about you in a vector memory server, and routes messages through pluggable channel adapters. Telegram is the primary interface. Architecture, data flow, and the roadmap for self-evolution live in [`design/`](design/) — start with [`design/overview.md`](design/overview.md) and [`design/architecture.md`](design/architecture.md).

Closer in spirit to [Letta](https://github.com/letta-ai/letta) and [OpenHands](https://github.com/All-Hands-AI/OpenHands) than to one-click hosted bots: you bring the infra, Cogmo brings the agent.

## Status

MVP conversation + memory is shipping. Stage 1 self-evolution (post-conversation observer that extracts behavioural corrections into steering rules) is live. Scheduling, ingestion (Gmail/Calendar via MCP), and the full evolutionary loop are next. See [`PROGRESS.md`](PROGRESS.md) for the phased plan and [`CHANGELOG.md`](CHANGELOG.md) for what's landed.

## Deploy

Cogmo runs as a single container that talks to your own infrastructure. You provide:

- **PostgreSQL 18+ with pgvector** (one instance, used for both Cogmo's application state and Hindsight's vectors)
- **Redis 7+** (Inngest queue and state)
- **[Inngest](https://www.inngest.com/)** (self-hosted dev server or production deployment)
- **[Hindsight](https://github.com/vectorize-io/hindsight)** memory server

Cogmo provides:

- A distroless Docker image at `ghcr.io/iskhakovt/cogmo` (released on every semantic-release; check [packages](https://github.com/iskhakovt/cogmo/pkgs/container/cogmo) for the latest tag)
- A guided setup wizard (`cogmo setup`) that validates credentials live and writes them encrypted to your DB
- A `serve` entrypoint that connects to Inngest and starts your channel adapters

Full step-by-step instructions — env vars, master-key generation, bootstrap order, secrets handling — are in [`DEPLOYMENT.md`](DEPLOYMENT.md).

## First-run setup

Once the container can reach your DB, Redis, Inngest, and Hindsight, run the wizard:

```bash
docker run --rm -it \
  -e DATABASE_URL=postgresql://... \
  -e COGMO_MASTER_KEY=... \
  -e HINDSIGHT_URL=http://hindsight:8888 \
  ghcr.io/iskhakovt/cogmo setup
```

The wizard (`@clack/prompts` TUI) walks you through:

1. **LLM provider** — pick Anthropic, OpenRouter, OpenAI, or any OpenAI-compatible endpoint. Paste an API key; the wizard pings the live API to validate it before storing.
2. **Telegram bot** (optional but expected) — paste a `@BotFather` token; the wizard calls `getMe` to confirm and shows your bot's username.
3. **Telegram allowlist** — comma-separated user IDs from `@userinfobot`. Anyone not on this list is rejected by the adapter.
4. **Optional tools** — Tavily (web search), fal.ai (image generation).
5. **Hindsight reachability check** and a summary of what was configured.

All credentials land encrypted (AES-256-GCM, HKDF-derived from `COGMO_MASTER_KEY`) in the `secrets` table — never written to disk, never logged. `cogmo setup` is re-runnable: each step shows the current state and offers Keep / Modify / Skip. Use `--reset secrets|channels|all` to wipe and re-prompt. See [`design/setup.md`](design/setup.md) for the full UX contract.

After setup completes, start the long-running process:

```bash
docker run -d \
  -e DATABASE_URL=... \
  -e COGMO_MASTER_KEY=... \
  -e HINDSIGHT_URL=... \
  -e INNGEST_BASE_URL=... \
  -p 9090:9090 \
  ghcr.io/iskhakovt/cogmo
```

Then message your bot on Telegram. Liveness is exposed at `GET /health` on port 9090.

## For contributors

| If you want to... | See |
|-|-|
| Run Cogmo locally for development | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Understand module boundaries and code style | [`CLAUDE.md`](CLAUDE.md) |
| Read the architecture and design docs | [`design/`](design/) |
| Track what's queued / in progress | [`todo.md`](todo.md), [`PROGRESS.md`](PROGRESS.md) |
| Deploy to your own host | [`DEPLOYMENT.md`](DEPLOYMENT.md) |

Local dev uses testcontainers — `pnpm dev` boots Postgres, Redis, Inngest, and Hindsight, applies migrations, and runs the app. No `docker-compose.yml` is shipped for end users.

## License

Private.
