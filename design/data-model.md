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
| `profiles` | [transport/overview.md](transport/overview.md) | Agent configurations (prompt, model, tools). `user_id` nullable: NULL = org profile (managed out-of-band, read-only via Transport), set = user profile (owned by that user). |
| `conversations` | [transport/overview.md](transport/overview.md) | Dialogue threads. No lifecycle — go idle naturally. |
| `messages` | [transport/overview.md](transport/overview.md) | Conversation turns. Immutable. Content stored as full `ContentBlock[]` (text, tool_use, tool_result, image, thinking). Carry `lastInboundMessageId` cursor, plus `profileId` + `model` stamps so history survives mid-conversation profile/model changes. |
| `channel_sessions` | [transport/sessions.md](transport/sessions.md) | Platform address → conversation mapping |
| `inbound_messages` | [transport/debounce.md](transport/debounce.md) | Raw input staging buffer for debounce batching |
| `steering_rules` | [agents.md](agents.md) | Dynamic behavioral rules injected into system prompts. Written by manual insertion and automated correction extraction (Stage 1 evolution). |
| `core_memory_blocks` | [agents.md](agents.md) | Structured persistent notes (user profile, projects). Upsert by (user_id, key). Always in system prompt. |
| `aliases` | [transport/sessions.md](transport/sessions.md) | Human-friendly conversation names ('work', 'shopping'). Scoped per user (`UNIQUE(user_id, alias)`). Set via `transport.conversations.setAlias` (`/name <alias>` in Telegram). |

## New Tables (Setup Infrastructure) `[confirmed]`

| Table | Doc | Notes |
|-|-|-|
| `secrets` | [infrastructure.md](infrastructure.md) | Encrypted credentials (AES-256-GCM). Name-keyed. |
| `llm_providers` | [providers.md](providers.md) | Provider config (`pgEnum` type, base_url, secret FK, attrs) |
| `model_providers` | [providers.md](providers.md) | Model → provider routing with position-based priority. UNIQUE(model, position) prevents ties. `user_selectable` flag gates user-facing model picker (admin-managed via psql). |
| `image_providers` | [image-generation.md](image-generation.md) | Image-gen provider config (`pgEnum` type ∈ {fal, openai_compatible}, base_url, secret FK, attrs). CHECK constraint: `openai_compatible` requires `base_url`, `fal` requires `NULL`. No fallback chain. |
| `image_models` | [image-generation.md](image-generation.md) | Image model catalog. `name` is LLM-facing (globally unique), `model_string` is API-facing, `description` is read by the LLM at every turn, `capabilities JSONB` declares per-model knobs (aspectRatios, seed, future). `user_selectable` gates LLM exposure. |

`profiles` gains:
- `summarization_model TEXT` (nullable, replaces `SUMMARIZATION_MODEL` env var).
- `auto_recall auto_recall_mode NOT NULL DEFAULT 'heuristic'` — Postgres enum (`off`, `always`, `heuristic`, `llm`). Controls auto-recall behavior. See [memory.md](memory.md) → Auto-Recall and Intention Gate.

## Deferred Tables `[proposed]`

Design sketches — added via Drizzle migrations when their phase begins.

| Table | Phase | Purpose |
|-|-|-|
| `agent_traces` | 2 | LLM execution log (tool calls, reasoning). FK → messages. |
| `reflections` | 2 | Tracks Observer runs (conversation_id, covered_up_to message). |
| `signals` | 2 | Conversation signals for evolution pipeline (re-ask, correction, etc.). |
| `mcp_servers` | 2 | MCP server configs (transport, config blob, enabled, approval). See [integrations/mcp.md](integrations/mcp.md). |
| `mcp_server_tools` | 2 | Per-tool schema hash + approval state. Cascades from `mcp_servers`. |
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
| Profiles split into org + user (nullable `user_id`) | Org profiles (NULL) are admin-curated and shared, evolving as a unit via shared steering rules. User profiles (set) are private and self-managed. Transport never mutates org profiles — admin ops happen out-of-band (psql/wizard). No admin role in code. |
| `user_selectable` on `model_providers` | Org policy gate: admins can route internal models (cheap summarization, experimental) via `model_providers` without exposing them in the user `/model` picker. Toggled out-of-band. |
| Steering rules separate from prompts | Rules change fast (per correction), prompts change slow (globally optimized). Rules can be toggled, prioritized, scoped. |
| Serialized per conversation | Agents not thread-safe (Letta docs). `concurrency: { limit: 1, key: conversationId }`. |
