# Data Model

All application state in PostgreSQL (nucleus, port 5432). Hindsight manages its own tables for memory storage. These are the application tables.

## Tables

### conversations

Active and recent conversation sessions.

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,            -- UUID
  channel TEXT NOT NULL,          -- 'telegram', 'cli', 'api'
  user_id TEXT NOT NULL,          -- channel-specific user ID
  cursor TEXT,                    -- last processed message ID (crash recovery)
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ            -- NULL = active, set when idle timeout triggers Observer
);
```

### session_history

Conversation messages for context assembly. Pruned after Observer extraction.

```sql
CREATE TABLE session_history (
  id SERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL,              -- 'user', 'assistant', 'tool_result'
  content JSONB NOT NULL,         -- message content (text or tool use blocks)
  token_count INT,                -- for context window budgeting
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_session_history_conv ON session_history(conversation_id, created_at);
```

### steering_rules

AI steering rules injected into system prompts. Managed by Stage 1 evolution.

```sql
CREATE TABLE steering_rules (
  id SERIAL PRIMARY KEY,
  rule TEXT NOT NULL,
  category TEXT NOT NULL,          -- 'safety', 'style', 'domain', 'memory'
  active BOOLEAN NOT NULL DEFAULT true,
  source TEXT,                     -- 'manual', 'correction', 'signal_pipeline'
  observation_count INT DEFAULT 1, -- for rule graduation (2+ = promoted)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### signals

Conversation signals for Stage 5 evolution.

```sql
CREATE TABLE signals (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  signal_type TEXT NOT NULL,       -- 're-ask', 'correction', 'task_completion', 'result_usage', 'sentiment'
  content TEXT NOT NULL,
  reliability TEXT NOT NULL,       -- 'high', 'medium', 'low'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_signals_session ON signals(session_id);
```

### prompt_versions

Versioned prompts for Stage 4 optimization. Tracks what was tried and how it scored.

```sql
CREATE TABLE prompt_versions (
  id SERIAL PRIMARY KEY,
  prompt_name TEXT NOT NULL,       -- 'system_prompt', 'extraction_prompt', etc.
  version INT NOT NULL,
  content TEXT NOT NULL,
  score FLOAT,                     -- evaluation score (NULL = untested)
  metadata JSONB,                  -- few-shot examples, rubric results, etc.
  active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(prompt_name, version)
);
```

### skills

Skill library metadata for Stage 2. Code lives on filesystem (`skills/code/`), descriptions here for retrieval.

```sql
CREATE TABLE skills (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,       -- retrieval key (embedded for vector search)
  file_path TEXT NOT NULL,         -- relative path to skills/code/
  tier INT NOT NULL DEFAULT 1,     -- 1=name+desc, 2=full instructions, 3=scripts
  approved BOOLEAN NOT NULL DEFAULT false,  -- human review gate
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### scheduled_tasks

Agent-created scheduled tasks. Mirrors BullMQ repeatable jobs for queryability.

```sql
CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,             -- matches BullMQ job ID
  name TEXT NOT NULL,
  cron TEXT NOT NULL,              -- cron expression
  prompt TEXT,                     -- what the agent should do
  created_by TEXT,                 -- 'agent', 'manual'
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Hindsight Tables (Managed Externally)

Hindsight creates and manages its own tables in the `assistant` database. Do not modify these directly. Interact via the Hindsight TS SDK (`retain`, `recall`, `reflect`).

Memory metadata (agent_id, source, confidence, mention_count, last_mentioned_at) is stored as Hindsight metadata fields, not in a separate table.

## Schema Migrations

No ORM. Use raw SQL migration files in `migrations/` directory, numbered sequentially (`001_init.sql`, `002_add_signals.sql`, etc.). Run on startup if not yet applied (track in a `schema_migrations` table).

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```
