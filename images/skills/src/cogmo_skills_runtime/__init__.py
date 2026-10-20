"""cogmo-skills-runtime — the python runtime inside cogmo-skills containers.

Two modules carry the runtime:

- `supervisor`: long-lived parent; per task, forks a relay that runs the
  task process behind private pipes, then kills everything the task left
  and sends `task_exited`. EOF = clean shutdown.
- `runner`: per-task runner; compiles + runs the skill, emits one
  `task_result`. Task processes execute `runner._main(...)` directly.

The TS host (`src/skills/worker-sysbox/worker.ts`) spawns this package
via `python3 -u -m cogmo_skills_runtime`. See `design/skills.md` ->
"Warm pool" for the protocol contract. Its shell scripts run
`python3 -m cogmo_skills_runtime.abi` for the venv ABI tag on every
tier-2 task with dependencies, which is why importing the package
imports none of its modules.
"""
