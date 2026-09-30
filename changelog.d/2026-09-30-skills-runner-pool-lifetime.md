The skills runner's resources now end with their callers.

- **Warm pool at shutdown.** `cogmo serve` disposes the tier-2 warm pool on exit, as its own bounded step after MCP and before the sandbox, so its containers no longer outlive the process.
- **Cancelling `register`.** `SkillRunner.register` takes an `AbortSignal`. An abort before the deploy transaction starts stops the deploy: the lockfile compile starts no session and disposes a running exec, and `register` rejects with the signal's reason, leaving `main` and the branch untouched. Once the transaction has started, an abort only kills the mirror push to the remote, and the result stands. A skill-repo coding task's auto-register passes a 300 s deadline, so a register that overruns it is stopped rather than left running to put the skill live after the step has failed.

See design/skills.md → Where the classifier runs and → Sizing, and design/infrastructure.md → Shutdown.
