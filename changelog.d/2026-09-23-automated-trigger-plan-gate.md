Automated coding tasks no longer stall after planning. A task with
`trigger_source` of `evolution` or `signal_pipeline` finished its plan run at
status `executing` without anyone emitting `coding/task/plan-approved` — the
sole trigger of `coding-task-execute`. The row claimed to be executing, no CLI
ever resumed it, and because the plan run *succeeded*, no failure reached
`coding-task-reconcile` either: the task simply sat there.

The plan phase now parks every trigger source at `awaiting_approval`, and
`coding-task-execute` is the only writer of `executing`. What differs by
trigger is who clears the approval gate: a human tapping Approve on Telegram, a
profile carrying `coding_autoapprove_mode='on'`, or — new — the plan run itself
for automated triggers, which have no interactive gate and nobody to tap it.
The last two share the existing auto-approve path: `approvePlanIfPending`
stamps `plan_approved_at` atomically against a concurrent cancel, then
`step.sendEvent` emits `coding/task/plan-approved` under its
`plan-approved-<taskId>` idempotency id. The profile lookup stays user-only, so
the automated path doesn't pay for a step boundary it can't act on.

`plan_approved_at` consequently records *when the gate cleared*, not that a
human cleared it — `trigger_source` is what distinguishes those. That was
already half-true, since per-profile auto-approve stamped it unattended.

Covered by a flow test that drives an `evolution` task from plan through
execute to `pending_verify` with no `Transport.approvePlan` call anywhere in
it, plus orchestrator tests pinning that the automated path emits exactly once
and never reads the profile's autoapprove mode.
