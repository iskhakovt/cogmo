Skill execution exactly-once via DB-level idempotency keys + recovery_point state machine.

The previous shape (`step.run("dispatch", () => runner.invoke(...))` in cron-fire-handler) gave at-least-once execution: a persist-time DB blip retried the whole step → re-ran the skill body → double side effects (ctx.memory.write, ctx.files.write, outbound HTTP). At single-user scale the failure mode was rare and bounded by `retries: 2`, but the underlying contract was wrong: framework-level step boundaries can't fix a database-level durability gap.

Industry research before committing: Temporal recommends "make activities idempotent" with idempotency keys; Brandur Leach's [Stripe-like Idempotency Keys in Postgres](https://brandur.org/idempotency-keys) is the rigorous form (atomic phases + recovery_point); [Exactly-Once Project's side-effects post](https://exactly-once.github.io/posts/side-effects/) argues "visible is not the same as created" — record metadata transactionally, execute, then publish. Inngest's own docs explicitly say "external systems need idempotency too." The consensus is overwhelming: DB-level beats framework-level. PR #303 review thread captures the analysis.

Adopted pattern: Brandur's recovery_point. Three new pieces:

- `skill_runs.idempotency_key TEXT` — plain `UNIQUE(idempotency_key)` constraint. Postgres treats nulls as not-equal in unique constraints by default, so multiple null-key rows (CLI / tests) coexist while non-null keys collide. Chosen over a partial unique index — identical semantics, smaller `ON CONFLICT` surface area, no `WHERE` predicate dance.
- `skill_runs.recovery_point` (new `skill_run_recovery_point` pgEnum: `'started' | 'executed' | 'finished'`) — Stripe-pattern phase marker. Inserted in `'started'`; transitions atomically to `'executed'` (with output/error/rusage/finished_at) after the worker returns; to `'finished'` (with status) after output validation.
- Migration `0043_skill_runs_idempotency_key.sql` — schema additions + a backfill UPDATE that flips pre-existing terminal rows (finished_at IS NOT NULL) to `recovery_point='finished'`. Idempotent; guarded against re-application.

Store: three new methods on `SkillStore`:

- `startOrRecoverRun(tx, {skillId, trigger, inputs, idempotencyKey}) → {kind: 'new' | 'recovered', row}` — `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`; on zero rows, `SELECT ... FOR UPDATE` the existing row so concurrent retries serialise.
- `transitionToExecuted(tx, {id, output, error, resourceUsage, finishedAt})` — atomic phase advance writing the execute payload.
- `transitionToFinished(tx, {id, status, output, error})` — atomic phase advance writing the terminal status.

Runner: `runner.invoke` accepts `opts.idempotencyKey?: string`. When provided, branches on the recovered row's `recovery_point`:

- `kind: 'new'` → standard flow.
- `kind: 'recovered'` + `'finished'` → reconstruct `SkillRunResult` from the row and return without touching the runtime. Bypass is logged at info level.
- `kind: 'recovered'` + `'executed'` → skip execute, replay output validation (pure / deterministic), transition to `'finished'`. Persist-failure retries land here.
- `kind: 'recovered'` + `'started'` → throw new `SkillInflightCrashedError` (carries the orphan runId). Conservative default — re-executing could double-fire non-idempotent side effects. Manifest opt-in via future `idempotent_invocation: true` would let the runner re-execute optimistically.

`#dispatchToRuntime` extracted from `invoke` so the execute branch stays readable (tier-1/tier-2 fan-out lives outside the recovery-branch logic).

Cron-fire handler: passes `idempotencyKey: skill-cron:${skillId}:${scheduledFor}` — same shape as the event-bus dedup id, so a retry that crosses the bus-dedup window still resolves to the same run row. The `dispatchResult` discriminated union gains a new `'inflight_crashed'` skipped-reason for the `SkillInflightCrashedError` catch. All four typed-error skipped reasons (`skill_not_found`, `skill_disabled`, `invalid_inputs`, `sandbox_unavailable`, `inflight_crashed`) are non-retrying.

Agent-loop tool dispatch: deferred. The `buildSkillToolSpec` handler signature `(input, service) → Promise<string>` doesn't carry the `toolUseId`/`conversationId` needed to construct a deterministic key. Tracked in `todo.md` under *Skills, voice & transport*. Until threaded, agent-loop-invoked skills retain the at-least-once contract; handle-message retries can replay tool handlers and re-execute skills.

Test coverage: 6 new store-tier tests (startOrRecoverRun new/recovered, transitionToExecuted/Finished, partial-unique null-key allowance, explicit idempotencyKey stamping), 4 new runner-tier tests (first call finishes the row, second call returns cached terminal without re-executing, executed-phase replay seeds a sentinel output to prove no re-execution, started-phase replay throws `SkillInflightCrashedError`), 1 updated cron-fire-handler assertion (verifies the idempotency-key shape). Full skill tier passes (596 tests).
