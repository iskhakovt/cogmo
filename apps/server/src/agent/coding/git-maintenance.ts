/**
 * Git background-maintenance suppression for the task working tree.
 *
 * `git commit` and `git push` each spawn `git maintenance run --auto
 * --detach`, and that detached process goes on writing inside the
 * repository's `.git/` — new packs, `objects/info/packs`, `info/refs` —
 * after the foreground command has already exited. A task working tree is a
 * standalone clone, so its `.git` sits *inside* `worktreePath`, the very
 * tree `removeWorktree` deletes a few statements later: the writer
 * repopulates directories mid-delete and `fs.rm` fails with `ENOTEMPTY`.
 * `removeWorktree` only warns on that failure, so the visible damage is a
 * half-deleted clone left at a path that is stable per task, which then
 * blocks the next `allocateWorktree` there ("exists but is not a git
 * working tree").
 *
 * Both runners that commit and push in the tree do so inside a container,
 * against `/workspace`, which on the bind-mount backend IS `worktreePath`:
 * `runCommitAndPush` in the task's container and `runWipSalvage` in
 * teardown's salvage container. A detached maintenance process there writes
 * through the mount into the tree the host then deletes.
 */

/**
 * Config that switches off git's background maintenance.
 *
 * `maintenance.auto=false` is the one that stops the spawn — measured, not
 * assumed: with only `gc.auto=0` set, `git commit` still spawns
 * `git maintenance run --auto`, because that setting gates the work the
 * spawned process finds to do rather than the spawn. `gc.auto=0` is carried
 * for the older `gc --auto` path.
 */
const NO_BACKGROUND_MAINTENANCE: ReadonlyArray<readonly [key: string, value: string]> = [
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
];

/**
 * The same settings as `git -c` arguments, for a command whose argv we build.
 *
 * `-c` rather than `GIT_CONFIG_COUNT` because the container's ambient
 * environment isn't ours to see. `GIT_CONFIG_COUNT` numbering only composes
 * if you can enumerate every pair already declared, so writing it blind
 * overwrites index 0 of whatever was there. Inside a container that is a
 * live risk rather than a pedantic one: `safe.directory` is exactly the entry
 * that gets added when a bind mount's owner uid doesn't match the exec user,
 * and shadowing it makes git refuse the worktree outright. `-c` sits outside
 * that numbering and composes with whatever config the environment already
 * carries.
 */
export const NO_BACKGROUND_MAINTENANCE_FLAGS: ReadonlyArray<string> =
  NO_BACKGROUND_MAINTENANCE.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
