Expected failures in `skills/` are tagged values, and four bugs are fixed.

- **Results.**
  - `runner.invoke` returns `Result<SkillRunResult, SkillInvokeRejection>`: `not_found | disabled | invalid_inputs | sandbox_unavailable | inflight`. It replaces five `Error` subclasses.
  - `CtxHandler.handle` returns a tagged `CtxFailure` and writes its audit row once.
  - Git reads, the PyPI lookup and schema compilation return `Result`s.
  - `readSkillSource` reads and parses a committed skill in one place and errs with `commit_not_found`, `missing_file` or `invalid_manifest`.
- **Tier-1 ctx errors reach the skill as `CtxError`.** A refused ctx call arrived in Pyodide as a `JsException`, so `except CtxError` caught nothing, and a null result arrived as `jsnull`. The worker bridge resolves a tagged reply, and `ctx.py` raises `CtxError(kind, message)` and maps null to `None`.
- **No stuck `started` row when the warm pool can't run a task.** A pool that failed to start, or had no worker to give, threw after the run row was written, so every keyed retry skipped the run as `inflight`. The pool starts before the row write, and a pool that can't supply a worker returns `ok: false`, which finishes the run as an error. A key that already has a row replays, finalizes or refuses from that row without starting the pool.
- **A run row whose commit is missing from the repo** reports `no source … repo and DB are out of sync` again, instead of a raw git error.
