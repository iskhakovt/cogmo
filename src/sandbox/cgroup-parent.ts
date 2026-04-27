/**
 * Cgroup parent helpers for the sandbox supervisor.
 *
 * Each task gets a `cogmo-task-<id>.slice` (systemd) cgroup parent. Both the
 * task container and every child container created via the proxy land in
 * the same slice; teardown cascades remove the whole subtree at once.
 *
 * **Aggregate-budget enforcement is deferred.** Setting CPU/memory/pids
 * limits at the slice level requires either running Cogmo as root or
 * standing up a delegated cgroup tree (systemd `Delegate=yes` on Cogmo's
 * own unit + writing limits directly to `/sys/fs/cgroup/.../cpu.max`).
 * Slice 3.0h ships the slice naming + assignment infrastructure so the
 * tree is coherent today; per-leaf limits via Docker's `NanoCpus` +
 * `Memory` + `PidsLimit` already cap the task container itself. When the
 * spawn-many-children case becomes routine (and a single child can no
 * longer steal the whole task budget), wire in delegated-slice limits as
 * a follow-up — the slice name is already plumbed end-to-end.
 *
 * **Systemd-only.** The deployment target is Linux + systemd (matches our
 * GHA `ubuntu-24.04` runner and the `mcr.microsoft.com/devcontainers/base:
 * ubuntu-24.04` devbase image). Cgroupfs fallback for non-systemd hosts is
 * out of scope; document linux-with-systemd as the supported config.
 */

import { isUuid } from "../util/uuid.js";

const SLICE_PREFIX = "cogmo-task-";

/**
 * Build the systemd slice name for a task. UUIDv7 dashes are stripped so
 * the slice unit-name is a single token (systemd is fine with dashes but
 * tooling output is cleaner without them, and we already use the dashless
 * form for branch names + worktree directories).
 *
 * Defence in depth: task ids are DB-issued UUIDv7s, but the slice name
 * is forwarded into a Docker `HostConfig.CgroupParent` field that's
 * exec'd as a systemd unit name. Validate the shape so a malformed id
 * can't synthesise a weird unit name.
 */
export function taskSliceName(taskId: string): string {
  if (!isUuid(taskId)) {
    throw new Error(`taskSliceName: expected a UUID, got ${JSON.stringify(taskId)}`);
  }
  return `${SLICE_PREFIX}${taskId.replaceAll("-", "")}.slice`;
}
