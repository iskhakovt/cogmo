"""cogmo-skills-runtime — the python runtime inside cogmo-skills containers.

Two modules carry the runtime:

- `supervisor`: long-lived parent; reads `task_invoke` from stdin,
  forks a child per task, kills on wall-clock, EOF = clean shutdown.
- `runner`: per-task runner; compiles + runs the skill, emits one
  `task_result`. Forked children execute `runner._main(...)` directly.

The TS host (`src/skills/worker-sysbox/worker.ts`) spawns this package
via `python3 -u -m cogmo_skills_runtime`. See `design/skills.md` ->
"Warm pool" for the protocol contract.
"""

from cogmo_skills_runtime import runner, supervisor

__all__ = ["runner", "supervisor"]
