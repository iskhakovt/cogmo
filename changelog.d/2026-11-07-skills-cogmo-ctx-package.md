Skills get one `cogmo_ctx` package on both tiers (design/skills.md → Contracts).

- `from cogmo_ctx import Ctx, CtxError, SkillError` works in every skill. The skills image installs the package, and the wasm child writes the same file into Pyodide ahead of the skill's wheels. On the wasm tier `CtxError` stays a global for skills that name it without importing it.
- `SkillError(kind, message, retryable=False)` is a skill's expected failure. It finishes the run as `skill_failed`, or as `skill_retryable` with `retryable=True`, with `kind: message` as the error. Neither counts as a defect.
- `ctx.run()` returns `{ id, key }`: the run id, and the invocation's logical key (the tool call's or cron fire's idempotency key, else the run id), for a skill to send as `Idempotency-Key` on an external write. `task_invoke` carries it as `run`.
- `SUPERVISOR_PROTOCOL_VERSION` is 5, so the container tier needs the `cogmo-skills` image of this release.
