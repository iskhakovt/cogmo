# Deployment

## Prerequisites

- Docker
- PostgreSQL 14+ with pgvector
- [Hindsight](https://github.com/vectorize-io/hindsight) memory server
- [Inngest](https://www.inngest.com/) (self-hosted or cloud)
- Redis 7+ (production only, required by Inngest)

## Configuration

All configuration via environment variables. Full schema in `src/env.ts`.

| Variable | Required | Default |
|-|-|-|
| `ANTHROPIC_API_KEY` | Yes | — |
| `DATABASE_URL` | No | `postgresql://assistant@localhost/assistant` |
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
docker build -t assistant .
docker build --build-arg VERSION=1.2.0 -t assistant .
```

Images are published to `ghcr.io/<owner>/assistant:<version>` on every release.

## First Run

Seed the database (creates default user and profile):

```bash
docker run --rm \
  -e DATABASE_URL=postgresql://... \
  assistant seed
```

## Running

```bash
docker run -d \
  -e DATABASE_URL=postgresql://... \
  -e ANTHROPIC_API_KEY=sk-... \
  -e HINDSIGHT_URL=http://hindsight:8888 \
  -e INNGEST_BASE_URL=http://inngest:8288 \
  assistant
```

The app runs as `nonroot` inside a distroless container. Entrypoint is `node dist/cli.js serve`.

## CI/CD

Two GitHub Actions workflows handle testing and publishing.

### CI (`.github/workflows/ci.yml`)

Runs on push to `main` and pull requests:

1. **PR Title** — enforces Conventional Commits format
2. **Typecheck & Lint** — `pnpm typecheck && pnpm lint`
3. **Unit Tests** — PGlite (in-process), mocked deps
4. **Integration Tests** — testcontainers (PG, Redis, Inngest, Hindsight) + llmock
5. **E2E Tests** — builds Docker image, tests against it
6. **Release** — `semantic-release` creates GitHub release + `vX.Y.Z` tag (main only, after all jobs pass)

### Publish (`.github/workflows/publish.yml`)

Triggered by `v*` tag (created by semantic-release):

1. Derives version from git tag (Dunamai)
2. Builds image with `VERSION` build arg (cache hit from CI)
3. Pushes to `ghcr.io/<owner>/assistant:<version>`

### Conventional Commits

All commit messages and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | Version bump |
|-|-|
| `fix:` | Patch |
| `feat:` | Minor |
| `feat!:` / `BREAKING CHANGE:` | Major |
| `chore:`, `ci:`, `docs:`, `refactor:`, `test:` | No release |
