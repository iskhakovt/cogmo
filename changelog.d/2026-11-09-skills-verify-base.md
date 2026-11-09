Coding tasks on the skills repo run the toolchain's checks (design/skills.md → Verify stage → The skills repo toolchain).

- allocate-worktree records the commit a task's branch is cut from as `worktree_assignment.baseSha`, then cuts the branch at that sha, so a retry cuts again at the same commit. On a git-remote tree, a retry whose saved base is on neither the mirror nor the remote ends the task `push_failed`.
  - The base is the local repo's `HEAD` for a host-path tree, or the remote's freshly fetched default branch for a git-remote one.
  - The plan, execute and verify sessions receive it as `COGMO_VERIFY_BASE`.
- Each boot writes the skills repo's `verify_command` as `uv run --locked --group dev .cogmo/verify`, after the toolchain commit. The generated `CLAUDE.md` names that check.
- The toolchain's `pyproject.toml` resolves an author's `uv pip compile` for the image's exact Python version, the interpreter register's compile runs on, so the author's lockfile matches register's.
