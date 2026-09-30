The skills runner's resources now end with their callers.

- **Warm pool at shutdown.** `cogmo serve` disposes the tier-2 warm pool on exit, as its own bounded step after MCP and before the sandbox, so its containers no longer outlive the process.
- **Cancelling `register`.** `SkillRunner.register` takes an `AbortSignal`, checked at its start and just before the deploy transaction; the lockfile compile honours it throughout, ending a wait for the image, starting no session, and disposing a running exec before deleting its session. An abort seen by then stops the deploy, and `register` rejects with the signal's reason, leaving `main` and the branch untouched. These are checks, not a wall-clock cap: work that takes no signal, such as the Pyodide check's PyPI lookups, runs to its end first. Once the transaction has started, an abort only kills the mirror push, and the result stands. A skill-repo coding task's auto-register passes a 300 s deadline, so a register still running at it stops at its next check instead of putting the skill live after the step has failed.
- **Mirror push.** The push that mirrors `main` to the skills remote after a register, approval or rollback gives up after 60 s, or when the caller's signal aborts, so a stalled remote no longer holds the caller.

See design/skills.md → Where the classifier runs and → Sizing, and design/infrastructure.md → Shutdown.
