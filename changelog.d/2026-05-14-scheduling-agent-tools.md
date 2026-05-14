Wire the `schedule_task` / `list_tasks` / `remove_task` agent tools on
top of the Phase 2 scheduling primitive landed in #243. The LLM can now
create, view, and cancel its own scheduled fires.

- **`SchedulingService`** (`src/agent/scheduling/scheduling-service.ts`)
  — new namespace on the per-turn `Service`. Validates input via the
  shipped `validateCron` / `computeNextRun`, enforces per-user cap
  (default 200), defaults timezone to `env.USER_TIMEZONE`, persists to
  `scheduled_tasks`. Returns `Result<T, SchedulingError>` with five
  structured error kinds so the LLM can self-correct from a single
  `tool_result` round-trip (cf. openclaw#9283).
- **Three agent tools** (`src/agent/scheduling/tools.ts`) — dumb
  adapters that parse Zod input, call the service, and format the
  result back into LLM-readable text. `schedule_task` accepts a
  discriminated-union `schedule` field (recurring vs one_off); the
  one-off variant requires an ISO-8601 timestamp with an explicit
  timezone marker so the instant is unambiguous.
- **Always-table policy for one-offs** — every schedule (recurring or
  one-off) becomes a `scheduled_tasks` row. The design doc's
  "inngest.send({ ts }) shortcut for one-offs ≤1y" is dropped from the
  agent surface and reserved for any future internal deferred-jobs use
  case. Uniform list / remove UX wins over the row-count savings.
- **Timezone default** follows the POSIX `TZ` convention cogmo already
  uses: `env.USER_TIMEZONE` (default `"UTC"`). The LLM sees this in the
  system prompt and can override per-call; matches the practice of
  systemd timers, BullMQ, and agenda for single-user server-deployed
  schedulers.
- **`Service.scheduling`** added as an optional sub-namespace, mirroring
  the `coding` and `skills` pattern. `createService` takes a new
  optional `scheduling` parameter; production wiring in `handle-message`
  always populates it.
- **Tests:** 21 PGlite-backed service tests + 25 mocked-service tool
  tests, covering: every error path, cap enforcement (including
  disabled-row counting so a graveyard can't bypass the cap),
  cross-user isolation on both list and remove (remove of another
  user's id returns `not_found` rather than leaking existence), Zod
  schema rejection of bad input.

Follow-ups in todo.md: wizard recurring-tasks step (depends on this),
`/schedules` channel command, memory consolidation cron.
