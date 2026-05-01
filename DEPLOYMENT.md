# Deployment

This is the canonical install guide. Cogmo is a single Node.js process distributed as a Docker image; you bring the supporting infrastructure.

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

The image is based on `node:24-slim`, runs as the `node` user (UID 1000), and exposes port 9090 (health). Default entrypoint: `node --import ./dist/otel.js dist/main.js serve`. The `--import` hook initializes OpenTelemetry if configured (see [Observability](#observability)) and is a no-op otherwise.

## Persistent state

Cogmo writes runtime state under `/var/lib/cogmo` inside the container:

| Path | Contents |
|-|-|
| `/var/lib/cogmo/skills` | Bare git repository for the skill library. Authoritative — losing it means losing every registered skill. |
| `/var/lib/cogmo/repos` | Cached clones of external repos (read-only sources for skills). Regenerable. |
| `/var/lib/cogmo/worktrees` | Ephemeral working trees for skill execution. Regenerable. |
| `/var/lib/cogmo/askpass` | Short-lived credential helpers for git over HTTPS. Regenerable. |

The image pre-creates all four with `node:node` ownership. If you don't bind-mount, state lives inside the container's writable layer and is lost when the container is removed — fine for kicking the tires, **never for production**: the skills repo is irreplaceable.

### Bind-mount permissions

When you bind-mount a host directory over `/var/lib/cogmo`, the host directory's ownership shadows the in-image chown. The container process runs as **UID 1000**, so the host directory must be owned by UID 1000 (or be world-writable, which you don't want).

```bash
# Once, before first start, on the host:
sudo install -d -o 1000 -g 1000 /var/lib/cogmo

docker run -d \
  -v /var/lib/cogmo:/var/lib/cogmo \
  ghcr.io/iskhakovt/cogmo:<version>
```

If UID 1000 collides with an existing user on your host, pick any free UID, chown the host directory to it, and pass `--user <uid>:<gid>` to `docker run` — the container will run under that UID instead of 1000.

**Podman convenience.** Podman supports a `:U` mount flag that recursively chowns the bind-mount source to the container UID on each start (`-v /var/lib/cogmo:/var/lib/cogmo:U`). Avoids the pre-chown step at the cost of a recursive `chown` every time the container starts; pick whichever you prefer.

**Kubernetes hostPath.** `securityContext.fsGroup` does not apply to hostPath volumes (only to dynamically provisioned PVs). Either pre-chown the host path, or run an `initContainer` with `runAsUser: 0` and `CAP_CHOWN` to fix permissions before the main container starts.

**NixOS.** Use a `systemd.tmpfiles.rules` entry like `"d /var/lib/cogmo 0750 1000 1000 -"` so the directory exists with the right owner before the unit starts.

## Configuration

All configuration is via environment variables. The schema is in [`src/env.ts`](src/env.ts).

### Required

| Variable | Purpose |
|-|-|
| `DATABASE_URL` | Postgres connection string (e.g. `postgresql://cogmo:pw@host/cogmo`). Also accepts `DATABASE_URL_FILE` for Docker secrets. |
| `COGMO_MASTER_KEY` | 32-byte base64 master key. Encrypts every credential at rest (AES-256-GCM, HKDF-derived per purpose). Generate with `cogmo gen-key`. Also accepts `COGMO_MASTER_KEY_FILE` for Docker secrets. **Losing it means re-entering every credential.** |
| `HINDSIGHT_URL` | Hindsight server URL (e.g. `http://hindsight.internal:8888`). |
| `INNGEST_BASE_URL` | Inngest server URL (e.g. `http://inngest.internal:8288`). |

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
     -e INNGEST_BASE_URL=http://inngest:8288 \
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

## Observability

Cogmo emits OpenTelemetry traces, metrics, and trace-correlated logs when an OTLP endpoint is configured. Telemetry is opt-in: with `OTEL_EXPORTER_OTLP_ENDPOINT` unset the SDK isn't loaded at all, so the default process stays lean.

The image entrypoint always launches with `node --import ./dist/otel.js`, which is a no-op until the env var is set. Once set, the SDK exports OTLP over HTTP/protobuf — supported by every common backend without a separate Collector.

### What you get

| Signal | Where |
|-|-|
| Traces | One trace per Inngest function run. Inngest's engine unconditionally opens an `inngest.execution` root span via the active tracer provider (no middleware required), and our domain spans parent under it via standard OTel context propagation. Children: `chat` spans tagged with `gen_ai.*` semantic conventions (`provider.name`, `request.model`, `usage.input_tokens`/`output_tokens`/`cache_*`, `response.finish_reasons`); `tool.execute` spans (`cogmo.tool.name`); `memory.recall`/`memory.retain` spans (`memory.hit`, `memory.count`). Auto-instrumented HTTP and undici give you outbound calls (Anthropic, OpenAI, Hindsight, fal.ai, Tavily, Telegram). |
| Metrics | `cogmo.llm.tokens` counter (labels `type`/`model`/`provider`, where `type` ∈ `input`/`output`/`cache_read`/`cache_create`); `cogmo.agent.iterations` histogram (per turn, labeled by model); `cogmo.debounce.wait_ms` histogram. |
| Logs | Pino lines automatically gain `trace_id` / `span_id` / `trace_flags` via `instrumentation-pino`, so journald correlation works without code changes. |

### Cross-function-run correlation

Each Inngest function run (`handle-message`, `debounce-idle`, future `observer`, etc.) is its own trace in your backend. Function runs that flow from one to another (orchestrator → debounce → handler) show up as separate traces with their own `trace_id`. If you need to correlate a chain of runs — for one user turn or one debugging session — filter by an attribute you put on your own spans (e.g. `cogmo.conversation_id` if added, or `inngest.runId` from the engine). Inngest's own dashboard does visual auto-stitching via their internal run graph; Tempo / SigNoz / Grafana Cloud give you the filterable data and let you query.

Retries of a single function run currently create a fresh trace per attempt. Inngest's `extendedTracesMiddleware` (from `inngest/experimental`) would enable retries-as-sibling-spans plus deterministic step-ID parenting across HTTP checkpoints, but only activates when the function is started with a W3C `traceparent` on the request. That requires propagating `traceparent` through event payloads — schema churn on every event type, and Inngest issue #1436 (third-party context drops at `step.run()` boundaries) has to be worked around. Deferred; revisit if retry analysis becomes a recurring pain point.

### Configuration

Standard OTel env vars apply — Cogmo doesn't wrap them.

| Variable | Required | Notes |
|-|-|-|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | yes (to enable) | Base URL of the OTLP/HTTP receiver, e.g. `http://lgtm:4318` or `https://otlp-gateway-prod-eu-west-2.grafana.net/otlp`. |
| `OTEL_SERVICE_NAME` | recommended | Defaults to `cogmo`. Set to disambiguate multiple instances. |
| `OTEL_RESOURCE_ATTRIBUTES` | optional | Comma-separated `key=value` pairs, e.g. `deployment.environment=prod,host.name=cogmo-1`. |
| `OTEL_EXPORTER_OTLP_HEADERS` | as needed | For backends that require auth (Grafana Cloud, etc.). |
| `OTEL_SDK_DISABLED` | optional | Set to `true` to force-off even when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Useful for one-off debugging. |

### Local: Grafana LGTM all-in-one

The simplest self-hosted setup. One container exposes Tempo (traces), Mimir/Prometheus (metrics), Loki (logs), and Grafana UI on port 3000. No Collector required.

```bash
docker run -d --name lgtm \
  -p 3000:3000 -p 4318:4318 \
  grafana/otel-lgtm

docker run -d --name cogmo \
  --restart=unless-stopped \
  -e DATABASE_URL=postgresql://... \
  -e COGMO_MASTER_KEY=... \
  -e HINDSIGHT_URL=http://hindsight:8888 \
  -e INNGEST_BASE_URL=http://inngest:8288 \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=http://lgtm:4318 \
  -e OTEL_SERVICE_NAME=cogmo \
  -p 9090:9090 \
  ghcr.io/iskhakovt/cogmo:<version>
```

Open `http://localhost:3000` and add Tempo / Prometheus / Loki as data sources (preconfigured in `grafana/otel-lgtm`).

### Local: SigNoz

[SigNoz](https://signoz.io/docs/install/docker/) accepts OTLP directly on 4318. Same `OTEL_EXPORTER_OTLP_ENDPOINT=http://<signoz-host>:4318` pattern.

### Managed: Grafana Cloud

Grafana Cloud's OTLP gateway accepts HTTP/protobuf only. Get the endpoint, instance ID, and token from the console (Connections → Add new connection → OpenTelemetry).

```bash
docker run -d --name cogmo \
  --restart=unless-stopped \
  -e DATABASE_URL=postgresql://... \
  -e COGMO_MASTER_KEY=... \
  -e HINDSIGHT_URL=http://hindsight:8888 \
  -e INNGEST_BASE_URL=http://inngest:8288 \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-eu-west-2.grafana.net/otlp \
  -e OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic $(printf '%s' '<instance-id>:<token>' | base64)" \
  -e OTEL_SERVICE_NAME=cogmo \
  -e OTEL_RESOURCE_ATTRIBUTES=deployment.environment=prod \
  -p 9090:9090 \
  ghcr.io/iskhakovt/cogmo:<version>
```

The credentials live in env vars here for brevity — in production put them in your secret manager and inject via `--env-file` or systemd `LoadCredential`, the same as `COGMO_MASTER_KEY`.

### Sampling

The default sampler is `parentbased_always_on` — every trace is exported. Fine at personal scale. If costs grow:

```
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

samples 10% of root traces while keeping child spans consistent.

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
