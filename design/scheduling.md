# Scheduling & Orchestration

## Decision: Inngest (Self-Hosted) `[confirmed]`

Event-driven durable execution platform. Handles queues, scheduling, durable workflows, human-in-the-loop, and observability in one tool.

| Attribute | Detail |
|-|-|
| Package | `inngest` (npm SDK) |
| Server | `inngest-cli` (single Go binary, self-hosted) |
| License | SDK: Apache 2.0, Server: SSPL (fine for personal use) |
| Architecture | Event-driven — send events, functions trigger. Connect mode uses persistent WebSocket (no inbound ports needed) |
| Durability | Each `step.run()` checkpoints. Crash between steps → resume from last completed step |
| Dependencies | PostgreSQL + Redis (or SQLite + in-memory for dev) |
| Performance | Connect + Checkpointing: ~2ms per step transition |
| Dashboard | Built-in observability UI with step-level traces |

## Why Inngest

Inngest is purpose-built for durable, event-driven workflows. It provides everything an agent runtime needs in a single tool:

| Feature | What Inngest provides |
|-|-|
| Durable execution | Each `step.run()` checkpoints — crash between steps resumes from last completed step |
| Event-driven | Core design — send events, functions trigger automatically |
| Human-in-the-loop | `step.waitForEvent()` suspends with zero resources while waiting |
| Observability | Built-in dashboard with step-level traces |
| AI features | `step.ai.infer()`, AgentKit for multi-agent |
| Cron/scheduling | Native cron triggers on any function |
| Queues/concurrency | Built-in concurrency control and rate limiting |

## Core Patterns `[proposed]`

### Message handling (event-driven pipeline)

```typescript
const handleMessage = inngest.createFunction(
  { id: "handle-message", triggers: [{ event: "inbound/ready" }] },
  async ({ event, step }) => {
    const context = await step.run("load-context", () =>
      loadConversation(event.data.conversationId)
    );

    const memories = await step.run("recall-memories", () =>
      hindsight.recall(event.data.text)
    );

    // Agentic loop — each Claude call is a durable step
    let messages = context.messages;
    let i = 0;
    while (true) {
      const response = await step.run(`claude-${i}`, () =>
        claude.messages.create({ model: "claude-sonnet-4-20250514", messages, tools })
      );

      if (response.stop_reason === "end_turn") {
        await step.run("respond", () => sendToUser(response));
        break;
      }

      const results = await step.run(`tools-${i}`, () =>
        executeTools(response.content)
      );
      messages.push(...results);
      i++;
    }

    await step.run("save", () => saveConversation(messages));
  }
);
```

### Scheduled jobs (cron)

```typescript
const morningBriefing = inngest.createFunction(
  { id: "morning-briefing", triggers: [{ cron: "30 7 * * *" }] },
  async ({ step }) => {
    const summary = await step.run("generate", () => generateBriefing());
    await step.run("send", () => sendToTelegram(summary));
  }
);
```

### Post-conversation extraction (delayed)

```typescript
const extractMemories = inngest.createFunction(
  { id: "extract-memories", triggers: [{ event: "conversation/idle" }] },
  async ({ event, step }) => {
    // Wait 5 min after idle detected (debounce)
    await step.sleep("wait-for-silence", "5m");

    const transcript = await step.run("load", () =>
      loadMessages(event.data.conversationId)
    );

    const facts = await step.run("extract", () =>
      extractFacts(transcript)
    );

    await step.run("retain", () => retainAll(facts));
  }
);
```

### Human-in-the-loop (approval)

```typescript
const reviewSkill = inngest.createFunction(
  { id: "review-skill", triggers: [{ event: "skill/created" }] },
  async ({ event, step }) => {
    await step.run("notify", () =>
      sendToTelegram(`New skill: ${event.data.name}. Approve?`)
    );

    const approval = await step.waitForEvent("skill/reviewed", {
      match: "data.skillId",
      timeout: "24h",
    });

    if (approval?.data.approved) {
      await step.run("activate", () => activateSkill(event.data.skillId));
    }
  }
);
```

### Long-running Claude Code tasks (async)

```typescript
const codingTask = inngest.createFunction(
  { id: "coding-task", triggers: [{ event: "coding-task/requested" }] },
  async ({ event, step }) => {
    await step.run("prepare", () =>
      createWorktree(event.data.branch)
    );

    await step.run("spawn", () =>
      spawnClaudeSession(event.data.prompt, event.data.worktreePath)
    );

    // Claude session runs independently — wait for completion event
    const result = await step.waitForEvent("coding-task/completed", {
      match: "data.taskId",
      timeout: "2h",
    });

    if (result?.data.success) {
      await step.run("review", () => reviewDiff(event.data.branch));
    }

    await step.run("cleanup", () => cleanupWorktree(event.data.branch));
  }
);
```

### Fan-out cron (per-item retry lanes) `[confirmed]`

For crons that touch N independent items (sweep N repos, reconcile N user accounts), fan out via `step.sendEvent` to a per-item handler instead of a serial loop. Each per-item run gets its own retry budget and lane in the dashboard, and per-item failures don't block siblings.

```typescript
// Cron emits one event per repo
const sweepCron = inngest.createFunction(
  { id: "sweep-cron", retries: 2, triggers: [{ cron: "0 4 * * 0" }] },
  async ({ step }) => {
    const repos = await step.run("list-repos", () => listRepos());
    if (repos.length === 0) return { repos: 0 };
    await step.sendEvent("fan-out",
      repos.map((r) => sweepRepoEvent.create({ repoId: r.id })));
    return { repos: repos.length };
  },
);

// Per-repo handler with its own concurrency cap + default retries
const perRepo = inngest.createFunction(
  { id: "sweep-repo", concurrency: { limit: 2 }, triggers: [sweepRepoEvent] },
  async ({ event, step }) => {
    // ... per-repo work, each item in its own step.run ...
  },
);
```

Concrete example: `src/agent/coding/cleanup-orphan-run-branches.ts` sweeps `cogmo/run/*` refs from GitHub. Cron lists repos, fans out per-repo, per-repo handler walks `listMatchingRefs` via `octokit.paginate` and runs each `git.deleteRef` in its own `step.run` so a single 5xx doesn't redo successful deletes on retry.

### Don't return secrets through `step.run` `[confirmed]`

Inngest persists every `step.run` return value into its internal state store (necessary for replay-correctness). A step body that decrypts a secret and returns it leaks the plaintext into Inngest's database and logs.

Pattern: load secrets **outside** `step.run`. Either at function-load time (top-level await), or inline before the step that consumes them. Inside step bodies you can decrypt + use a secret freely — just don't return it.

```typescript
// ❌ leaks the PAT into Inngest state
const identity = await step.run("load-identity", () =>
  resolveGitHubIdentity(secretsStore, name));

// ✓ uses the PAT but doesn't return it
const identity = await resolveGitHubIdentity(secretsStore, name);  // outside step.run
const sessionState = await step.run("create-container", async () => {
  const session = await sandbox.create({
    worktree: { ..., auth: { username: "x-access-token", password: identity.pat } },
  });
  return session.state;  // sessionState carries no PAT
});
```

The inline DB read is itself idempotent (a secret decrypt has no side effects), so re-running it on replay is safe even though it's not checkpointed. Concrete examples in `src/agent/coding/orchestrator.ts` and `src/agent/coding/cleanup-orphan-run-branches.ts`.

## Agent Self-Scheduling `[proposed]`

One primitive — `scheduled_tasks` — covers both agent-authored reminders ("remind me to take meds at 9am every day") and user/wizard-authored recurring jobs (morning briefing, ingestion polling). Morning briefings, calendar/email polling, and "every weekday at 9am check X" are all instances of the same primitive, not special-cased Inngest cron functions.

### Why not a runtime `inngest.createFunction`

Inngest cron triggers are declared statically on `createFunction` and registered at SDK boot. There is no SDK call, REST endpoint, or `step.cron` primitive for adding/removing cron triggers at runtime; Inngest's REST API exposes run reads, not function CRUD. Open issues (`inngest/inngest` #3219, #2631) confirm cron handling is still a moving target. So dynamic schedules must live in our DB and be dispatched by a static ticker, not in Inngest's function registry.

### Pattern: DB-backed registry + 1-min ticker + fan-out

```
scheduled_tasks (
  id              UUID v7 PK,
  user_id         UUID NOT NULL FK → users,
  profile_id      UUID NOT NULL FK → profiles,
  kind            schedule_kind NOT NULL,        -- pgEnum: 'recurring' | 'one_off'
  cron            TEXT,                          -- nullable: only for kind='recurring'
  timezone        TEXT NOT NULL,                 -- IANA tz, e.g. "Europe/London"
  prompt          TEXT NOT NULL,                 -- replayed as user-role message into agent loop
  next_run_at     TIMESTAMPTZ NOT NULL,
  last_run_at     TIMESTAMPTZ,
  enabled         BOOLEAN NOT NULL,
  catchup_missed  BOOLEAN NOT NULL,              -- false = fire-latest-only, true = backfill
  source          schedule_source NOT NULL,      -- pgEnum: 'agent' | 'wizard' | 'manual'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```typescript
// Ticker: static cron, runs every minute. One per deployment.
const scheduledTaskTicker = inngest.createFunction(
  { id: "scheduled-task-ticker", triggers: [{ cron: "* * * * *" }] },
  async ({ step }) => {
    const due = await step.run("lock-due", () =>
      runInTx(async (tx) =>
        tx.execute(sql`
          SELECT id, user_id, profile_id, prompt, cron, timezone, next_run_at, kind
          FROM scheduled_tasks
          WHERE enabled AND next_run_at <= now()
          ORDER BY next_run_at
          FOR UPDATE SKIP LOCKED
          LIMIT 100
        `).then(rows => rows.map(advance)) // computes next next_run_at via croner
      )
    );
    if (due.length === 0) return { fired: 0 };
    await step.sendEvent("fan-out", due.map(t => ({
      name: "agent/scheduled-task.fire",
      data: { taskId: t.id, scheduledFor: t.next_run_at.toISOString(), prompt: t.prompt, userId: t.user_id, profileId: t.profile_id },
      id: `${t.id}:${t.next_run_at.toISOString()}`, // Inngest event idempotency key
    })));
    return { fired: due.length };
  },
);

// Fire handler: synthetic conversation turn. Re-enters the agent loop.
const scheduledTaskFire = inngest.createFunction(
  { id: "scheduled-task-fire", triggers: [{ event: "agent/scheduled-task.fire" }] },
  async ({ event, step }) => {
    // Identical shape to inbound message processing, minus transport.
    // Prompt body includes scheduledFor so the model can say "this was meant for 09:00, now 10:30".
  },
);
```

Why not pure per-row `step.sleepUntil`: it works for one-offs but is awkward for recurring tasks (each task needs a self-restarting workflow; edit/delete require cancellation tokens via `step.waitForEvent`). Why not `pg_cron`: SQL-only, can't re-enter the agent loop, requires superuser. Why not `pg_boss` / `BullMQ`: adding a second queue duplicates the durability we already get from Inngest.

The fan-out shape matches `src/agent/coding/cleanup-orphan-run-branches.ts` and the documented "Fan-out cron" pattern above — per-row failures don't block siblings, each fire gets its own retry budget and dashboard lane.

### One-off shortcut

For one-offs ≤1 year (the `step.sleepUntil` cap on Inngest's paid plan; 7d on free), the agent can skip the table:

```typescript
await inngest.send({
  name: "agent/scheduled-task.fire",
  data: { /* synthetic */ },
  ts: Date.now() + delayMs,
});
```

Inngest defers the function start to `ts`, durably, without consuming concurrency while waiting. One-offs beyond 1 year go through the table.

### Agent tool surface

```typescript
schedule_task({ cron: string, prompt: string, timezone?: string, kind?: "recurring" | "one_off", catchupMissed?: boolean }) → Result<{ id, nextRunAt }, ValidationError>
list_tasks() → Array<{ id, cron, prompt, nextRunAt, enabled }>
remove_task({ id }) → Result<void, NotFound>
```

Cron strings are validated with `croner` (zero-dep, `Intl.DateTimeFormat`-backed for IANA tz). The handler restricts to standard 5-field cron (rejecting croner's optional 6-field-with-seconds form so "minutes" stays the smallest unit) and enforces a per-user task cap (start at 50). Validation errors are structured (`unsupported_field_count` / `invalid_timezone` / `malformed` / `interval_too_short` / `no_next_occurrence`) so the LLM can self-correct from the `tool_result` — the openclaw#9283 cautionary tale shows unstructured cron errors cause infinite retry loops.

DST contract (verified empirically in `src/agent/scheduling/cron.test.ts`):
- **Spring forward**: a cron targeting a missing local hour shifts to the next valid instant. "Every day at 01:00 local" in `Europe/London` fires once at 02:00 BST on the DST-start day (= 01:00 UTC), then resumes normal cadence. Preserves "fires daily" semantics across the transition.
- **Fall back**: a cron targeting a repeated local hour fires once at the first occurrence and skips the second. "Every day at 01:00 local" fires at 01:00 BST, not again at 01:00 GMT the same day.

### Synthetic conversation turn

When a fire event lands, the orchestrator:

1. Loads the task's `user_id` + `profile_id`.
2. Builds a scoped `Service` (memory bank, files, etc.) identical to an inbound-message turn.
3. Constructs a synthetic user-role message containing the stored prompt and the scheduled-for timestamp (so the model is self-aware about catch-up: "this was meant to fire at 09:00, it's now 10:30").
4. Runs the agent loop. Output is routed through `DeliveryRouter` to `getReceiveAllSessions(userId)` — whatever channels the user has online for that profile.
5. Audit-logs `source: 'scheduled_task'`.

### Idempotency, drift, catch-up

| Concern | Approach |
|-|-|
| Idempotency | Inngest event `id = ${task_id}:${next_run_at.toISOString()}`. Advance `next_run_at` inside the same tx as the emit, so a retry produces a different key. |
| Drift | Each fire computes the next occurrence by passing the just-fired `next_run_at` to `croner.nextRun(after)` in the user's tz — anchored to the schedule, not to `now()`. |
| Catch-up on outage | Default: fire-latest-only. After downtime the ticker finds `next_run_at <= now()` and emits one event using *that* `next_run_at`. The scheduled-for timestamp goes into the prompt so the model can be self-aware. `catchup_missed: true` rows backfill every missed occurrence. |
| Multi-user from day 1 | `user_id NOT NULL`. The fire event carries `{ userId, profileId, taskId }`; `Service` is scoped to that user just like for an inbound turn. |
| Schema evolution | Append-only column policy; `next_run_at` is recomputed from `cron` on every fire, so editing the row mid-flight is safe. |

### Industry precedents

ChatGPT Tasks (Jan 2025), Hermes Agent's `cron_create`, AnythingLLM scheduled agents, and Temporal's "ambient agents" all converge on the cron-as-tool pattern with an executor that replays a stored prompt under the user's identity. The `request_heartbeat=true` pattern from Letta/MemGPT is the in-loop continuation primitive; it complements rather than replaces durable cron.

## Connection Modes `[confirmed]`

| Mode | How | Latency | Use when |
|-|-|-|-|
| **Connect (WebSocket)** | App dials out to Inngest server, persistent bidirectional | ~10-50ms/step | Self-hosted, long-running process (our case) |
| **Connect + Checkpointing** | WebSocket + local step execution, async persistence | ~2ms/step | Default for us |
| **HTTP serve** | Inngest calls your HTTP endpoints per step | 100-500ms/step | Serverless platforms |

We use Connect + Checkpointing. No inbound ports needed.

## Why Not Other Options `[confirmed]`

See `decisions.md` for the full eliminated options table. Key points:
- **BullMQ:** No durable execution, no events, no HITL. Building durability on top is a known trap.
- **Temporal:** Best durability but TS SDK requires sandboxed V8 (no normal Node.js in workflows). Heavy self-hosting (2-4GB). Overkill.
- **DBOS Transact:** Library approach (no extra service), MIT, PostgreSQL-only. But smallest community (1.1K stars vs Inngest's 5.1K). No event model. Viable fallback.
- **Restate:** Clean API, light binary, but no cron/scheduling. Would need a separate scheduler.
