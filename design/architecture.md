# Architecture

## Core Principles `[confirmed]`

**Memory is a dumb store** — all intelligence lives in Claude sessions. Hindsight stores and retrieves; Claude decides what matters.

**Stateless per invocation** — the Node.js process stays up (HTTP server, Inngest Connect workers), but each agent invocation is stateless. Webhook triggers fresh agent call, agent reads latest config/memory from DB, calls tools via MCP, responds, done. No in-memory state carries between invocations. This means framework "immutable at runtime" limitations don't apply — self-evolution is just "edit config/prompts between invocations."

**Model-agnostic API tier** — orchestrator uses raw SDK calls. Interactive tier can be Claude Sonnet, GPT, or Grok — swap providers without touching orchestration. Background tasks use `claude -p` headless (subscription, $0).

## Topology: Orchestrator-Worker (Hub-and-Spoke) `[confirmed]`

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
    |             |   | (email,cal) |   | (Observer)  |
    +-------------+   +-------------+   +-------------+
```

## Data Flow `[confirmed]`

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

## Three Memory Write Paths `[confirmed]`

| Path | Trigger | Method |
|-|-|-|
| Real-time | User says "remember X" | User intent, immediate `retain()` |
| Post-conversation (Observer) | Chat idle ~5 min | Bot code extracts facts from transcript |
| Scheduled ingestion | `scheduled_tasks` row + ticker fan-out (see [scheduling.md](scheduling.md)) | Pull email/calendar/etc, extract, `retain()` |

## Two-Tier Memory `[confirmed]`

| Tier | Contents | Storage |
|-|-|-|
| Private | Per-agent conversation context, scratchpad | Session-scoped rows in PostgreSQL |
| Shared | Facts, preferences, decisions, people, events | Hindsight (PostgreSQL + pgvector). All agents read/write. `agent_id` column tracks provenance |

## Multi-Agent Memory Consistency `[proposed]`

Additive-only writes. Never fail a write. Hindsight consolidates each `retain()` into existing observations ([memory.md](memory.md)).

## Component Map `[proposed]`

| Component | Implementation | Runs as |
|-|-|-|
| Orchestrator | Inngest functions + raw SDK tool dispatch | Main Node.js process (Inngest Connect) |
| Conversation agent | Inngest function, triggered by `inbound/arrived` event | Durable steps in main process |
| Ingestion agents | Inngest functions, cron-triggered | Durable steps in main process |
| Extraction agent | Inngest function, triggered by `conversation/idle` event | Durable steps in main process |
| Evolution supervisor | Inngest function, cron-triggered | Durable steps in main process |
| Memory | Hindsight HTTP client → self-hosted Hindsight server | Docker service (Python, uses PostgreSQL + pgvector internally) |
| Orchestration | Inngest (self-hosted) | Go binary (Connect via WebSocket) |
| Interfaces | Channel adapters (`AdapterModule` contract) | Table-driven: direct (Inngest events), Telegram (long polling), future: webhooks, SSE |
| MCP integrations | MCP client SDK | Per-integration MCP servers |

## Orchestration Coupling `[confirmed]`

Orchestration is Inngest ([scheduling.md](scheduling.md)), and the code depends on it on purpose, in three layers:

| Layer | Where | Depends on |
|-|-|-|
| Functions | `inngest.createFunction` in the domain module that owns the work (`agent/handle-message.ts`, `agent/debounce.ts`, `transport/boundary/janitor.ts`, …) | Inngest directly: triggers, concurrency, debounce, `cancelOn`, retries and `onFailure` are its configuration |
| Controllers | Each function's handler | Reads the event, calls `fromStepTools(step)` once and hands the port to the use cases, where the logic lives |
| Use cases | One file per action in the domain module | The `Durable` port in `src/inngest/durable.ts` — `run`, `sendEvent`, `sleep`, `waitForEvent` — typed against the events `src/inngest/events.ts` defines, and `EventPublisher` (`send`) where a deps bag only emits |

The port narrows what a use case can reach and makes it testable with an in-memory fake (`src/test/fake-durable.ts`). `Durable.run` also checks at compile time that a step's result survives the JSON round-trip through Inngest's state store, so it returns `T`, not Inngest's `Jsonify<T>`. It does not hide Inngest's execution model: replays, step-id determinism and memoized results as a contract with runs in flight ([.agents/rules/inngest.md](../.agents/rules/inngest.md)) apply through it unchanged, and `NonRetriableError` and `StepError` stay Inngest's.

A handler that plans at most one step inline (`coding-auto-register-skill`, `coding-cleanup-run-branch`, `model-catalog-refresh`, `skill-cron-fire`, `handle-message-reconcile`, `sandbox-reaper`) may call `step` directly. Multi-step handlers not yet on the port are tracked in `todo.md`: `idle-timer`, `recover-conversation`, `coding-task-reconcile`, `scheduled-task-fire`, `skill-venvs-reaper`, the orphan-branch sweep's cron, `boundary-waiter` and `boundary-janitor` call `step` directly, and the Observer (`agent/evolution/observer.ts`) plans through its own `run`-only harness bridged with a cast, because several of its step results carry rows with `Date` fields the JSON check rejects.

A fully engine-neutral layer is not built. Replacing Inngest would mean re-deciding function configuration, failure handling and replay semantics, not swapping an adapter, and the alternatives were eliminated for reasons a wrapper doesn't change ([decisions.md](decisions.md) → Decision Table: Orchestration abstraction, and Eliminated Options: Temporal, DBOS Transact). An abstraction over every engine's model would cost each feature now for a migration nobody has planned.

## Hindsight Deployment `[confirmed]`

Hindsight is a **client-server system**. `@vectorize-io/hindsight-client` is a pure HTTP client; the server (`ghcr.io/vectorize-io/hindsight`) is a self-hosted Python service that manages its own PostgreSQL + pgvector storage. Runs as a Docker service alongside our app.

- **Server image:** `ghcr.io/vectorize-io/hindsight:latest`
- **Ports:** 8888 (API), 9999 (UI)
- **LLM provider:** Configurable — supports Anthropic, OpenAI, Ollama, etc. Uses LLM for memory extraction and reflection.
- **Storage:** Can share our PostgreSQL instance (separate database/schema) or use its embedded Postgres.
- **Client config:** Just `baseUrl` + optional `apiKey`. No database connections from our app.

## Background Tasks: Claude Code Agent SDK `[research]`

Three tiers of LLM calls:

| Tier | When | How | Cost |
|-|-|-|-|
| Anthropic SDK (`client.messages.create`) | Interactive chat (user waiting) | In-process, per-token billing | ~$80-400/mo |
| Claude Agent SDK (`claude-agent-sdk`) | Background tasks (extraction, ingestion) | Subprocess via SDK, subscription auth | $0 (subscription) |
| Claude Agent SDK (long-running) | Coding tasks (refactor, fix tests) | Subprocess, isolated worktree, 30+ min | $0 (subscription) |

### Claude Agent SDK (not raw `claude -p`)

Reference: `claude-code-telegram` (deployed on nucleus as `@nucleus_claude_bot`) uses `claude-agent-sdk` Python SDK, which drives the Claude Code CLI as a subprocess. The SDK provides:
- Session resumption (multi-turn via `options.resume = session_id`)
- Streaming (real-time `AssistantMessage`, `ToolUseBlock`, `ResultMessage`)
- Tool permission callbacks (`can_use_tool` for security gating)
- Cost tracking (`total_cost_usd` on `ResultMessage`)
- MCP server passthrough
- Built-in sandbox support (`sandbox.enabled`)

TypeScript equivalent: `@anthropic-ai/claude-agent-sdk` — verify maturity before adopting.

Architecture: `Our app → claude-agent-sdk → claude CLI process → Anthropic API`

### Async pattern for long-running tasks

Long-running Claude Code sessions (coding tasks, 30+ min) should NOT block a workflow step. Instead, decouple via events:

1. Spawn Claude Code session as detached process
2. Workflow suspends via `step.waitForEvent("claude-task/completed", timeout: "2h")`
3. Wrapper/hook sends completion event when session finishes
4. Workflow resumes, collects results

### Session isolation for coding tasks `[research]`

Only coding tasks need filesystem isolation (chat, extraction, ingestion don't touch the filesystem).

| Approach | Isolation | Overhead | When to use |
|-|-|-|-|
| **Git worktrees** | Branch-level, shared .git | Instant, minimal disk | Coding tasks on own repo |
| **Claude Code sandbox** | Process-level (seccomp/namespace) | Minimal | Always for subprocess tasks |
| **Container per session** | Full filesystem + process | Slower startup, more RAM | Untrusted code execution |

Recommended combo: **git worktree + Claude Code sandbox**. Worktree prevents main branch corruption, sandbox prevents process escape. No containers needed for personal use.

Workflow pattern:
```
event: coding-task/requested
  → step: create worktree + branch
  → step: spawn claude-agent-sdk session (cwd = worktree)
  → waitForEvent("coding-task/completed")
  → step: review results (diff, test output)
  → step: merge or request human approval
  → step: cleanup worktree
```
