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
- **`durable: true` buys replay-safety, not exactly-once.** A crash after
  the side effect commits but before Inngest records the step result
  leaves no evidence the step ran, so the retry re-runs it — and no
  transaction spans Postgres and Inngest's state store. A non-idempotent
  side effect inside a step therefore needs a caller-supplied idempotency
  key on top. Three constraints on it:
  - **Derive it from durable state** — the step id's own inputs (turn
    token, iteration, position). Never from what the model mints, a clock,
    or a fresh uuid in the bare body.
  - **Key the request, not the slot.** Include a canonical digest of the
    call's name and arguments: a re-delivery replays with an empty step
    cache, the model re-decides, and a different call can land at the same
    coordinates — which a coordinates-only key reads as a retry.
  - **A recovery resumes the remaining phases; it does not assume the
    request finished.** The first attempt may have died between two side
    effects, so returning early on "the row already exists" trades a
    duplicate for a permanent stall. Track a recovery point, or make the
    later phases independently idempotent.

  Store under a plain `UNIQUE` and write through `ON CONFLICT DO UPDATE`
  with a no-op SET — not `DO NOTHING`. Under REPEATABLE READ a concurrent
  loser cannot see a row committed after its snapshot: `DO NOTHING` skips
  the tuple and the re-select finds nothing, failing deterministically with
  nothing to retry, while `DO UPDATE` must write it and so raises `40001`,
  which the transactor retries against a snapshot that does contain the
  winner. `RETURNING … (xmax = 0)` separates insert from conflict-update.
  Nulls-distinct leaves callers without retry semantics unaffected.
  Reference: `coding_tasks.idempotency_key` + `insertOrRecoverTask`,
  `scheduled_tasks.idempotency_key` + `createOrRecoverScheduledTask`.
  (`SkillStore.startOrRecoverRun` predates this and still uses the
  `DO NOTHING` shape — tracked in `todo.md`.)
- **A step boundary abandons the function; it does not unwind it.** An
  unexecuted step hands the body a promise the SDK never settles, so the
  invocation ends with the async function pending mid-`await`. `finally`
  and `catch` do NOT fire on a boundary — only on real completion. Cleanup
  in a `finally` runs once, at the end of the run, which is what makes
  "create a container in step 2, use it in step 7" safe. Don't "fix" a
  `finally` that looks like it would tear down mid-run, and don't move
  cleanup into a step to defend against a boundary that never reaches it.
- **Bare-body wall-clocks and metrics are per-invocation.** `Date.now()`
  captured at the top of the function restarts on every boundary — a
  "duration" computed from it in a late step measures the final replay,
  not the run. Record timings and counters inside steps, or derive them
  from step-stored timestamps.

See `design/crash-recovery.md` for the worked contract on `handle-message`
(durability map, durable LLM iterations, tool durability policy, test
recipes) — new orchestrator functions should follow the same shape and add
replay tests via `@inngest/test`'s `steps:` mechanism.
