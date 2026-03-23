# Overview

Personal life-management agent runtime. Long-running Node.js process that orchestrates specialist sub-agents, maintains persistent cross-session memory, schedules its own background work, and self-evolves through a 6-stage ladder.

## What It Does `[confirmed]`

- **Manages life-wide knowledge:** email, calendar, finances, health, travel, recipes, people, decisions
- **Proactively acts:** morning briefings, nudges, scheduled ingestion of external data
- **Learns over time:** extracts facts from every interaction, evolves prompts and skills as data accumulates
- **Exposes pluggable interfaces:** Telegram first, but messenger is just transport

Month 6 should be qualitatively different from month 1.

## Constraints `[confirmed]`

| Constraint | Value |
|-|-|
| Local LLM | Cloud only for now — revisit when local hardware justifies it |
| Language | TypeScript on Node.js (not Bun — documented memory leaks in long-running processes) |
| Framework | None — raw Anthropic/OpenAI SDK |
| Budget | ~$80-200/mo API costs (Sonnet for real-time), $0 for background via `claude -p` subscription |

## Cost Model `[proposed]`

| Use case | Method | Cost |
|-|-|-|
| Interactive (Telegram) | Anthropic SDK, per-token | ~$80-200/mo (Sonnet) |
| Background (ingestion, extraction, evolution) | `claude -p` headless | $0 (subscription) |
| Local sub-tasks (future, Mac Mini tier) | Ollama | $0 after hardware |

## Scaling Path `[proposed]`

Start on current host. Monitor RAM and API costs. Scale host or add local inference when actual pressure appears — not before.
