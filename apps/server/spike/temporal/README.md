# Spike: Temporal with a declarative flow layer

Throwaway. It answers whether cogmo could leave Inngest for Temporal while
keeping Inngest-style function config, and what that would cost.

## What is here

- `flow/`: a 450-line declarative layer. `defineFunction({ trigger,
  concurrency, debounce, cancelOn, idempotency })` compiles to:
  - a **lane workflow** per concurrency key, which runs jobs as child
    workflows in arrival order, at most `limit` at once, and finishes when
    its queue is empty;
  - a **debounce workflow** per key, which fires with the burst's last
    event;
  - a **dispatcher**, the event bus Temporal lacks. Every workflow id it
    starts or signals derives from the event's id or a data key, so
    redelivery and retried fan-out are idempotent.
- `functions/`: `scheduled-task-fire` ported for real. Its use case,
  `dispatchScheduledFire`, runs unchanged as an activity. Stand-ins for
  `handle-message`, `stage-runner` (which shares the conversation lane) and
  `idle-timer` are also here.
- `flow.spike.test.ts`: 10 tests against the Temporal CLI dev server.
- `bench.spike.test.ts` and `inngest-bench.spike.test.ts`: the same three
  latency paths, on Temporal and on Inngest.

```sh
cd apps/server
pnpm exec vitest run --config spike/temporal/vitest.config.ts   # tests
BENCH=1 TEMPORAL_ADDRESS=host:7233 pnpm exec vitest run --config spike/temporal/vitest.config.ts bench
```

## Findings

### Runtime

- **Node 26 works.** The SDK's native bridge (`@temporalio/core-bridge`
  1.25.0) loads, and every test passes on Node 26.13.1. Temporal's
  official support list is 20, 22 and 24, so 26 is unsupported but
  working.
- **Workflow bundling takes the repo's TypeScript as-is**: NodeNext `.js`
  specifiers and `import type` from `src/`. Code imported at runtime into
  a workflow must be sandbox-safe. `@temporalio/common` is; `node:crypto`,
  pino and the stores are not.

### Flow layer

Each test fails when its mechanism is removed. That was checked by running
each mutation:

| Test | Mutation | Result |
|-|-|-|
| Turn and stage serialize on one conversation, in arrival order | lane limit 2 | red |
| Different conversations run in parallel | — | — |
| Burst collapses into one turn, with the last inbound | no debounce | red |
| Steady stream fires at the ceiling and loses no arrival | — | — |
| Redelivered event runs once | no job dedup | red |
| Idle timer is cancelled by the next inbound | no `cancelOn` | red |
| Failed job is reported and the lane moves on | — | — |
| Real `dispatchScheduledFire`, retried after commit, reuses its row | use case's retry guard removed | red |
| No job is lost while a lane finishes | drain guard removed | **green** |

The drain guard is a no-op while signal handlers are synchronous. What
keeps a job from being lost is the server refusing a completion that races
an unprocessed signal. The test exercises lanes finishing and restarting
between jobs (several runs per lane), but it cannot force the exact
window.

Semantics that differ from Inngest:

- **Debounce works at any granularity.** The tests use 300 ms; Inngest's
  minimum is 1 s. So cogmo's sub-second fallback, and its race, go away.
- **Lanes are FIFO.** Inngest doesn't promise order within a key.
- **A `cancelOn` function has one run per match value**, and a new trigger
  restarts it. Inngest would queue the second run behind the first. Every
  current `cancelOn` user (idle timer, debounce timers, gate waiter) is
  one-per-key already.
- **The idempotency window is the namespace's retention period**, instead
  of Inngest's 24 hours.

### Porting

- **`scheduled-task-fire` is mechanical.** The use case file is untouched.
  The controller becomes a 29-line workflow plus a 3-line activity factory
  that closes over the same deps. `retries: 2` becomes the activity's
  `maximumAttempts: 3`.
- **Inventory of all 179 non-test step call sites:**
  - **A, mechanical (91):** worker deps plus serializable inputs.
  - **B, per-run state rebuilt inside the activity (50):** a logger, the
    provider, the scoped `Service`, the delivery handle, the live tool
    catalog. Each can be rebuilt from ids plus DB reads.
  - **C, engine-semantics (38):** 31 event emits relying on bus dedup or
    triggers, which the dispatcher above covers; 6 cancellable sleeps and
    waits; and `llm-iter`.
- **The hard part is the agent loop, not the step bodies.**
  - `llm-iter<N>` holds the open transcript, its head-hash chain, the
    budgets and the stream handle across iterations.
  - The function bodies also do I/O outside any step on every invocation:
    `renderTurnView`, `getProfile` (`freeze-turn-inputs.ts:91`),
    `deliveryRouter.prepare`, the live tool catalog. Workflow code can't do
    any of that.
  - So each iteration has to become an activity that re-renders its request
    from the DB, with the DB as the turn's state keyed by
    (turn, iteration). The alternative, carrying the messages in workflow
    history, breaks on base64 attachments under the 2 MB payload limit.
  - Compaction probably collapses into one activity.
  - Several crash-recovery contracts are Inngest-specific and would be
    redesigned rather than ported: sorted-key step results, `step-not-found`
    across deploys, parallel-group continuations, and `onFailure` on worker
    death. They're listed in design/crash-recovery.md and
    .agents/rules/inngest.md.

### Latency

p50 across seven runs, from a worker on the same host. The work is zero-length, so the
numbers are pure plumbing:

| Path | Temporal 1.32.2 + Postgres 18 | Inngest 1.52.0 `start` + Postgres 18 + Redis |
|-|-|-|
| Emit → the turn's first step | 64–99 ms | 300 ms |
| Next queued turn on the same key | 125–200 ms | 145 ms |
| Debounce overhead beyond its period | 800 ms (300 ms period) | 1,550 ms (1 s period) |

Sequential zero-length steps inside one run, p50 / p95:

| | ms per step |
|-|-|
| Inngest `step.run` (connect, checkpointing) | 2.6 / 10.5 |
| Temporal activity | 15 / 32 |
| Temporal local activity | 0.8 / 1.0 |

- **Cross-workflow hops cost about 50 ms each.** A child workflow
  starting, a child's completion reaching its parent, and a signal-driven
  workflow task each wait about 50 ms between scheduled and started. That
  is the gap in the hand-off and debounce rows above.
- **Worker poller settings don't change it.** Tried: sticky cache off,
  poll ratio 1, autoscaling pollers.
- **Back-to-back activities in one run cost about 15 ms each, and local
  activities under 1 ms.** A 15-step turn spends about 40 ms on Inngest,
  about 225 ms on Temporal activities, or about 15 ms with its short reads
  as local activities.

### Footprint

`docker stats` right after the latency bench:

| | Server | Its Postgres | Redis |
|-|-|-|-|
| Temporal 1.32.2 | 119 MiB (66 idle) | 174 MiB (150 idle) | — |
| Inngest 1.52.0 | 122 MiB (34 idle) | 61 MiB (36 idle) | 11 MiB |

The 2–4 GB figure in design/decisions.md's Temporal row is wrong at this
scale. A single-user Temporal is about the same size as Inngest, and it
needs no Redis.

## What it means

- **design/decisions.md is out of date on Temporal.** Its footprint is
  small, the TS SDK ships monthly, and the sandbox accepts the repo's code.
  The real objection stands: the workflow/activity split.
- **The declarative layer is cheap**, about 450 lines, and is better than
  Inngest on debounce and ordering.
- **The cost of moving is the turn pipeline.** Roughly half the call sites
  port mechanically. The rest need their per-run state rebuilt inside
  activities, and `handle-message`'s loop needs its own design (DB as the
  turn's state per iteration) before any code.
