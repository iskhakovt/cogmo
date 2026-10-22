**`AGENTS.md` is the repo's agent instructions, and the rules live in `.agents/rules/`, so Codex, Cursor and any other agent that reads `AGENTS.md` works from the same conventions as Claude Code.**

`AGENTS.md` is plain Markdown. Each rule is summarized in its section and linked, and it tells an agent to read the rule file before working in that area. The rules aren't inlined: together they come to about 55 KB, and Codex stops reading project instructions at 32 KiB (`project_doc_max_bytes`).

`CLAUDE.md` holds only the Claude Code side: an `@AGENTS.md` import plus one import per rule file, so Claude still has every rule in context from the start of a session. Claude Code 2.1.277 and later reads `AGENTS.md` on its own, but only when there is no `CLAUDE.md`, and it would then skip the rule imports. Keeping the stub also covers sessions that cannot read `AGENTS.md` directly.

`.agents/` is the directory Codex reads repo skills from (`.agents/skills/`). The Claude Code-specific pieces stay under `.claude/`: settings, hooks, the `cogmo-reviewer` agent and the skills and commands.

The rules no longer assume Claude Code. A sub-agent brief self-audits by walking the conformance checklist in `.claude/agents/cogmo-reviewer.md`, and parallel agents that can't share files each get their own git worktree. `AGENTS.md` names `/next`, `/cogmo-review` and `/code-review` as Claude Code shortcuts, and for the first two it names the file any other agent can follow. Code comments, design docs and `todo.md` point at `AGENTS.md` and `.agents/rules/`.
