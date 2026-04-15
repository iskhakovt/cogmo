# Deployment

This is the canonical install guide. Cogmo is a single Node.js process distributed as a distroless Docker image; you bring the supporting infrastructure.

## Prerequisites

| Component | Version | Notes |
|-|-|-|
| PostgreSQL | **18 recommended** (14+ accepted via SQL polyfill, but dev-only) | One instance shared by Cogmo and Hindsight. CI tests against PG 18 (`pgvector/pgvector:pg18`). PG 18 ships native, monotonic `uuidv7()`; older versions get a `plpgsql` fallback from `scripts/init-db.sql` that is non-monotonic and lower quality — fine for local experiments, avoid in production. |
| pgvector | latest | Postgres extension for vector storage. The `pgvector/pgvector:pg18` image bundles it. |
| Redis | 7+ | Inngest queue and state store. |
| Inngest | latest | Self-hosted dev server (`inngest dev`) or production deployment. |
| [Hindsight](https://github.com/vectorize-io/hindsight) | latest-slim recommended | Memory server, HTTP API on port 8888. See [Hindsight image variant](#hindsight-image-variant) for which tag to pick. |
| Docker | latest | For pulling and running the image. |

Cogmo stores its application state in your Postgres; Hindsight stores its vectors in the same Postgres (different schema). One database is enough for personal scale.

### Hindsight image variant

Hindsight publishes two image families: **slim** (`:latest-slim`, ~500 MB, no local ML) and **full** (`:latest`, ~9 GB, bundles PyTorch + embedding/reranker models). Cogmo recommends **slim** for most deployments:

- You already configured an LLM provider for Cogmo's main loop. Reusing that same OpenAI-/OpenRouter-/Cohere-compatible key for Hindsight's embeddings and reranker costs a few cents per month at personal scale.
- The image is ~18× smaller, cold-start is seconds instead of a minute, and idle RAM stays under 500 MB.
- Configure embeddings + reranker provider URLs/keys via Hindsight's own env vars — see [Hindsight's installation docs](https://hindsight.vectorize.io/developer/installation).

Pick **full** only if you need fully offline operation (air-gapped deploy, no external API calls for memory) and can spare ~4 GB of always-on RAM.

## The image

Each release publishes to GitHub Container Registry:

```text
ghcr.io/iskhakovt/cogmo:<version>
```

See [packages](https://github.com/iskhakovt/cogmo/pkgs/container/cogmo) for available tags. Versions are SemVer driven by [semantic-release](https://semantic-release.gitbook.io/) on every push to `main`. Pin a tag in production — don't track `latest`.

To build locally instead:

```bash
docker build -t cogmo .                              # version = "dev" (Dockerfile default)
docker build --build-arg VERSION=0.0.0-dev -t cogmo . # override the embedded version string
```

The image is `gcr.io/distroless/nodejs24-debian13`, runs as `nonroot`, and exposes port 9090 (health). Default entrypoint: `node dist/main.js serve`.

## Configuration

All configuration is via environment variables. The schema is in [`src/env.ts`](src/env.ts).

### Required

| Variable | Purpose |
|-|-|
| `DATABASE_URL` | Postgres connection string (e.g. `postgresql://cogmo:pw@host/cogmo`). Also accepts `DATABASE_URL_FILE` for Docker secrets. |
| `COGMO_MASTER_KEY` | 32-byte base64 master key. Encrypts every credential at rest (AES-256-GCM, HKDF-derived per purpose). Generate with `cogmo gen-key`. Also accepts `COGMO_MASTER_KEY_FILE` for Docker secrets. **Losing it means re-entering every credential.** |
| `HINDSIGHT_URL` | Hindsight server URL. Must point to your deployed Hindsight instance (e.g. `http://hindsight.internal:8888`). The schema falls back to `http://localhost:8888` for local dev — do not rely on that in deployment. |
| `INNGEST_BASE_URL` | Inngest server URL. Must point to your deployed Inngest instance. The schema falls back to `http://localhost:8288` for local dev — do not rely on that in deployment. |

### Optional

| Variable | Default | Purpose |
|-|-|-|
| `INNGEST_MODE` | `connect` | `connect` (long-poll, recommended) or `serve` (HTTP). |
| `INNGEST_EVENT_KEY` | — | Required if your Inngest deployment is keyed. |
| `INNGEST_SIGNING_KEY` | — | Required if your Inngest deployment is keyed. |
| `LOG_LEVEL` | `info` | `fatal` / `error` / `warn` / `info` / `debug` / `trace`. |
| `USER_TIMEZONE` | `UTC` | Used for `get_current_time` and scheduling. |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` | — / `cogmo-files` / — / — / `us-east-1` | Object storage for the file tools and image attachments. MinIO works. |

LLM provider keys, Telegram bot tokens, Tavily/fal.ai keys, and similar credentials are **not** env vars — they live encrypted in the DB after `cogmo setup`. Putting secrets in env files is explicitly discouraged; use host secret management ([sops-nix](https://github.com/Mic92/sops-nix), [Vault](https://www.vaultproject.io/), systemd `LoadCredential`, Docker secrets via `_FILE`, etc.) for `COGMO_MASTER_KEY` and `DATABASE_URL`.

## Bootstrap sequence

1. **Generate a master key** (once, on a trusted machine):

   ```bash
   docker run --rm ghcr.io/iskhakovt/cogmo:<version> gen-key
   # → COGMO_MASTER_KEY=...
   ```

   Store it in your secret manager. Set `COGMO_MASTER_KEY` (or `COGMO_MASTER_KEY_FILE`) for every subsequent invocation.

2. **Run the guided setup wizard** — applies migrations, seeds the default user/profile, and prompts for credentials:

   ```bash
   docker run --rm -it \
     -e DATABASE_URL=postgresql://... \
     -e COGMO_MASTER_KEY=... \
     -e HINDSIGHT_URL=http://hindsight:8888 \
     ghcr.io/iskhakovt/cogmo:<version> setup
   ```

   The wizard validates each credential live (Anthropic/OpenAI `/v1/models`, Telegram `getMe`, Tavily ping, Hindsight `/health`) and writes only on success. It is re-runnable — running it again on an existing deployment lets you add a channel, rotate a key, or swap providers. Use `--reset secrets|channels|all` to wipe scoped state and re-prompt. See [`design/setup.md`](design/setup.md) for the full UX contract.

3. **Start the long-running process:**

   ```bash
   docker run -d \
     --restart=unless-stopped \
     -e DATABASE_URL=postgresql://... \
     -e COGMO_MASTER_KEY=... \
     -e HINDSIGHT_URL=http://hindsight:8888 \
     -e INNGEST_BASE_URL=http://inngest:8288 \
     -p 9090:9090 \
     ghcr.io/iskhakovt/cogmo:<version>
   ```

   The default `CMD` is `serve`. The process connects to Inngest, starts each configured channel adapter (e.g. Telegram long-polling), and listens on `0.0.0.0:9090` for liveness checks.

## Subcommands

The image entrypoint dispatches based on the first arg:

| Command | Purpose |
|-|-|
| `serve` *(default)* | Run the long-lived agent process. |
| `setup` | Interactive guided setup wizard. Idempotent. Required on first run; re-run any time to change credentials or add a channel. |
| `setup --reset secrets\|channels\|all` | Wipe scoped state before prompting. |
| `setup --non-interactive` | Currently only seeds defaults — full provider configuration via env vars is tracked as a future enhancement. Use `setup` interactively for now. |
| `seed` | Legacy idempotent seed (default user + profile + direct channel). `setup` does this and more; prefer it. |
| `gen-key` | Print a fresh `COGMO_MASTER_KEY` to stdout. |

## Health check

`GET /health` on port 9090 returns 200 with an `application/health+json` body (IETF draft schema: `status`, `version`, `releaseId`, `description`, `notes`). Liveness only — a Postgres blip will not flap the container. Wire it to your supervisor (Docker `HEALTHCHECK`, k8s `livenessProbe`, systemd, etc.).

## Updating

Pull the new tag and restart. `setup` runs Drizzle migrations on every invocation, so for schema changes:

```bash
docker pull ghcr.io/iskhakovt/cogmo:<new-version>
docker run --rm \
  -e DATABASE_URL=... -e COGMO_MASTER_KEY=... \
  ghcr.io/iskhakovt/cogmo:<new-version> setup
docker stop cogmo && docker rm cogmo
# re-run the `serve` command from "Bootstrap sequence" step 3 with the new tag
```

Migrations are forward-only. Always back up the database before upgrading.
