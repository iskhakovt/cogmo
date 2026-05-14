Scaffold the user/agent-defined scheduling primitive that Phase 2 anchors on.
"Morning briefing" stops being a special-cased Inngest cron and becomes one
instance of a general `scheduled_tasks` table + 1-min ticker + fire handler.

- **`scheduled_tasks` table** (`src/agent/store/schema.ts`, migration
  `0031_mighty_dagger.sql`) — two pgEnums (`schedule_kind`,
  `schedule_source`), per-value CHECK pinning the `kind ↔ cron` invariant,
  partial indexes for the ticker hot path and `/schedules` list.
- **Cron utility** (`src/agent/scheduling/cron.ts`) — `validateCron` returns
  `Result<void, CronValidationError>` with 5 structured failure kinds so the
  LLM can self-correct from malformed input; `computeNextRun(expr, tz,
  after)` for the ticker advance. Backed by [croner][1] over cron-parser:
  zero deps vs. cron-parser's Luxon dependency. DST contract pinned in
  tests: spring-forward shifts to next valid instant, fall-back fires once
  at the first occurrence.
- **Ticker** (`src/agent/scheduling/ticker.ts`) — static `* * * * *` Inngest
  cron, `FOR UPDATE SKIP LOCKED` row pickup, in-tx advance, fan-out via
  `step.sendEvent` with per-event idempotency key
  `${taskId}:${scheduledFor}`. Two catch-up modes: default fire-latest-only
  (skip ahead to first occurrence after `now()`), opt-in
  `catchup_missed=true` (advance one occurrence per tick, drains the backlog
  gradually).
- **Fire handler** (`src/agent/scheduling/fire-handler.ts`) — re-enters the
  existing inbound pipeline via a synthetic `inbound_messages` row attached
  to the user's most recently active session on the task's profile, then
  emits `inbound/arrived`. Streaming, voice mode, tool gating, and error
  handling all apply for free. Offline users (no active session) are
  logged + skipped.

New transport-store method `findActiveSessionForUserProfile` (cross-module
JOIN to `conversations`) backs fire routing. New Inngest event
`agent/scheduled-task.fire` carries `{ taskId, userId, profileId,
scheduledFor, prompt }`.

Test infrastructure: `spyOnInngestSend(client)` helper in
`src/test/factories.ts` — owns the single intentional cast against
Inngest's private `_send` so test files have no `as` at call sites.
Migrated `handle-message.replay.test.ts` to the same helper.

Follow-ups in `todo.md`: `schedule_task` / `list_tasks` / `remove_task`
agent tools, wizard recurring-tasks step, `/schedules` channel command,
memory-consolidation cron.

[1]: https://github.com/hexagon/croner
