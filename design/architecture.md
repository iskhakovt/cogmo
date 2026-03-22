# Architecture

## Core Principles

**Memory is a dumb store** — all intelligence lives in Claude sessions. Hindsight stores and retrieves; Claude decides what matters.

**Stateless per invocation** — the Node.js process stays up (HTTP server, BullMQ workers), but each agent invocation is stateless. Webhook triggers fresh agent call, agent reads latest config/memory from DB, calls tools via MCP, responds, done. No in-memory state carries between invocations. This means framework "immutable at runtime" limitations don't apply — self-evolution is just "edit config/prompts between invocations."

**Model-agnostic API tier** — orchestrator uses raw SDK calls. Interactive tier can be Claude Sonnet, GPT, or Grok — swap providers without touching orchestration. Background tasks use `claude -p` headless (subscription, $0).

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
| Interfaces | Telegram adapter (webhook) | Express/Fastify HTTP handler (unconfirmed — implementation-time choice) |
| MCP integrations | MCP client SDK | Per-integration MCP servers |

## Hindsight Deployment

Hindsight is an **in-process npm library** (`@vectorize-io/hindsight-client`), not a separate service (assumed, needs verification against Hindsight docs). It connects directly to PostgreSQL + pgvector from the Node.js process. No Docker container, no sidecar. Zero additional RAM beyond what PostgreSQL uses for pgvector indexes.

## Background Tasks: `claude -p` vs SDK

Two code paths for LLM calls:

| Path | When | How | Cost |
|-|-|-|-|
| Anthropic SDK (`client.messages.create`) | Interactive (user waiting) | In-process, per-token billing | ~$80-400/mo |
| `claude -p` (headless CLI) | Background (ingestion, extraction, evolution) | Spawn as child process, pipe stdin/stdout (suggested pattern, not proven) | $0 (subscription) |

Background workers (BullMQ jobs) shell out to `claude -p` with a prompt, parse the structured output. Interactive agents use the SDK directly for lower latency.
