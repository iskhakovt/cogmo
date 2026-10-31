# Cogmo

[![Release](https://img.shields.io/github/v/release/iskhakovt/cogmo?label=release&color=blue)](https://github.com/iskhakovt/cogmo/releases)
[![ghcr](https://img.shields.io/github/v/release/iskhakovt/cogmo?label=ghcr&logo=docker&color=2496ED)](https://github.com/iskhakovt/cogmo/pkgs/container/cogmo)
[![CI](https://github.com/iskhakovt/cogmo/actions/workflows/ci.yml/badge.svg)](https://github.com/iskhakovt/cogmo/actions/workflows/ci.yml)

<!--
  Drop the cuttlefish mascot here when ready.
  Suggested: `docs/assets/cogmo.svg` (vector for logos) or `.png` (digital identity),
  rendered with: <p align="center"><img src="docs/assets/cogmo.svg" width="200" alt="Cogmo"></p>
-->

Self-hosted personal agent runtime with persistent memory, Telegram and a web UI, and an evolving prompt that learns from every conversation. Built for a single technical user who wants their own assistant running on infrastructure they control — not a SaaS, not a multi-tenant platform.

## What it is

A long-running Node.js process that runs a durable agentic loop on Inngest (raw Anthropic + OpenAI SDKs, no framework), keeps facts about you in a Hindsight memory server, and routes messages through pluggable channel adapters — Telegram and a browser cockpit served from the same process. Architecture, data flow, and the roadmap for self-evolution live in [`design/`](design/) — start with [`design/overview.md`](design/overview.md) and [`design/architecture.md`](design/architecture.md).

## Status

Shipped:

- **Conversation + memory** — multi-provider LLM routing (Anthropic, OpenRouter, OpenAI, any OpenAI-compatible endpoint), auto-recall, core memory blocks, context compaction, streaming replies.
- **Stage 1 self-evolution** — a post-conversation Observer extracts behavioural corrections into steering rules.
- **Tools** — web search and fetch, files on S3-compatible storage, image generation, voice (TTS/STT), sub-agents, MCP servers.
- **Scheduling** — recurring and one-off tasks the agent sets itself, managed with `/schedules`.
- **Skill library** — Python skills in a git-backed repo, run in Pyodide or a sysbox container, with risk-tiered deploy approval.
- **Coding delegation** — Claude Code in a sandbox, plan approval over Telegram, verified changes pushed as a draft PR.
- **Web UI** — streaming chat and admin screens.
- **User-defined pipelines** — staged runs compiled from a free-text description, with human gates; loops and parked waits are next.

Next: ingestion (Gmail and Calendar over MCP), prompt optimization, and the full evolutionary loop. See [`progress.md`](progress.md) for the phased plan and [`changelog.d/`](changelog.d/) for what's landed.

## Deploy

Cogmo runs as a single container that talks to your own infrastructure. You provide:

- **PostgreSQL 18 with pgvector**, shared by Cogmo and Hindsight
- **Redis 7+** (Inngest queue and state)
- **[Inngest](https://www.inngest.com/)**, self-hosted
- **[Hindsight](https://github.com/vectorize-io/hindsight)** memory server, in the version range Cogmo checks at boot
- **An S3-compatible bucket** for files and attachments; `serve` checks it at boot

Cogmo provides:

- A Docker image at `ghcr.io/iskhakovt/cogmo` (check [packages](https://github.com/iskhakovt/cogmo/pkgs/container/cogmo) for the latest tag; pin one)
- A guided setup wizard (`cogmo setup`) that validates credentials live and writes them encrypted to your DB
- A `serve` entrypoint that connects to Inngest, starts your channel adapters, and serves the web UI and health check on port 9090

Full step-by-step instructions — env vars, Hindsight configuration, persistent state, securing internal services, observability — are in [`deploy.md`](deploy.md).

## First-run setup

Generate a master key once and keep it in your secret manager — it encrypts every stored credential:

```bash
docker run --rm ghcr.io/iskhakovt/cogmo:<version> gen-key
```

Once the container can reach your DB, Redis, Inngest, and Hindsight, run the wizard:

```bash
docker run --rm -it \
  -v /var/lib/cogmo:/var/lib/cogmo \
  -e DATABASE_URL=postgresql://... \
  -e COGMO_MASTER_KEY=... \
  -e HINDSIGHT_URL=http://hindsight:8888 \
  -e HINDSIGHT_API_KEY=... \
  -e INNGEST_BASE_URL=http://inngest:8288 \
  -e INNGEST_EVENT_KEY=... \
  -e INNGEST_SIGNING_KEY=... \
  ghcr.io/iskhakovt/cogmo:<version> setup
```

It applies migrations, seeds the default user and profile, then walks you through:

1. **LLM provider** (required) — Anthropic, OpenRouter, OpenAI, or any OpenAI-compatible endpoint, plus the models to route to it, picked from the provider's live list.
2. **Telegram** — a `@BotFather` token (checked with `getMe`) and an allowlist of user IDs.
3. **Optional tools and outputs** — Tavily web search, fal.ai and other image providers, voice.
4. **Coding delegation** — GitHub identity, Claude Code auth, Daytona sandbox, skills repo remote.
5. **Hindsight check** and a summary of what was configured.

Credentials are checked against the live service where one offers a cheap check (an LLM, Claude Code, Daytona or voice credential that fails can still be saved after a warning) and stored encrypted (AES-256-GCM, HKDF-derived from `COGMO_MASTER_KEY`) in the `secrets` table. `cogmo setup` is re-runnable: each step offers Keep / Modify / Skip, and `--reset secrets|channels|all` wipes scoped state first. `--non-interactive` reads the provider, Telegram and optional credentials from `COGMO_*` env vars instead. See [`design/setup.md`](design/setup.md) for the full UX contract.

Then start the long-running process with the same env vars plus the bucket, a persistent state directory, and room for a graceful shutdown. Create `/var/lib/cogmo` on the host owned by UID 1000 first ([`deploy.md` → Bind-mount permissions](deploy.md#bind-mount-permissions)):

```bash
docker run -d \
  --restart=unless-stopped \
  --stop-timeout 60 \
  -v /var/lib/cogmo:/var/lib/cogmo \
  -e DATABASE_URL=... \
  -e COGMO_MASTER_KEY=... \
  -e HINDSIGHT_URL=... \
  -e HINDSIGHT_API_KEY=... \
  -e INNGEST_BASE_URL=... \
  -e INNGEST_EVENT_KEY=... \
  -e INNGEST_SIGNING_KEY=... \
  -e S3_ENDPOINT=... -e S3_BUCKET=... -e S3_ACCESS_KEY=... -e S3_SECRET_KEY=... \
  -p 127.0.0.1:9090:9090 \
  ghcr.io/iskhakovt/cogmo:<version>
```

Message your bot on Telegram, or open the web UI through an HTTPS proxy in front of port 9090 and log in with the token `cogmo web-token` prints. Liveness is `GET /health` on the same port. Providers, models, sub-agents, image models and skills are managed afterwards with `cogmo provider`, `cogmo model`, `cogmo subagent`, `cogmo image-provider`, `cogmo image-model` and `cogmo skills` — see [`deploy.md` → Subcommands](deploy.md#subcommands).

## For contributors

| If you want to... | See |
|-|-|
| Run Cogmo locally for development | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Understand module boundaries and code style | [`AGENTS.md`](AGENTS.md) |
| Read the architecture and design docs | [`design/`](design/) |
| Track what's queued / in progress | [`todo.md`](todo.md), [`progress.md`](progress.md) |
| Deploy to your own host | [`deploy.md`](deploy.md) |

The repo is a pnpm workspace: the backend in `apps/server/`, the web UI SPA in `apps/web/`, and shared contracts in `packages/contracts/`. Local dev uses testcontainers — `pnpm dev` boots Postgres, Redis, Inngest, RustFS, and Hindsight, applies migrations, runs the backend, and starts the web UI (Vite dev server on http://localhost:5173, proxying to the backend on :9090). It prints a login token to paste into the web UI. No `docker-compose.yml` is shipped for end users.
