**`AGENTS.md` holds the repo's agent instructions, and the rules live in `.agents/rules/`, so Codex, Cursor and other agents that read `AGENTS.md` work from the same conventions as Claude Code.**

`AGENTS.md` summarizes each rule in its own section and links the rule file rather than `@`-importing it. Agents are told to read the file before working in that area. The rules are not inlined: they come to about 55 KB, and Codex stops reading project instructions at 32 KiB (`project_doc_max_bytes`).

`CLAUDE.md` imports `AGENTS.md` and each rule file, so Claude Code has every rule in context at launch. Claude Code 2.1.277 and later reads `AGENTS.md` by itself when no `CLAUDE.md` exists, but it would then start without the rules. Older versions, and the first session after an upgrade, don't read `AGENTS.md` at all.

`.agents/` is also where Codex reads repo skills from (`.agents/skills/`). Files only Claude Code uses stay under `.claude/`.

The rules are agent-neutral. A sub-agent brief self-audits by walking the checklist in `.claude/agents/cogmo-reviewer.md`, and parallel agents that can't share files each get their own git worktree. `AGENTS.md` labels `/next`, `/cogmo-review` and `/code-review` as Claude Code shortcuts. For `/next` and `/cogmo-review` it also names the file another agent can follow.
