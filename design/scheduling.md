# Scheduling

## Decision: BullMQ

Scheduling lives in app code (TypeScript), modifiable by the agent itself. Self-evolution requires the agent to create/modify its own scheduled tasks — impossible with systemd timers (agent can't modify NixOS config).

| Attribute | Detail |
|-|-|
| Package | `bullmq` (npm) |
| License | MIT |
| Architecture | Library — runs in-process. Needs only Redis |
| RAM | ~120 KB per queue. Redis already running on nucleus (port 6380) |
| TypeScript | Native (BullMQ IS TypeScript) |
| Dashboard | Bull Board (separate npm package, optional) |

## Job Types

| Job | Schedule | Complexity |
|-|-|-|
| Morning briefing | Daily cron (`30 7 * * *`) | Call agent, format, send to Telegram |
| Email ingestion | Every 15-30 min | Fetch IMAP, extract facts, `retain()` |
| Calendar sync | Every 15-30 min | Fetch events, extract, `retain()` |
| Post-conversation extraction | Delayed (~5 min after last message) | Run Observer on transcript |
| Memory consolidation | Daily | `hindsight.reflect()` |
| Evolution supervisor | Daily/weekly | Review extractions, evolve prompts |
| User-created reminders | One-shot or recurring | Agent schedules via tool call |
| Retry on failure | Automatic | Exponential backoff, dead letter after N |

## Core Patterns

```typescript
import { Queue, Worker, FlowProducer } from 'bullmq';

const connection = { host: 'localhost', port: 6380 };
const queue = new Queue('assistant', { connection });

// Scheduled job (cron)
await queue.add('morning-briefing', {}, {
  repeat: { pattern: '30 7 * * *' }
});

// Retry with exponential backoff
await queue.add('ingest-email', { accountId: 'gmail' }, {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 }
});

// Delayed job (post-conversation extraction)
await queue.add('extract-memories', { conversationId: '123' }, {
  delay: 5 * 60 * 1000  // 5 minutes
});

// Worker
const worker = new Worker('assistant', async (job) => {
  switch (job.name) {
    case 'morning-briefing': return handleBriefing(job.data);
    case 'ingest-email': return handleEmailIngestion(job.data);
    case 'extract-memories': return handleExtraction(job.data);
  }
}, { connection });
```

## Human-in-the-Loop

BullMQ `waitForEvent()` pauses a workflow, consuming zero resources while waiting. Resume on Telegram callback button press.

```typescript
// In worker: pause for approval
await job.moveToWaitingChildren(token);
// ... later, on Telegram callback:
await queue.add('resume-workflow', { parentId: job.id, approved: true });
```

## Drift-Resistant Intervals (From NanoClaw)

If an interval task takes 5 minutes and is scheduled hourly, next run = `previous_scheduled_time + interval`, not `now + interval`. BullMQ's `repeat` handles this correctly with `every` (ms) or `pattern` (cron).

## Agent Self-Scheduling

The agent can create/modify/delete scheduled jobs via tool calls:

```typescript
// Tool: schedule_task
async function scheduleTask(args: { name: string; cron: string; prompt: string }) {
  await queue.add(args.name, { prompt: args.prompt }, {
    repeat: { pattern: args.cron },
    jobId: args.name,  // dedup key
  });
}

// Tool: list_scheduled_tasks
async function listTasks() {
  return queue.getRepeatableJobs();
}

// Tool: remove_scheduled_task
async function removeTask(args: { name: string }) {
  await queue.removeRepeatableByKey(args.name);
}
```

## Why Not systemd Timers

systemd timers were eliminated — the agent can't modify NixOS config, which breaks self-evolution. BullMQ from day one: the agent can create/modify/delete its own scheduled jobs via tool calls.
