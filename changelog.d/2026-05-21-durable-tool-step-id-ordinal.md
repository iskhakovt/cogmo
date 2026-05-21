Durable per-tool `step.run` ids are now keyed on `(iteration counter,
position within iteration)` instead of the LLM-minted `tool_use_id`.
The streaming LLM call is non-durable — Inngest replays the function
from the top, the provider is called fresh on every attempt, and each
call mints a new `tool_use_id`. The old `tool-<name>-<tool_use_id>` id
scheme therefore produced a different step hash on every replay; the
planner pinned the first attempt's hash, couldn't find a matching step
on retry, and failed the run with `Could not find step <hash> to run;
timed out`. The user saw a stalled turn followed by a silent
60-second cooldown lockout, and the conversation was left without a
reply.

The new id `tool-iter<N>-<P>` is stable across attempts because both
indices are deterministic during a replay: the agent-loop iteration
counter increments by one per turn, and the model returns `tool_use`
blocks in a fixed order within a single response. A cached step from
attempt 0 now replays cleanly on attempt 1 even if the model picks a
slightly different ordering — the cached result may not match the
current `tool_use` semantically, but the step graph stays in sync and
the function completes.

Replay-determinism regression test in `src/agent/loop.test.ts`
simulates two attempts where the provider mints distinct
`tool_use_id`s and asserts the durable step ids are identical across
attempts; a wire-level test in `src/agent/handle-message.replay.test.ts`
exercises Inngest's `@inngest/test` step cache directly. A second
unit test pins the documented "cache hit returns semantically-wrong
content" trade-off so a future change that silently restores
LLM-driven step ids surfaces as a test failure.
`design/crash-recovery.md` updated to drop the prior (false)
"`tool_use_id` is stable across retries" invariant and to explain why
wrapping `provider.chat` in `step.run` is not the right alternative
for the streaming path.

**Observability note.** Inngest step logs previously surfaced the
tool name in the step id (`tool-write_file-<id>`); `grep` over step
ids by tool name no longer works. The tool name is still attached as
`cogmo.tool.name` on the `tool.execute` OTEL span, so off-band
debuggability is preserved through the trace backend.

**Rollout note.** Any Inngest runs that are paused or mid-retry
across the deploy carry old-format step ids in their state. Those
ids will not match the new format on the next attempt, so the cached
durable step is effectively dropped and the tool re-executes on
resume. For `generate_image` this may bill twice for the affected
turn; for `web_answer` the only cost is one extra Perplexity Sonar
call. Single-user scale makes the window small and the impact
benign — strictly better than the failure mode this fix removes.

