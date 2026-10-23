**`AGENTS.md` holds the repo's agent instructions, `.agents/rules/` the rules and `.agents/skills/` the skills, so Codex, Cursor and other agents that read `AGENTS.md` work from the same conventions and skills as Claude Code.**

`AGENTS.md` summarizes each rule in its own section and links the rule file rather than `@`-importing it. Agents are told to read the file before working in that area. The rules are not inlined: they come to about 55 KB, and Codex stops reading project instructions at 32 KiB (`project_doc_max_bytes`).

`CLAUDE.md` imports `AGENTS.md` and each rule file, so Claude Code has every rule in context at launch. Claude Code 2.1.277 and later reads `AGENTS.md` by itself when no `CLAUDE.md` exists, but it would then start without the rules. Older versions, and the first session after an upgrade, don't read `AGENTS.md` at all.

Skills are Agent Skills folders in `.agents/skills/`, where Codex discovers them (`$<name>`). Claude Code only reads `.claude/skills/`, so each skill has a symlink there (`/<name>`). `next` and `html` are skills, so Codex can run them too. Each `SKILL.md` names itself and carries the `description` Codex requires. Codex ignores the Claude-only frontmatter keys (`context`, `agent`, `when_to_use`, `argument-hint`, `allowed-tools`), and a body that uses `$ARGUMENTS` says to take the arguments from the request where it is not substituted.

The conformance checklist is the `cogmo-review` skill's `reviewer.md`. Under Claude Code the skill runs in the read-only `cogmo-reviewer` agent, whose definition keeps the tool limits, model and Bash hook and tells the agent to read the checklist first. Another agent follows the same file.

The rules are agent-neutral. A sub-agent brief self-audits by walking that checklist, and parallel agents that can't share files each get their own git worktree. `.claude/` holds only what Claude Code alone reads: settings, hooks, the reviewer agent's definition and the skill symlinks.
