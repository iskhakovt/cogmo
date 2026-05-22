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

**Kubernetes hostPath.** `securityContext.fsGroup` does not apply to hostPath volumes — the kubelet doesn't take ownership of arbitrary host directories (it works for many other volume types, including most CSI-backed PVs and `emptyDir`). Either pre-chown the host path, or run an `initContainer` with `runAsUser: 0` and `CAP_CHOWN` to fix permissions before the main container starts.

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

Defaults below match the in-image expectations: persistent-state paths align with `/var/lib/cogmo`, socket and askpass paths sit under `/run/cogmo`. Override only when bind-mounts or runtime configuration demand it.

#### Inngest

| Variable | Default | Purpose |
|-|-|-|
| `INNGEST_MODE` | `connect` | `connect` (long-poll, recommended) or `serve` (HTTP). |
| `INNGEST_SERVE_PORT` | `3000` | HTTP port the SDK listens on when `INNGEST_MODE=serve`. Ignored in `connect` mode. |
| `INNGEST_EVENT_KEY` | — | Required if your Inngest deployment is keyed. |
| `INNGEST_SIGNING_KEY` | — | Required if your Inngest deployment is keyed. |

#### Logging & locale

| Variable | Default | Purpose |
|-|-|-|
| `LOG_LEVEL` | `info` | `fatal` / `error` / `warn` / `info` / `debug` / `trace`. |
| `USER_TIMEZONE` | `UTC` | Used for `get_current_time` and scheduling. |

#### Memory (Hindsight)

| Variable | Default | Purpose |
|-|-|-|
| `HINDSIGHT_RECALL_MAX_QUERY_TOKENS` | `500` | Truncation budget for recall queries, in tokens. Must match Hindsight's `HINDSIGHT_API_RECALL_MAX_QUERY_TOKENS`. Bump on both sides if long multi-turn context needs to flow into the recall query — but past ~1500 tokens semantic-search quality degrades regardless of the cap. |

#### Object storage

| Variable | Default | Purpose |
|-|-|-|
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` | — / `cogmo-files` / — / — / `us-east-1` | Object storage for the file tools and image attachments. MinIO works. |
| `S3_CLIENT_ENCRYPT` | — | `true` / `1` enables client-side AES-256-GCM for **both** attachments and workspace files. Bucket sees only opaque ciphertext bodies (attachments uploaded as `.bin` with `Content-Type: application/octet-stream`; workspace files written with `Content-Type: application/octet-stream`). Reads transparently fall back to plaintext when the magic prefix is absent, so the flag is safe to flip on a populated bucket. **Object keys remain plaintext** — matches the AWS S3 Encryption Client convention; if file names need to stay secret, choose non-revealing names. **Caveats**: rotating `COGMO_MASTER_KEY` requires re-encrypting every existing object; bucket loses direct-browser-serve; flipping the flag *off* with encrypted blobs in the bucket leaves them unreadable. Off by default. |

#### Session & debounce

| Variable | Default | Purpose |
|-|-|-|
| `SESSION_IDLE_TIMEOUT_MINUTES` | `60` | Channel-session idle timeout. The next inbound message after this gap starts a fresh conversation. |
| `DEBOUNCE_IDLE_SECONDS` | `3` | Quiet window after the last inbound message before the orchestrator fires. Tunes responsiveness vs. batching. |
| `DEBOUNCE_MAXWAIT_SECONDS` | `30` | Hard cap on debounce wait — even in a streaming burst the orchestrator fires by this deadline. |
| `DEBOUNCE_RESUME_POLICY` | `debounce` | `debounce` / `flush` / `await_input` — behaviour when new messages arrive mid-turn. See [`design/transport/`](design/transport/). |

#### Sandbox backend

| Variable | Default | Purpose |
|-|-|-|
| `SANDBOX_BACKEND` | `local-docker` | `local-docker` or `daytona`. `local-docker` needs `SANDBOX_RUNTIME` set; `daytona` needs `daytona_api_key` in the encrypted `secrets` table (seeded via `cogmo setup`). |
| `SANDBOX_RUNTIME` | — | OCI runtime for sandbox containers. `sysbox` in production, `runc` in dev / CI. When unset the sandbox module doesn't initialize and coding-delegation features fail with a clear error on first use. Only consulted when `SANDBOX_BACKEND=local-docker`. |
| `DAYTONA_API_URL` | `https://app.daytona.io/api` | Daytona Cloud or self-hosted base URL. Only consulted when `SANDBOX_BACKEND=daytona`. |
| `DAYTONA_ORGANIZATION_ID` | — | Daytona organization id. Only needed when the API key is scoped to multiple orgs and the default isn't the right one. |
| `SANDBOX_PROXY_SOCKET_DIR` | `/run/cogmo/sockets` | Host directory for per-task Docker proxy sockets. Each task container gets `<dir>/<taskId>.sock` bind-mounted at `/var/run/docker.sock` so child-container creation flows through the proxy (label injection, runtime override, deny rules). Created at boot if missing. |
| `SANDBOX_HOST_DOCKER_SOCKET` | `/var/run/docker.sock` | Host Docker socket the proxy forwards to. Override only for rootless Docker / snap / unusual installs. |
| `SANDBOX_ASKPASS_DIR` | `/run/cogmo/askpass` | Host root for per-task git-askpass material (PAT, SSH signing key, helper script). Bind-mounted at `/.cogmo-askpass/` per task; wiped on task stop. |

#### Coding delegation

See [`design/coding-delegation.md`](design/coding-delegation.md) for the full lifecycle.

| Variable | Default | Purpose |
|-|-|-|
| `COGMO_REPOS_DIR` | `/var/lib/cogmo/repos` | Host root for git clones registered via `/repo add`. Bind-mount this for persistence. |
| `COGMO_WORKTREES_DIR` | `/var/lib/cogmo/worktrees` | Host root for per-task git worktrees. Regenerable. |
| `COGMO_DEVBASE_IMAGE` | `ghcr.io/iskhakovt/cogmo-devbase:<VERSION>` | Base image for task containers when a repo has no `.devcontainer/`. Defaults to the matched-version image inside the cogmo container, or `:latest` outside. Override at deploy time to pin or roll back. |
| `CODING_TASK_IDLE_TTL_MINUTES` | `20` | Idle TTL after which a task container is reaped. |
| `CODING_TASK_GRACE_SECONDS` | `120` | Grace period after a task reaches a terminal status before container teardown. |

#### Skills runtime

See [`design/skills.md`](design/skills.md) for two-tier (Pyodide + sysbox) execution and warm-pool sizing.

| Variable | Default | Purpose |
|-|-|-|
| `COGMO_SKILLS_PATH` | `/var/lib/cogmo/skills` | Host path of the bare git repo backing the skill library. **Authoritative — losing it means losing every registered skill.** Bind-mount this for persistence. |
| `COGMO_SKILLS_IMAGE` | `ghcr.io/iskhakovt/cogmo-skills:<VERSION>` | Base image for tier-2 (sysbox) skill workers. Same matched-version semantics as `COGMO_DEVBASE_IMAGE`. |
| `COGMO_SKILLS_POOL_MIN` | `0` | Always-warm tier-2 worker count. With the default `0` the pool is lazy-constructed on first tier-2 invocation and drops back to zero idle workers after `COGMO_SKILLS_POOL_IDLE_SHUTDOWN_MS`. First invoke per idle period pays a cold start (~1-2 s on Local-Docker, ~30 s warm-snapshot or 60-120 s first-build on Daytona). Set `1` for steady-state ~300 ms interactive latency at the cost of one always-running worker. |
| `COGMO_SKILLS_POOL_IDLE_SHUTDOWN_MS` | `1800000` (30 min) | Idle threshold before warm tier-2 workers above `COGMO_SKILLS_POOL_MIN` are torn down. Daytona deployments should set lower (e.g. `300000` = 5 min) to release the billable sandbox sooner. Sweep cadence is fixed at 60 s. |
| `COGMO_SKILLS_DEPS_VOLUME` | **required** | Docker named volume (LocalDocker) / Daytona Volume (Daytona) holding the shared per-lockfile-hash skill virtualenv cache. Mounted at `/skill-venvs` on every tier-2 worker. **No default**: a shared default would cross-mount every Cogmo instance on the same host or Daytona org into one cache, making a compromised skill in one deployment a poisoning vector for the others. Pick a name scoped to your deployment, e.g. `cogmo-skills-deps-cache` for a single-tenant install or `cogmo-skills-deps-cache-staging` / `...-prod` when running multiple Cogmos on shared infra. See `design/skills.md` -> Security posture. |

#### MCP

| Variable | Default | Purpose |
|-|-|-|
| `MCP_TOOL_BUDGET` | `25` | Maximum MCP tools surfaced to the LLM per turn after profile-glob filtering. Cap exists because LLM tool-selection accuracy degrades past ~30 tools and each tool definition costs ~250-400 prompt tokens. Native and skill tools don't count against this budget. |
| `MCP_CALL_TIMEOUT_MS` | `30000` | Per-call timeout for MCP tool dispatch. |
| `MCP_IDLE_EVICTION_MS` | `600000` (10 min) | Idle threshold after which a live MCP connection is closed. |
| `MCP_EVICTION_INTERVAL_MS` | `60000` | How often the idle-eviction sweep runs. Set `0` to disable. |

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
