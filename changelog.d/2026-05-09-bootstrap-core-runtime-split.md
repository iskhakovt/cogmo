Split `bootstrap()` into staged functions so non-sandbox CLIs can't reap a live `cogmo serve`'s coding-task containers. The previous bootstrap unconditionally inserted a fresh `cogmo_instances` row and called `sandbox.reconcileCrashedInstances(newInstanceId)` — and the reaper has no liveness check on other instance rows, so any container labeled with a `cogmo.instance` that wasn't *this* run's id got killed. Running `cogmo skills`, `cogmo migrate-memories`, or `cogmo backfill` while `cogmo serve` was up therefore reaped serve's running containers and crashed in-flight `claude -p` / verify runs. PR #186 papered over the migrate / backfill case with a one-off `bootstrap({ skipSandbox: true })` flag; that flag goes away here.

`src/index.ts` now exposes four staged functions:

- `bootstrapCore(opts)` — pure data layer. Migrations + uuidv7 check + skills-repo bootstrap, every store (agent / transport / sandbox / coding / mcp / skill / secrets), S3 client + bucket probe + attachment store + file service, optional client-side encryption key, tool credentials (Tavily / OpenRouter / fal), the LLM provider resolver, the boot user/profile pair, and the Hindsight memory client (with version compat check). Constructs no sandbox, registers no Inngest functions, starts no background work — safe to call concurrently with `cogmo serve`.
- `bootstrapSandbox(core)` — sandbox client + crash-instance reconciliation. Inserts the `cogmo_instances` row (local-docker backend) and runs `reconcileCrashedInstances`. Returns an all-`null` `SandboxDeps` when the configured backend is unavailable (no `SANDBOX_RUNTIME`, missing `daytona_api_key`). Only `cogmo serve` calls this stage.
- `bootstrapSkillRunner(core, sandbox)` — `SkillRunnerImpl.create` factored out so the skills CLI can reuse it without going through the runtime. Tier-2 (sysbox / Daytona) only runs when `sandbox.sandbox` is non-null; the CLI passes the all-`null` shape and accepts that tier-2 invocations throw at call time. Tier-1 (Pyodide) and every admin subcommand (`list` / `register` / `approve` / `deny` / `rollback` / `deregister`) work from the CLI as before.
- `bootstrapRuntime(core, sandbox, skillRunner, opts)` — agent runtime. Tools, prompt source, MCP registry start, channel adapters, voice provider, debounce / idle / observer / coding orchestrator, sandbox reaper Inngest function. Every Inngest registration that needs to live across turns ends up in this stage's returned `functions` array. Only `cogmo serve` calls this.

`bootstrap()` stays as a thin aggregate that wires all four stages together; serve and the integration test harness (`src/test/pipeline.integration.test.ts`, `src/skills/cli.integration.test.ts`'s seed subprocess) call it unchanged.

`src/main.ts` updated:

- `serve` — unchanged (`bootstrap()`).
- `skills` — `bootstrapCore() + bootstrapSkillRunner(core, NO_SANDBOX)`.
- `migrate-memories` / `backfill` — `bootstrapCore()` only.

`BootstrapOptions.skipSandbox` removed. The `// skipSandbox: true so the reaper …` workaround comment in main.ts goes away — the new dispatch is the proper fix the comment promised.
