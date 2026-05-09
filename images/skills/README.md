# cogmo-skills-runtime

Python runtime that ships inside `ghcr.io/iskhakovt/cogmo-skills:<version>`.
Owns the supervisor + runner for tier-2 skills — see `design/skills.md`.

## Layout

- `src/cogmo_skills_runtime/supervisor.py` — long-lived parent. Reads
  `task_invoke` lines from stdin, forks a child per task, supervises
  wall-clock via `os.pidfd_open` + `selectors.select`, SIGKILLs on
  timeout. EOF on stdin = clean shutdown.
- `src/cogmo_skills_runtime/runner.py` — per-task runner. Compiles the
  skill body, runs `async def run(inputs, ctx)`, services `ctx.*`
  RPCs over stdin/stdout, emits one `task_result`.
- `src/cogmo_skills_runtime/__main__.py` — entry point. The TS worker
  spawns this via `python3 -u -m cogmo_skills_runtime`.
- `tests/` — pytest suite for both modules.

## Dev workflow

```sh
cd images/skills
uv sync
uv run ruff check
uv run pyrefly check
uv run pytest
```

## Production

Built into `ghcr.io/iskhakovt/cogmo-skills:<version>` by
`docker-bake.hcl`'s `skills` target. The image ships the package's
`.venv` at `/opt/cogmo-skills/.venv` and adds it to `PATH`; `python3
-m cogmo_skills_runtime` resolves to the runtime entry point.
