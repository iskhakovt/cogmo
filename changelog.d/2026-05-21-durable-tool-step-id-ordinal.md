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
attempts. `design/crash-recovery.md` updated to drop the prior (false)
"`tool_use_id` is stable across retries" invariant.
