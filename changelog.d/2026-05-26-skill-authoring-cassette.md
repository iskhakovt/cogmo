`src/test/skill-authoring.integration.test.ts` ungated: the chat→delegate→register→invoke flow now replays from a committed cassette without external state.

Replay mode no longer needs internet or real GitHub. The test boots a freshly initialised local bare git repo (file://) as origin, stubs `octokit.pulls.create` + `git.deleteRef` via a custom-fetch Octokit, and runs auto-register's host-side `git fetch` through a `gitFetchOverride` that materializes the recorded `SKILL.md` + `skill.py` fixture into the bare repo. Record mode unchanged: real GitHub + real Daytona.

DaytonaMock path normalization is now surgical: only the cogmo task-UUID **prefix** in session IDs (`cogmo-<8hex>-<3hex>-`) and the `cogmo.task` query label are stripped. Daytona-server UUIDs (sandbox, command, file) and the session-ID **suffix** (`skill-author-<seq>`) are preserved as the per-session FIFO identity. Earlier blanket UUID normalization collapsed every command path into one bucket and scrambled cmd-id assignment under wrap-around.

Two `BootstrapOptions` test seams added: `octokitFactory` (verify-orchestrator's draft-PR + cleanup-run-branch) and `gitFetchOverride` (auto-register's host-side fetch). Production omits both; only the skill-authoring replay path injects them.
