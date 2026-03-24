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
  { id: "handle-message", triggers: [{ event: "message/received" }] },
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

## Agent Self-Scheduling `[proposed]`

The agent can create scheduled tasks by sending events that trigger Inngest functions, or by using the Inngest REST API to create new function triggers.

```typescript
// Tool: schedule_task — agent sends an event that creates a cron function
async function scheduleTask(args: { name: string; cron: string; prompt: string }) {
  await inngest.send({
    name: "task/scheduled",
    data: { name: args.name, cron: args.cron, prompt: args.prompt },
  });
}
```

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
