**Every trigger source parks its plan at `awaiting_approval`, and the plan
orchestrator clears the gate itself whenever no human holds it.**
`coding-task-execute` is the only writer of `executing`, and
`coding/task/plan-approved` is the only thing that triggers it.

Who clears the gate follows from the trigger:

- `user` with `coding_autoapprove_mode='off'` — the human, tapping Approve on
  Telegram. That arrives as its own Inngest run, so the task can park for days
  at no cost.
- `user` with `coding_autoapprove_mode='on'` — the plan run.
- `evolution` / `signal_pipeline` — the plan run. These triggers have no
  conversation to render a keyboard into and nobody to tap it; the PR merge is
  their human checkpoint. An automated task that finished planning without the
  emit would hold a row claiming to execute with no CLI behind it, and since
  the plan run itself succeeds, nothing would reach `coding-task-reconcile`.

Both in-run paths share one code path: `approvePlanIfPending` stamps
`plan_approved_at` atomically against a concurrent cancel, then
`step.sendEvent` emits under the `plan-approved-<taskId>` idempotency id. The
profile lookup runs only for `trigger_source = 'user'` — an automated task has
no conversation to join through, and skipping it keeps that step boundary off
the automated path. `plan_finalized.autoApproved` covers both paths, so the
approve/revise/cancel keyboard is suppressed for either.

`plan_approved_at` records when the gate cleared, not that a human cleared it.
`trigger_source` and the profile's mode are what say who did.

A flow test drives an `evolution` task from plan through execute to
`pending_verify` with no `Transport.approvePlan` call in it; orchestrator tests
pin that the automated path emits exactly once, carries the right idempotency
id, and never reads the profile's autoapprove mode.

Deferred, filed as `p2` in `todo.md`: plan and execute key their askpass
material on the same `${askpassBaseDir}/<taskId>` directory, which is also the
container's bind-mount source, so the plan run's `finally` cleanup races
execute's `provision-askpass` whenever the gate clears in-run. Reachable only
on `workingTreeTransport === 'git-remote'`.
