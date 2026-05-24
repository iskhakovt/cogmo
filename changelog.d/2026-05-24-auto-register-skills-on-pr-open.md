Coding pipeline now auto-registers skills when a `coding/task/pr-opened` event fires against the cogmo-skills repo. A new `coding-auto-register-skill` Inngest subscriber fetches the PR head branch from origin into the local bare repo and calls `runner.register({ branch })`. Closes the chat -> delegate -> register -> invoke loop without requiring the agent to call `register_skill` in a separate turn.

Non-skills repos are a no-op (the subscriber checks `coding_repos.name === SKILLS_CODING_REPO_NAME` and returns early). Production runs unattended at `retries: 0` with a 180s wall-clock cap on the register call.

Devbase image gains `uv` (copied from `ghcr.io/astral-sh/uv` at the same version `cogmo-skills` uses) so author-side `uv pip compile` produces lockfiles byte-identical to what the runtime re-resolves at register time.

Plan + execute prompts get a skills-repo convention block when the target is the cogmo-skills repo: file layout (SKILL.md + skill.py + requirements.lock at /workspace root), manifest contract (`tier` literal, `inputs` JSON Schema, `effects` closed set), and a worked SKILL.md template with deps. Until the bare repo grows its own `CLAUDE.md`, this is the way claude learns the convention.

`src/test/skill-authoring.integration.test.ts` gains record-mode prebuilds for the devbase + cogmo-skills snapshots (via `Image.fromDockerfile` and snapshot reuse) plus a deps-cache volume readiness wait, eliminating the registry-push and first-use races. Cassette recording is still blocked on a PTY-exec hang in `makeSandboxLockfileCompiler` (captured as a follow-up p1).
