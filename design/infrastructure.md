# Infrastructure

## Nucleus (Host)

| Attribute | Value |
|-|-|
| Hardware | ASUS NUC14MNK150 — Intel N150, 8GB DDR5 (soldered), 256GB SSD |
| OS | NixOS 25.11, flakes, sops-nix |
| IP | 10.0.10.10 (Management VLAN), 100.124.178.90 (Tailscale) |
| SSH | Key-only, no root, via Tailscale |
| Config repo | `~/homelab` — `device-configs/nucleus/` for NixOS, `tf/` for infra |

## Existing Services (Relevant)

| Service | Port | Notes |
|-|-|-|
| PostgreSQL 18 | 5432 | + PostGIS, peer auth for local users, password auth for Podman bridge |
| Redis | 6380 | All interfaces, no auth (firewall-protected) |
| Cloudflare Tunnel | — | `*.timur.fyi` routes to localhost ports, Access OTP auth |
| Tailscale | — | HTTPS serve for web UIs (Grafana :443, etc.) |

## PostgreSQL Setup

Already running. Needs:
- pgvector extension added (for Hindsight)
- New database for the assistant
- Peer auth for local Node.js process (same as Grafana pattern)

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE DATABASE assistant;
CREATE USER assistant;
GRANT ALL ON DATABASE assistant TO assistant;
```

NixOS config (in a new `assistant.nix` module):
```nix
services.postgresql.ensureDatabases = [ "assistant" ];
services.postgresql.ensureUsers = [{ name = "assistant"; ensureDBOwnership = true; }];
services.postgresql.extensions = [ pkgs.postgresqlPackages.pgvector ];
```

## Redis

Already running on port 6380. BullMQ connects directly:
```typescript
const connection = { host: '127.0.0.1', port: 6380 };
```

## NixOS Service

Deploy as a systemd service with sops secrets:

```nix
{ config, pkgs, ... }:
{
  sops.secrets = {
    "anthropic-api-key" = {};
    "telegram-bot-token" = {};
    # ... per-integration secrets
  };

  systemd.services.assistant = {
    description = "AI Assistant Runtime";
    after = [ "network-online.target" "postgresql.service" "redis.service" ];
    wants = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      WorkingDirectory = "/var/lib/assistant";
      StateDirectory = "assistant";
      DynamicUser = true;
      Restart = "on-failure";
      RestartSec = "5s";
      LoadCredential = [
        "anthropic-api-key:${config.sops.secrets."anthropic-api-key".path}"
        "telegram-bot-token:${config.sops.secrets."telegram-bot-token".path}"
      ];
    };
    script = ''
      export ANTHROPIC_API_KEY=$(cat "$CREDENTIALS_DIRECTORY/anthropic-api-key")
      export TELEGRAM_BOT_TOKEN=$(cat "$CREDENTIALS_DIRECTORY/telegram-bot-token")
      exec ${pkgs.nodejs}/bin/node /var/lib/assistant/dist/index.js
    '';
  };
}
```

## Secrets

All API keys in sops (`secrets/secrets.yaml`), decrypted at service start via `LoadCredential`. Never in environment files or git.

| Secret | Purpose |
|-|-|
| `anthropic-api-key` | Claude API (interactive, per-token) |
| `telegram-bot-token` | Telegram Bot API |
| Per-integration keys | Gmail, Calendar, Strava, etc. (added as integrations ship) |

## Deployment

Build TypeScript -> `dist/`. Copy to nucleus via `scp` or nix package. `systemctl restart assistant`.

Future: proper nix package with `buildNpmPackage` or similar.

## Monitoring

Expose Prometheus metrics on a localhost port:
- LLM call count, latency, token usage, errors
- Memory operations (retain/recall/reflect count, latency)
- BullMQ job counts (completed, failed, delayed, active)
- Conversation count, messages per conversation

Scrape into existing VictoriaMetrics. Grafana dashboard.

## Web UI (Optional)

If needed, expose Bull Board or a custom status page via Cloudflare Tunnel (`assistant.timur.fyi`). Already have the pattern — add ingress rule to `tf/cloudflare/tunnel.tf`.

## Scaling Triggers

| Signal | Action |
|-|-|
| Node.js OOM or swap pressure | Move to Hetzner (EUR 10-30/mo, 16-32GB) |
| API costs > EUR 50/mo sustained | Evaluate Mac Mini for local sub-task inference |
| pgvector index > 1GB | Evaluate dedicated vector store or upgrade SSD |
