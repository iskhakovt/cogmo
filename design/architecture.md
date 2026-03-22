# Architecture

## Core Principle

The memory layer is a dumb store; all intelligence lives in Claude sessions. Agent invocations are stateless — webhook triggers fresh agent, reads config from DB, calls tools via MCP, responds, exits. Evolution supervisor edits configs between invocations.

## Topology: Orchestrator-Worker (Hub-and-Spoke)

No peer mesh (17x error amplification in Google/MIT research, 0 production successes, Cursor's 20-agent flat deployment failed). Orchestrator-worker with centralized validation (4.4x error rate vs 17.2x without).

```
                    +-----------------------+
                    |   Evolution Supervisor |  (async background)
                    |   - reviews extractions|
                    |   - evolves prompts    |
                    |   - updates configs    |
                    +-----------+-----------+
                                |
                    +-----------v-----------+
                    |     Orchestrator       |
                    |   - routes requests    |
                    |   - holds secrets      |
                    |   - validates outputs  |
                    +-----------+-----------+
                                |
              +-----------------+------------------+
              |                 |                   |
    +---------v---+   +---------v---+   +----------v--+
    | Conversation|   | Ingestion   |   | Extraction  |
    | Agent       |   | Agents      |   | Agent       |
    | (Telegram)  |   | (email,cal) |   | (Observer)  |
    +-------------+   +-------------+   +-------------+
```

## Data Flow

```
INGESTION (scheduled, headless)              RETRIEVAL (interactive)

  [Email / Calendar / Strava / ...]            [User on Telegram]
              |                                        |
     claude -p (background)                   anthropic SDK (per-token)
     "extract important facts"                "answer using memory"
              |                                        |
     hindsight.retain(fact, network)          hindsight.recall(query)
              |                                        |
              +------------ Hindsight TS SDK ----------+
                                   |
                              PostgreSQL
                         (pgvector + memories)
```

## Three Memory Write Paths

| Path | Trigger | Method |
|-|-|-|
| Real-time | User says "remember X" | User intent, immediate `retain()` |
| Post-conversation (Observer) | Chat idle ~5 min | Bot code extracts facts from transcript |
| Scheduled ingestion | Cron / BullMQ | Pull email/calendar/etc, extract, `retain()` |

## Two-Tier Memory

| Tier | Contents | Storage |
|-|-|-|
| Private | Per-agent conversation context, scratchpad | Session-scoped rows in PostgreSQL |
| Shared | Facts, preferences, decisions, people, events | Hindsight (PostgreSQL + pgvector). All agents read/write. `agent_id` column tracks provenance |

## Multi-Agent Memory Consistency

Additive-only writes. Never fail a write. Post-conversation dedup via Hindsight's `reflect()` or periodic Claude pass running async.

## Component Map

| Component | Implementation | Runs as |
|-|-|-|
| Orchestrator | TypeScript, raw SDK while loop + tool dispatch | Main Node.js process |
| Conversation agent | Claude tool call from orchestrator | Inline (same process) |
| Ingestion agents | Claude tool calls, scheduled | BullMQ workers |
| Extraction agent | Claude tool call, post-conversation | BullMQ delayed job |
| Evolution supervisor | Claude, periodic | BullMQ cron job |
| Memory | Hindsight TS SDK | Library (PostgreSQL backend) |
| Scheduler | BullMQ | Library (Redis backend) |
| Interfaces | Telegram adapter (webhook) | Express/Fastify HTTP handler |
| MCP integrations | MCP client SDK | Per-integration MCP servers |
