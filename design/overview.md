# Overview

Personal life-management agent runtime. Long-running Node.js process that orchestrates specialist sub-agents, maintains persistent cross-session memory, schedules its own background work, and self-evolves through a 6-stage ladder.

## What It Does

- **Manages life-wide knowledge:** email, calendar, finances, health, travel, recipes, people, decisions
- **Proactively acts:** morning briefings, nudges, scheduled ingestion of external data
- **Learns over time:** extracts facts from every interaction, evolves prompts and skills as data accumulates
- **Exposes pluggable interfaces:** Telegram first, but messenger is just transport

Month 6 should be qualitatively different from month 1.

## Constraints

| Constraint | Value |
|-|-|
| Hardware | ASUS NUC14MNK150 — Intel N150, 8GB DDR5 (soldered), 256GB SSD |
| Free RAM | ~4GB after existing services |
| Local LLM | Not viable on this hardware — cloud only |
| Language | TypeScript on Node.js (not Bun — documented memory leaks in long-running processes) |
| Framework | None — raw Anthropic/OpenAI SDK |
| Budget | ~$80-200/mo API costs (Sonnet for real-time), $0 for background via `claude -p` subscription |

## What Exists on Nucleus

| Service | Detail |
|-|-|
| PostgreSQL 18 | + PostGIS, listening 0.0.0.0, peer auth for local |
| Redis | Port 6380, all interfaces |
| sops-nix | Age encryption, secrets in `secrets/secrets.yaml` |
| Tailscale | Mesh VPN, HTTPS serve for web UIs |
| Cloudflare Tunnel | `*.timur.fyi` routes to localhost ports |
| Telegram bot infra | claude-code-telegram as reference (SDK-based, multi-turn) |

## Cost Model

| Use case | Method | Cost |
|-|-|-|
| Interactive (Telegram) | Anthropic SDK, per-token | ~$80-200/mo (Sonnet) |
| Background (ingestion, extraction, evolution) | `claude -p` headless | $0 (subscription) |
| Local sub-tasks (future, Mac Mini tier) | Ollama | $0 after hardware |

## Scaling Path

NUC (free, ~4GB headroom) -> Hetzner cloud (EUR 10-30/mo when RAM tight) -> Mac Mini M4 Pro ($1,400-2,600 when sustained cloud costs justify hardware). Prove workload at each tier before upgrading.

## RAM Budget for This Project

| Component | RAM |
|-|-|
| Node.js (bot + BullMQ workers) | 100-300MB |
| pgvector index (small corpus) | 200-500MB |
| Redis (shared, already running) | 0 additional |
| **Total new** | **~300-800MB** |
