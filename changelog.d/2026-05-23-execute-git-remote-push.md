Execute orchestrator now pushes claude's commits to origin for git-remote sandboxes, so the verify sandbox sees the same state after its fresh clone.

Until now, claude's edits inside a git-remote (Daytona) execute sandbox lived only on the sandbox's local filesystem and were lost on teardown. The verify orchestrator then created a new sandbox, cloned `cogmo/run/<task-id>` into a fresh worktree, ran the verify command against the unchanged baseline, and opened a PR that GitHub rejected with "No commits between main and `cogmo/<idShort>`". The orchestrator-side `runCommitAndPush` saw `nothing_to_commit` because the clone tracked the unchanged run-branch tip.

Fix shape (mirrors the orchestrator-side git transport pattern: every cross-sandbox handoff materializes through origin, with the orchestrator holding the credentials):

- `runCodingExecute` resolves the bot identity up front when the sandbox advertises `workingTreeTransport === "git-remote"`, provisions an askpass dir before `create-container`, and binds it into the execute sandbox via `SessionSpec.askpass`. The PAT stays in closure scope and never becomes a step return value.
- After `runExecuteStreaming` succeeds, a new `commit-and-push-execute-changes` step runs `runCommitAndPush` from inside the execute sandbox with the same `runCommitAndPush` helper verify already uses, pushing `HEAD:refs/heads/<runBranch>` so the verify sandbox's later clone reflects claude's commit on `cogmo/run/<task-id>`.
- `CommitAndPushParams` gains an optional `remoteBranch`: when set, the push refspec is `HEAD:refs/heads/<remoteBranch>` so the local feature branch can write to a different remote ref. Verify-orchestrator's call site keeps the default (push the local feature branch to its own name on origin); execute-orchestrator sets `remoteBranch` to the run-branch.
- `commitAuthorFor` moved out of `verify-orchestrator.ts` into `commit-push.ts` so both call sites share one definition. No behavior change there.
- Push failure (`auth_failed`, `branch_conflict`, `failed`) transitions the task to `failed` with a descriptive `failure_reason` and skips the `set-status-pending-verify` step, mirroring the existing `runExecuteStreaming`-failed cleanup path.
- Askpass cleanup added to the execute orchestrator's `finally` block.
- `CodingOrchestratorDeps.askpassBaseDir` added and threaded from `BootstrapOptions` via `index.ts` (already wired for verify-orchestrator).

`noopExec` in `orchestrator-git-remote.test.ts` was using `process.stdin` as the stdout/stderr stream, which never ends and hangs `runCommitAndPush`'s `for await` consumer; replaced with `PassThrough` streams that close immediately.

Tests in `orchestrator.test.ts`, `orchestrator-git-remote.test.ts`, and `coding-flow.test.ts` thread `askpassBaseDir` into the deps fixture.
