**The devbase image runs Claude Code 2.1.304, its current `stable` dist-tag, and both runners start the CLI with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.** A `-p` run otherwise stays open while a background command the model started is still running, so an execute run that left a dev server up would trip the 5-minute idle cap and fail a task whose work was done. Also in 2.1.288–2.1.304:

- Execute's `--resume` of a session compacted after a cut-off or retried reply restores its summary and the messages the compaction kept.
- `claude -p` offers fork subagents (`subagent_type: "fork"`), and they run in the foreground.

pnpm 12.13.0 builds the workspace, the `cogmo` image and devbase, and leaves `pnpm-lock.yaml` byte-identical. The test harness runs Gitea 28.1.0 and RustFS 1.0.1, and the skills runtime's ruff is 0.17.0, each the newest release at least seven days old. The dev shell follows the current nixos-unstable.
