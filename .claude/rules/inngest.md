# Inngest: replays are normal, not exceptional

Inngest re-invokes the whole function body at **every step boundary**, on
success. It is not a coroutine and it does not resume — `step.run` results
come back from the state store, everything else re-executes from the top.
SDK v4 checkpointing often collapses sequential steps into one request, but
it is an optimization with documented fallbacks (parallel steps, step
retries, lease migration, connect-mode `maxRuntime` of 300s), **not the
contract**. Design every function for the per-boundary model.

- **Count your replays.** A function with N `step.run` calls executes its
  bare body up to N+1 times on a clean run. Before adding a step — or
  leaving work outside one — state what re-runs because of it and what that
  costs. "It only happens on retry" is the framing error that shipped a
  turn re-billing the model once per durable tool call.
- **Anything expensive, billable, or non-deterministic goes in a step.**
  LLM calls are all three. A model call in the bare body is re-billed once
  per downstream step boundary and returns different output each time.
- **Side effects inside `step.run` fire live and are suppressed on
  replay.** Only the *return value* must be JSON-serializable — the body
  may stream tokens to a transport, push status banners, or run for
  minutes. "You can't stream out of a step" confuses returning a stream
  (impossible) with emitting from the body (normal, and the suppression on
  replay is usually exactly what you want).
- **Non-determinism upstream of a step breaks memoization.** If a replay
  produces a different number, order, or set of steps than the first pass,
  the executor asks for steps the SDK never creates and the run dies with
  `Could not find step … timed out` — surfacing as a stalled turn plus a
  silent cooldown, not an obvious error. Conditional steps must gate on
  durable state (a step result or the event payload), never on `new Date()`
  comparisons or LLM output. A gate on a non-durable DB read is acceptable
  only as a documented residual when the flip window is a concurrent
  operator action (see `summarize-prefix` / `auto-recall` in
  design/crash-recovery.md) — never for state the run itself mutates.
- **Never gate the bare body on state your own steps mutate.** A guard like
  `if (task.status !== "pending") return "skipped"` above a step that sets
  `status = "running"` self-destructs on the next boundary: the re-invoked
  body reads the mutated status and skips the rest of the run. Re-entry
  guards belong *inside* a durable step (conditional UPDATE returning
  whether the transition happened), with the bare body branching on the
  memoized result. Put that step where a lost race returns *before* the
  function's failure/teardown machinery — otherwise a duplicate event
  that trips any error on the way in (a rotated secret, an unreachable
  dependency) marks an already-terminal row `failed`.
- **The continuation after a parallel step group runs only in
  fully-memoized invocations.** When a `Promise.all` plans two or more
  steps, Inngest executes each body in a targeted request that runs ONLY
  that body (and `disableImmediateExecution` then pins the whole run to
  this pattern, single steps included). Code after the `Promise.all`
  executes in a later invocation where every step replays from cache — so
  never infer "already done / already emitted" there from whether a step
  body ran in the current invocation; that signal is always false. A side
  effect that must follow the group goes in its own step.
- **Deriving step ids from model output is a bug.** `tool_use_id` and
  anything else the LLM mints changes when a step body re-runs. Key on
  SDK-local state (iteration counter, array position, ids from a memoized
  step's result).
- **Don't catch around `step.run` indiscriminately.** A permanently-failed
  step re-throws its cached error in the body (`StepError`); a broad
  `try/catch` that converts it to a normal control-flow value silently
  swallows the failure. Catch inside the step body, or catch specific
  expected error types. Carve-out: a broad catch is correct when the
  conversion target IS the designed failure channel for everything the
  step can throw — `compactMessages` degrading a failed summarization to
  truncation, the agent loop converting a failed tool step to an
  `is_error` tool_result. Rethrowing a `StepError` out of the function is
  also special: never wrap it — the engine's non-retriable detection
  needs its identity and serialized name intact.
- **`ToolSpec.durable` policy: side-effectful or billable ⇒ durable.** A
  non-durable tool handler re-executes once per remaining step boundary of
  the turn — a DB-writing tool inserts duplicates, a paid API re-bills.
  Only cheap idempotent reads whose output may be large (`read_file`,
  `list_*`) stay non-durable; accept that their persisted `tool_result` is
  whatever the last invocation returned. Justify both sides of the flag in
  the PR.
- **Bare-body wall-clocks and metrics are per-invocation.** `Date.now()`
  captured at the top of the function restarts on every boundary — a
  "duration" computed from it in a late step measures the final replay,
  not the run. Record timings and counters inside steps, or derive them
  from step-stored timestamps.

See `design/crash-recovery.md` for the worked contract on `handle-message`
(durability map, durable LLM iterations, tool durability policy, test
recipes) — new orchestrator functions should follow the same shape and add
replay tests via `@inngest/test`'s `steps:` mechanism.
