Worker-death reconcile for the auto-repair cooldown. New Inngest
function `handle-message-reconcile` subscribed to `inngest/function.failed`
filtered to `handle-message` runs, mirroring the
`createCodingTaskReconcile` shape from PR #267. Closes the durability
gap where the worker disconnects mid-step (Inngest's connect-mode
worker-death class) before `onFailure`'s `emit-conversation-errored`
step can run — without this, a crashed run would leave `cooldown_state`
unset and the next inbound would burn LLM calls re-hitting whatever
killed the worker.

The reconcile re-emits `conversation/errored` with
`id: "errored-${runId}"` — the **same** id `onFailure` uses — so
Inngest's bus-level event-id dedup ensures `recover-conversation` runs
exactly once per failed run regardless of which path observed the
failure first. `errorClass: "WorkerDeath"` distinguishes this surface
from `onFailure`'s typical `NonRetriableError` so the evolution
failure-reflector can bucket worker-disconnect noise separately from
genuine model errors. `errorMessage` carries `run_id` and `function_id`
so a human reading the audit trail days later can trace the failure
back to its Inngest run.

Schema: `inngestFunctionFailed`'s inner-event `data` now declares
`conversationId` (optional) and `triggerInboundId` (optional, nullable)
alongside the existing `taskId` so the new reconciler reads its fields
without `passthrough` casts. Both reconcilers' field declarations are
optional — the schema accepts every triggering event shape.

`### Triggers` in `design/agent-resilience.md` bumped from `[proposed]`
to `[confirmed]`.
