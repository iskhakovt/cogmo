# Overview

Personal life-management agent runtime. Long-running Node.js process that orchestrates specialist sub-agents, maintains persistent cross-session memory, schedules its own background work, and self-evolves through a 6-stage ladder.

## Glossary `[confirmed]`

| Term | Meaning |
|-|-|
| **Tool** | An LLM-callable function. Defined by name, description, and JSON Schema input. The LLM decides when to call it via `tool_use`. Implementation can be simple (return current time) or heavy (run a nested agent loop). See `ToolSpec` in `src/agent/tools.ts`. |
| **Agent** | An autonomous loop with its own system prompt, tool set, and model. Heavier than a simple tool — makes multiple LLM calls. Exposed to the orchestrator as a Tool (agents-as-tools pattern). The orchestrator doesn't distinguish agents from simple tools — both are `ToolSpec` entries. |
| **Service** | Scoped runtime dependencies injected into tool handlers by the orchestrator. The ACL boundary — tools access memory, http, etc. through this interface, never via direct service references. Scoped per conversation turn (userId, profile rules baked in). See `Service` in `src/agent/service.ts`. |
| **Channel** | A platform connection (Telegram, Direct, Slack). DB row with credentials and identity mode. Each channel type has an `AdapterModule` in `src/transport/adapters/`. |
| **Channel Session** | Maps a platform address to an active conversation (a Telegram DM, a Direct event address, a Web UI tab). Invisible to the agent — only the transport layer manages sessions. |
| **Conversation** | A dialogue thread with shared LLM context. No explicit lifecycle — just goes idle. |
| **Profile** | A named agent configuration: base prompt, model, enabled tools. Conversations use a profile. |
| **Orchestrator** | The `handle-message` Inngest function. Thin controller — resolves session, constructs scoped service, calls the agent loop, emits response events. Zero business logic. |
| **Control Command** | A channel command that doesn't go through the orchestrator (`/new`, `/profile`, `/settings`). Intercepted by the channel adapter, executed via domain services directly. Instant response, no LLM call. Distinct from regular messages which flow through the full pipeline. |
| **Steering Rules** | Dynamic behavioral rules stored as DB rows, injected into system prompts at invocation time. Can be global or scoped to a profile. Managed by evolution stages. |
| **Observer** | Post-conversation extraction. Runs after a conversation goes idle, extracts facts into Hindsight memory. |

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
