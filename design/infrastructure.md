# Infrastructure

## Runtime Requirements `[confirmed]`

| Dependency | Version | Purpose |
|-|-|-|
| PostgreSQL | 17+ | Application state (Drizzle) + Hindsight server storage (pgvector) |
| Hindsight | latest | Self-hosted memory server (`ghcr.io/vectorize-io/hindsight`), HTTP API on port 8888 |
| Redis | 7+ | Inngest queue + state store (production); not needed in dev mode |
| Inngest | latest | Event-driven orchestration — `inngest dev` locally, `inngest start` in production |
| Node.js | 24+ (LTS Krypton) | Runtime |

## Local Development `[confirmed]`

Testcontainers via `scripts/dev-infra.ts` — starts PostgreSQL (with pgvector), Redis, Inngest, and Hindsight as reusable containers, applies migrations, then spawns the app with injected env vars. No Docker Compose files needed.

```bash
pnpm dev:infra          # start infra + app
pnpm dev:infra --only   # start infra only (prints env vars)
```

Containers survive across restarts (`withReuse()`). `Ctrl+C` stops the app; containers keep running. Use `docker stop` to kill them.

## Configuration `[confirmed]`

All configuration via environment variables. See `src/env.ts` for the schema.

| Variable | Default | Purpose |
|-|-|-|
| `DATABASE_URL` | `postgresql://assistant@localhost/assistant` | PostgreSQL connection |
| `REDIS_HOST` | `127.0.0.1` | Redis host |
| `REDIS_PORT` | `6380` | Redis port |
| `NODE_ENV` | `development` | Environment |
| `LOG_LEVEL` | `info` | Pino log level |

## Secrets `[confirmed]`

API keys must never be in env files or git. In production, use the host's secret management (sops-nix, Vault, etc.) and inject via environment or `LoadCredential`.

| Secret | Purpose |
|-|-|
| `ANTHROPIC_API_KEY` | Claude API |
| Per-integration keys | Gmail, Calendar, Strava, etc. (added as integrations ship) |

## Deployment `[proposed]`

Build TypeScript -> `dist/`. Deploy however suits the host — systemd service, Docker, etc. The app is a standard Node.js process with no special requirements beyond PostgreSQL and Redis.

Future: containerised deployment with Docker.

## Monitoring `[proposed]`

Expose Prometheus metrics on a localhost port:
- LLM call count, latency, token usage, errors
- Memory operations (retain/recall/reflect count, latency)
- Inngest function runs (completed, failed, retried)
- Conversation count, messages per conversation

Monitor RAM usage — avoid bloat, but don't prematurely optimise. Address when actual pressure appears.

## Web UI (Optional) `[proposed]`

Inngest dashboard (built-in at port 8288) for event/function monitoring. Add custom status page when needed.

## Scaling Triggers `[proposed]`

| Signal | Action |
|-|-|
| RAM pressure or swap | Move to larger host or optimise |
| API costs unsustainable | Evaluate local inference for background tasks |
| pgvector index > 1GB | Evaluate dedicated vector store |
