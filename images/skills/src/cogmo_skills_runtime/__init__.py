"""cogmo-skills-runtime — the python runtime inside cogmo-skills containers.

Two modules carry the runtime, and `abi` names the skill venvs:

- `supervisor`: long-lived parent; per task, forks a relay that runs the
  task process behind private pipes, then kills everything the task left
  and sends `task_exited`. EOF = clean shutdown.
- `runner`: per-task runner; compiles + runs the skill, emits one
  `task_result`. Task processes execute `runner._main(...)` directly.

The TS host (`src/skills/worker-sysbox/worker.ts`) spawns this package
via `python3 -u -m cogmo_skills_runtime`. See `design/skills.md` ->
"Warm pool" for the protocol contract.

Importing the package imports none of its modules. The host's populate
script runs `python3 -m cogmo_skills_runtime.abi` on every tier-2 task
with dependencies; an eager `supervisor` import here would import `abi`
first, and runpy would warn on stderr that it was already loaded.
"""
