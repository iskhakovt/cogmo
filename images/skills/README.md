# cogmo-skills-runtime

Python runtime that ships inside `ghcr.io/iskhakovt/cogmo-skills:<version>`.
Owns the supervisor + runner for tier-2 skills — see `design/skills.md`.

## Layout

- `src/cogmo_skills_runtime/supervisor.py` — long-lived parent. Per
  task it forks a relay, which forks the task process behind private
  stdin/stdout pipes, relays that task's frames to and from the host
  and enforces the wall clock. Once the relay exits, the supervisor
  kills and reaps every process the task left and sends `task_exited`.
  EOF on stdin = clean shutdown.
- `src/cogmo_skills_runtime/runner.py` — per-task runner. Compiles the
  skill body, runs `async def run(inputs, ctx)`, services `ctx.*`
  RPCs over its stdin/stdout, emits one `task_result`.
- `src/cogmo_skills_runtime/__main__.py` — entry point. The TS worker
  spawns this via `python3 -u -m cogmo_skills_runtime`.
- `tests/` — pytest suite; `test_task_isolation.py` runs the supervisor
  as a subprocess and speaks the host protocol to it.

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

The supervisor announces `PROTOCOL_VERSION` on startup and the host
refuses any other (`SUPERVISOR_PROTOCOL_VERSION` in
`apps/server/src/skills/protocol.ts`), so an image speaking another
protocol version fails at worker creation. Bump both together on a
protocol change.
