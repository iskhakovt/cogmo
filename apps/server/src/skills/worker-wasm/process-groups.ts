import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { z } from "zod";
import { logger } from "../../logger.js";

/**
 * Tier-1 children's process groups, recorded so boot can kill the ones a dead
 * host left behind (design/skills.md → Tier-1 boundary, layer 1). Each child
 * leads its own group; nothing else bounds an orphan without a cgroup. A
 * record names the group by its leader's pid, and pins it with the kernel's
 * boot id and the leader's start time, since a pid alone can name a reused
 * group, the server's own included, after a container restart or a reboot.
 *
 * `recorded → exited`: the host writes the record before the child's
 * handshake and deletes it once the child has exited, killed or not.
 * `orphaned → killed`: boot kills a recorded group only while the boot id and
 * the leader's start time still match, and deletes every record either way.
 */

const log = logger.child({ component: "skills.worker.wasm.process-groups" });

export const ChildGroupRecordSchema = z.object({
  bootId: z.string().min(1),
  /** The serve instance that forked the child; null where none is known. */
  instanceId: z.string().min(1).nullable(),
  pid: z.number().int().positive(),
  /** Field 22 of `/proc/<pid>/stat`: clock ticks after boot, as written there. */
  startTime: z.string().regex(/^\d+$/),
});
export type ChildGroupRecord = z.infer<typeof ChildGroupRecordSchema>;

/** Why a record names no live orphan. */
export type StaleReason = "other_boot" | "leader_gone" | "pid_reused" | "unreadable";

export type RecordVerdict = { kind: "orphaned" } | { kind: "stale"; reason: StaleReason };

/** What `reapOrphanedChildGroups` did with each record. */
export interface ReapReport {
  killed: readonly ChildGroupRecord[];
  stale: readonly { file: string; reason: StaleReason }[];
}

/** The kernel's id for this boot. */
export async function readBootId(): Promise<string> {
  return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
}

/**
 * Field 22 (`starttime`) of a `/proc/<pid>/stat` line, or null when the line
 * has no such field. Parsed after the last `)`: the command name in field 2
 * may hold spaces and parentheses.
 */
export function parseStartTime(stat: string): string | null {
  const close = stat.lastIndexOf(")");
  if (close === -1) return null;
  // The fields after the name start at field 3.
  const field = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)[22 - 3];
  return field !== undefined && /^\d+$/.test(field) ? field : null;
}

/** The start time of `pid`, or null when no such process exists. */
async function readStartTime(pid: number): Promise<string | null> {
  try {
    return parseStartTime(await readFile(`/proc/${pid}/stat`, "utf8"));
  } catch (e) {
    if (errorCode(e) === "ENOENT" || errorCode(e) === "ESRCH") return null;
    throw e;
  }
}

/**
 * Whether `record` names a live group this boot: the same boot, and a leader
 * still alive with the start time it was recorded with.
 */
export function judgeRecord(
  record: ChildGroupRecord,
  current: { bootId: string; startTime: string | null },
): RecordVerdict {
  if (record.bootId !== current.bootId) return { kind: "stale", reason: "other_boot" };
  if (current.startTime === null) return { kind: "stale", reason: "leader_gone" };
  if (current.startTime !== record.startTime) return { kind: "stale", reason: "pid_reused" };
  return { kind: "orphaned" };
}

/**
 * Record the group `pid` leads under `dir`, before the child's handshake.
 * Resolves the record's path, or why it could not be written; the caller then
 * kills the child, since an unrecorded child is one boot cannot reap.
 */
export async function recordChildGroup(
  dir: string,
  child: { pid: number; instanceId: string | null },
): Promise<Result<string, string>> {
  try {
    const startTime = await readStartTime(child.pid);
    if (startTime === null) return err(`child ${child.pid} has no /proc entry`);
    const record: ChildGroupRecord = {
      bootId: await readBootId(),
      instanceId: child.instanceId,
      pid: child.pid,
      startTime,
    };
    const path = join(dir, `${child.pid}.json`);
    await writeFile(path, JSON.stringify(record));
    return ok(path);
  } catch (e) {
    return err(
      `could not record child ${child.pid}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Delete a child's record once it has exited. */
export async function removeChildGroupRecord(path: string): Promise<void> {
  await rm(path, { force: true });
}

/**
 * `SIGKILL` the group `pid` leads. False when the group is already gone.
 * Only for a group whose leader the caller has not reaped, or one
 * `judgeRecord` found live: a reaped leader's pid can lead someone else's
 * group.
 */
export function killChildGroup(pid: number): boolean {
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch (e) {
    if (errorCode(e) === "ESRCH") return false;
    throw e;
  }
}

/**
 * Kill every group recorded under `childrenDir` that is still alive this
 * boot, and delete every record. Boot runs it before the pool starts.
 */
export async function reapOrphanedChildGroups(
  childrenDir: string,
  current: { bootId: string },
): Promise<ReapReport> {
  const files = await listRecords(childrenDir);
  const killed: ChildGroupRecord[] = [];
  const stale: { file: string; reason: StaleReason }[] = [];
  // Sequential: each kill acts on the start time just read for that pid.
  for (const file of files) {
    const path = join(childrenDir, file);
    const record = await readRecord(path);
    const verdict: RecordVerdict =
      record === null
        ? { kind: "stale", reason: "unreadable" }
        : judgeRecord(record, {
            bootId: current.bootId,
            startTime: await readStartTime(record.pid),
          });
    match(verdict)
      .with({ kind: "orphaned" }, () => {
        if (record !== null && killChildGroup(record.pid)) killed.push(record);
        else stale.push({ file, reason: "leader_gone" });
      })
      .with({ kind: "stale" }, ({ reason }) => stale.push({ file, reason }))
      .exhaustive();
    await removeChildGroupRecord(path);
  }
  if (killed.length > 0) {
    log.warn({ killed: killed.map((r) => r.pid) }, "killed orphaned tier-1 child groups");
  }
  return { killed, stale };
}

async function listRecords(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch (e) {
    if (errorCode(e) === "ENOENT") return [];
    throw e;
  }
}

async function readRecord(path: string): Promise<ChildGroupRecord | null> {
  try {
    const parsed = ChildGroupRecordSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    // A record cut short by a crash mid-write names nothing to kill.
    return null;
  }
}

function errorCode(e: unknown): unknown {
  return e instanceof Error && "code" in e ? e.code : undefined;
}
