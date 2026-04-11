# Deployment

## Prerequisites

- Docker
- PostgreSQL 18+ recommended (14+ supported via the `uuidv7()` polyfill in `scripts/init-db.sql`, but PG 18 ships native, monotonic UUIDv7 — prefer it in production)
- pgvector extension on the same Postgres instance
- [Hindsight](https://github.com/vectorize-io/hindsight) memory server
- [Inngest](https://www.inngest.com/) (self-hosted or cloud)
- Redis 7+ (required by Inngest in production)

## Configuration

All configuration via environment variables. Full schema in `src/env.ts`.

| Variable | Required | Default |
|-|-|-|
| `ANTHROPIC_API_KEY` | Yes | — |
| `DATABASE_URL` | No | `postgresql://cogmo@localhost/cogmo` |
| `HINDSIGHT_URL` | No | `http://localhost:8888` |
| `INNGEST_BASE_URL` | No | `http://localhost:8288` |
| `INNGEST_MODE` | No | `connect` |
| `INNGEST_EVENT_KEY` | No | — |
| `INNGEST_SIGNING_KEY` | No | — |
| `TELEGRAM_BOT_TOKEN` | No | — |
| `LOG_LEVEL` | No | `info` |

Secrets must never be in env files or git. Use host secret management (sops-nix, Vault, `LoadCredential`, etc.).

## Building

```bash
docker build -t cogmo .
docker build --build-arg VERSION=1.2.0 -t cogmo .
```

Images are published to `ghcr.io/<owner>/cogmo:<version>` on every release.

## First Run

Seed the database (creates default user and profile):

```bash
docker run --rm \
  -e DATABASE_URL=postgresql://... \
  cogmo seed
```

## Running

```bash
docker run -d \
  -e DATABASE_URL=postgresql://... \
  -e ANTHROPIC_API_KEY=sk-... \
  -e HINDSIGHT_URL=http://hindsight:8888 \
  -e INNGEST_BASE_URL=http://inngest:8288 \
  cogmo
```

The app runs as `nonroot` inside a distroless container. Entrypoint is `node dist/main.js serve`.
