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

That decision is an exhaustive `match` over `coding_trigger_source`, so a
future member is a compile error rather than a silent default into the ungated
arm — which would hand it an unattended `--permission-mode bypassPermissions`
session. The profile lookup runs only for `trigger_source = 'user'`: an
automated task has no conversation to join through, and skipping it keeps that
step boundary off the automated path.

Clearing the gate means two things — `approvePlanIfPending` stamps
`plan_approved_at` atomically against a concurrent cancel, then the event goes
out under the `plan-approved-<taskId>` idempotency id. Both callers that do it,
the plan orchestrator and `Transport.coding.approvePlan` behind the Telegram
tap, decide what to emit through `planGateEmission`
(`src/agent/coding/plan-gate.ts`), so the rule below holds for both.

**A stamp that is already there still owes an emit.** `already_approved` means
an earlier attempt committed the stamp and lost its follow-through: a step
result Inngest never recorded, or a `send` that threw after the transaction
committed. Since the emit is the only trigger of the execute orchestrator and
neither caller fails in that state, withholding it leaves a task holding a
plan, a stamp and no execute run, with nothing to reconcile it. So it emits,
carrying the row's stored timestamp rather than the caller's fresh one, and a
second Approve tap recovers a send that failed the first time. Duplicates are
free: the bus dedups on the idempotency id, and past that window the execute
claim is conditional on `awaiting_approval`, so a second run finds the first
one's `executing` and stands down. `not_pending` and `not_found` owe nothing —
the task was cancelled, moved on under another run, or is gone.

`plan_approved_at` records when the gate cleared, not that a human cleared it.
`trigger_source` and the profile's mode are what say who did.

`plan_finalized.autoApproved` is true on both in-run paths, so the
approve/revise/cancel keyboard is suppressed whenever the buttons would be
misleading.

A flow test drives an `evolution` task from plan through execute to
`pending_verify` with no `Transport.approvePlan` call in it. Orchestrator tests
pin that the automated path emits exactly once, carries the right idempotency
id, never reads the profile's autoapprove mode, and re-emits with the stored
timestamp when the approve step body re-runs against an already-stamped row;
transport tests pin the same recovery behind a second tap. The `autoApproved`
flag is asserted on all three paths, so inverting it fails a test rather than
silently rendering buttons nobody can use.

Deferred, filed as `p2` in `todo.md`: plan and execute key their askpass
material on the same `${askpassBaseDir}/<taskId>` directory, which is also the
container's bind-mount source, so the plan run's `finally` cleanup races
execute's `provision-askpass` whenever the gate clears in-run. Reachable only
on `workingTreeTransport === 'git-remote'`.
