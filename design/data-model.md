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
| `model_providers` | [providers.md](providers.md) | Model → provider routing with position-based priority. UNIQUE(model, position) prevents ties. `user_selectable` flag gates user-facing model picker. Optional `context_window` / `max_output_tokens` columns let operators pin limits when LiteLLM doesn't know the model; both nullable, fall through to the bundled LiteLLM snapshot then a conservative default. Managed via `cogmo model add/list/remove` or the setup wizard's model picker. |
| `image_providers` | [image-generation.md](image-generation.md) | Image-gen provider config (`pgEnum` type ∈ {fal, openai_compatible}, base_url, secret FK, attrs). CHECK constraint: `openai_compatible` requires `base_url`, `fal` requires `NULL`. No fallback chain. |
| `image_models` | [image-generation.md](image-generation.md) | Image model catalog. `name` is LLM-facing (globally unique), `model_string` is API-facing, `description` is read by the LLM at every turn, `capabilities JSONB` declares per-model knobs (aspectRatios, seed, future). `user_selectable` gates LLM exposure. |
| `sub_agents` | [agents.md](agents.md) | Per-user sub-agent catalog (agents-as-tools). A thin binding over a routable model: `name` → `subagent__<name>` tool, `description` (routing signal the orchestrator reads), `system_prompt` (nullable persona — null = pure model-as-tool), `model` (resolved via the `LlmProviderResolver`, not `user_selectable`-gated). Availability is per-profile via `profiles.tool_set` globs — no join table. Managed via `cogmo subagent add/list/remove`. |

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
| `scheduled_tasks` | 2 | User/agent-defined cron + one-off schedules. Source of truth for `schedule_task` / `list_tasks` / `remove_task` agent tools and wizard recurring-tasks step. See [scheduling.md](scheduling.md) → Agent Self-Scheduling. |
| `mcp_servers` | 2 | MCP server configs (transport, config blob, enabled, approval). See [integrations/mcp.md](integrations/mcp.md). |
| `mcp_server_tools` | 2 | Per-tool schema hash + approval state. Cascades from `mcp_servers`. |
| `skills` | 3 | Skill library metadata. Code on filesystem, descriptions for retrieval. |
| `pipeline_definitions` | 8 | Versioned user-defined pipeline definitions (free-text source + compiled JSONB; immutable except `active`). See [pipelines.md](pipelines.md). |
| `pipeline_runs` | 8 | Pipeline run state — pinned definition version, current stage, typed stage outputs, wait keys. See [pipelines.md](pipelines.md). |

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

## Migration Conventions `[confirmed]`

- **Migrations and snapshots are tool-generated.** `pnpm db:generate` produces both the SQL file and the JSON snapshot. Do not hand-edit `migrations/NNNN_*.sql` or `migrations/meta/NNNN_snapshot.json`. The only acceptable hand-edit to `migrations/meta/_journal.json` is renaming a `tag` to match a renamed `.sql` file.
- **Format the output through biome.** drizzle-kit emits tab-indented JSON; the project formats with 2-space indent. Run `pnpm biome check --write migrations/meta/` after every `db:generate`.
- **Per-file transactions.** The boot path uses `migratePerFile` (`src/db/migrate-per-file.ts`), one transaction per migration file. Cross-file atomicity is not preserved — a failure in file N leaves files <N committed. Required for the `ALTER TYPE … ADD VALUE` + same-tx-use pattern below.
- **Splitting a logical schema change across two migration files** (canonical case: `ALTER TYPE … ADD VALUE 'X'` in file N, followed by a CHECK / DEFAULT / column type referencing `'X'` in file N+1 — Postgres rejects same-tx use of a freshly-added enum value): use the **schema.ts rewind dance**, not hand-rolled intermediate snapshots.
  1. Revert `schema.ts` to the intermediate state (value added but not yet referenced).
  2. `pnpm db:generate` → produces N + N's snapshot.
  3. Restore `schema.ts` to the final state.
  4. `pnpm db:generate` → produces N+1 + N+1's snapshot.
  5. Rename both auto-generated `NNNN_<marvel-name>.sql` files to descriptive slugs and update the matching `_journal.json` `tag` entries.
  6. `pnpm biome check --write migrations/meta/`.

  Both snapshots are then tool-generated, biome-clean, and reflect real states the schema.ts editor went through.

- **Already-applied migrations are immutable.** Editing the SQL of a committed migration is a structural error. `migratePerFile` hashes the on-disk file and compares against the recorded hash on every run; a mismatch throws rather than silently re-applying or skipping.
- **Out-of-order `when` timestamps are rejected.** A new migration whose journal `when` is ≤ the high-water mark of applied migrations is a backdated journal entry; `migratePerFile` throws rather than apply out of order.
