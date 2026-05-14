Wire the `/schedules` Telegram command on top of the Phase 2 scheduling
primitive (#243) and agent tools (#246). Operators can now list,
disable, enable, and delete scheduled tasks from a chat — pairs with
the LLM's `schedule_task` so what the agent schedules is visible and
manageable to the user.

- `Transport.scheduling` namespace — four identity-checked methods
  (`list`, `disable`, `enable`, `delete`). Lives at the transport layer
  rather than going through `SchedulingService` because admin
  operations have no conversation context (no profileId). Ownership
  enforced inline — cross-user ids surface as `schedule_not_found`
  (same code as truly-missing) so a probing client can't enumerate
  other users' tasks.
- New `TransportError` variants: `schedule_not_found` and
  `schedule_id_malformed`. The latter fires before any DB hit when
  the supplied id isn't UUID-shaped — avoids the raw PG 22P02 the
  agent-tools PR review flagged in `remove_task`.
- `handleSchedules` Telegram command (subcommand-style:
  `/schedules` lists, `/schedules disable|enable|delete <id>`
  manages). Subcommand-style rather than top-level because `/disable`
  and `/enable` are already taken by the skills surface. List sorts
  by `nextRunAt` ASC with disabled rows sinking to the end — same
  convention as `formatTaskList` in `src/agent/scheduling/tools.ts`.
- Bot-menu entry + `setMyCommands` registration.

Test coverage: 15 transport-layer tests (mocked `AgentStore` +
`TransportStore`, covering identity check, ownership enforcement,
idempotency, UUID-shape rejection) + 13 adapter-command tests
(mocked transport, covering rendering, subcommand parsing, error
mapping, and the enabled-before-disabled sort).
