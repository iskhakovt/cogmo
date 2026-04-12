# Data Model

**Source of truth:** Drizzle ORM schemas in `src/<module>/store/schema.ts`. Migrations via `drizzle-kit generate` / `drizzle-kit migrate`.

All tables use UUID v7 primary keys (DB-generated) and `created_at TIMESTAMPTZ DEFAULT now()`. All DB operations use transactions.

## Table Index

Tables are documented in the design doc that owns their domain:

| Table | Doc | Notes |
|-|-|-|
| `users` | [transport/identity.md](transport/identity.md) | Conversation owners |
| `user_identities` | [transport/identity.md](transport/identity.md) | Platform handle → user mapping. IS the allowlist. |
| `channels` | [transport/overview.md](transport/overview.md) | Platform connections (credentials, identity mode) |
| `profiles` | [transport/overview.md](transport/overview.md) | Agent configurations (prompt, model, tools). Org-scoped. |
| `conversations` | [transport/overview.md](transport/overview.md) | Dialogue threads. No lifecycle — go idle naturally. |
| `messages` | [transport/overview.md](transport/overview.md) | Conversation turns. Immutable. Carry `lastInboundMessageId` cursor. |
| `channel_sessions` | [transport/sessions.md](transport/sessions.md) | Platform address → conversation mapping |
| `inbound_messages` | [transport/debounce.md](transport/debounce.md) | Raw input staging buffer for debounce batching |
| `steering_rules` | [agents.md](agents.md) | Dynamic behavioral rules injected into system prompts |
| `core_memory_blocks` | [agents.md](agents.md) | Structured persistent notes (user profile, projects). Upsert by (user_id, key). Always in system prompt. |

## New Tables (Setup Infrastructure) `[proposed]`

| Table | Doc | Notes |
|-|-|-|
| `secrets` | [infrastructure.md](infrastructure.md) | Encrypted credentials (AES-256-GCM). Name-keyed. |
| `llm_providers` | [providers.md](providers.md) | Provider config (type, base_url, secret FK, attrs, validation status) |

`profiles` gains `provider_id UUID FK → llm_providers` — see [providers.md](providers.md).

## Deferred Tables `[proposed]`

Design sketches — added via Drizzle migrations when their phase begins.

| Table | Phase | Purpose |
|-|-|-|
| `agent_traces` | 2 | LLM execution log (tool calls, reasoning). FK → messages. |
| `reflections` | 2 | Tracks Observer runs (conversation_id, covered_up_to message). |
| `aliases` | 2 | Human-friendly conversation names ('work', 'shopping'). Scoped per user. |
| `signals` | 2 | Conversation signals for evolution pipeline (re-ask, correction, etc.). |
| `skills` | 3 | Skill library metadata. Code on filesystem, descriptions for retrieval. |

## Hindsight Tables (Managed Externally) `[confirmed]`

Hindsight server creates and manages its own tables in its own database. Do not modify directly — interact via the Hindsight HTTP client (`retain`, `recall`, `reflect`).

## Key Design Decisions

| Decision | Rationale |
|-|-|
| UUID v7 for all PKs | Time-ordered (B-tree perf), globally unique, DB-generated (prevents manipulation) |
| Separate inbound_messages / messages | Different lifecycles: inbound = durability buffer, messages = conversation turns. See [debounce.md](transport/debounce.md). |
| No `ended_at` on conversations | Conversations go idle, don't end. `/new` creates a new one. |
| Profiles separate from conversations | Different rates of change. Profile = what the agent is. Conversation = what's being discussed. |
| Steering rules separate from prompts | Rules change fast (per correction), prompts change slow (globally optimized). Rules can be toggled, prioritized, scoped. |
| Serialized per conversation | Agents not thread-safe (Letta docs). `concurrency: { limit: 1, key: conversationId }`. |
