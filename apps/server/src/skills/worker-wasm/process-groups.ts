import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { match } from "ts-pattern";
import { z } from "zod";
import { describeError } from "../../util/describe-error.js";

/**
 * Wasm children's process groups, recorded so `cogmo serve` can kill the
 * ones a dead Cogmo process left behind (design/skills.md → Wasm-tier boundary,
 * layer 1 → Process-group records). Each child leads its own group; nothing
 * else bounds an orphan without a cgroup.
 *
 * A record names the group by its leader's pid and the Cogmo process that
 * forked it, its owner, and pins both with their start times and the
 * kernel's boot id, since a pid alone can name a reused process after a
 * container restart or a reboot. The owner writes the record before the
 * child's handshake and deletes it once the child has exited. A `serve`
 * boot's reap kills a recorded group only while the boot, the child and not
 * the owner still match; it leaves a live owner's records alone and deletes
 * the rest.
 */

/** Field 22 of `/proc/<pid>/stat`: clock ticks after boot, as written there. */
const StartTimeSchema = z.string().regex(/^\d+$/);

export const ChildGroupRecordSchema = z.object({
  bootId: z.string().min(1),
  /** The Cogmo process that forked the child. */
  ownerPid: z.number().int().positive(),
  ownerStartTime: StartTimeSchema,
  /** The child, which leads the group. */
  pid: z.number().int().positive(),
  startTime: StartTimeSchema,
});
export type ChildGroupRecord = z.infer<typeof ChildGroupRecordSchema>;

/** Why a record names no group to kill or leave. */
export type StaleReason = "other_boot" | "leader_gone" | "pid_reused" | "unreadable";

/**
 * What a reap does with a record: kill the group of a dead owner, leave a
 * live owner's record to it, or delete a record that names no live group.
 */
export type RecordVerdict =
  | { kind: "orphaned" }
  | { kind: "owned" }
  | { kind: "stale"; reason: StaleReason };

/** A group `SIGKILL`ed, or one already gone (`ESRCH`). */
export type KillOutcome = { kind: "killed" } | { kind: "gone" };

/**
 * What `reapOrphanedChildGroups` did with each record. `unjudged` names a
 * record left in place because `/proc` could not be read for its processes.
 */
export interface ReapReport {
  killed: readonly ChildGroupRecord[];
  owned: readonly ChildGroupRecord[];
  stale: readonly { file: string; reason: StaleReason }[];
  unjudged: readonly { file: string; message: string }[];
}

/** The kernel's id for this boot. */
export async function readBootId(): Promise<string> {
  return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
}

/**
 * Field 22 (`starttime`) of a `/proc/<pid>/stat` line, or null when the line
 * has no such field. Parsed after the last `)`: the command name in field 2
 * may hold spaces and parentheses.
 *
 * @public Exported for its unit test: a crafted `stat` line reaches no other path.
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
export async function readStartTime(pid: number): Promise<string | null> {
  try {
    return parseStartTime(await readFile(`/proc/${pid}/stat`, "utf8"));
  } catch (e) {
    if (errorCode(e) === "ENOENT" || errorCode(e) === "ESRCH") return null;
    throw e;
  }
}

/**
 * The verdict on `record` given what `/proc` shows now for its child and its
 * owner: stale from another boot or once the child's pid is gone or reused;
 * otherwise owned while the owner's start time still matches, and orphaned
 * once it does not.
 *
 * @public Exported for its unit test: the verdict table without live processes.
 */
export function judgeRecord(
  record: ChildGroupRecord,
  current: { bootId: string; startTime: string | null; ownerStartTime: string | null },
): RecordVerdict {
  if (record.bootId !== current.bootId) return { kind: "stale", reason: "other_boot" };
  if (current.startTime === null) return { kind: "stale", reason: "leader_gone" };
  if (current.startTime !== record.startTime) return { kind: "stale", reason: "pid_reused" };
  if (current.ownerStartTime === record.ownerStartTime) return { kind: "owned" };
  return { kind: "orphaned" };
}

/**
 * Record the group `pid` leads under `dir`, owned by this process, before
 * the child's handshake. Resolves the record's path, or why it could not be
 * written; the caller then kills the child, since an unrecorded child is one
 * a reap cannot find.
 */
export async function recordChildGroup(dir: string, pid: number): Promise<Result<string, string>> {
  try {
    const [startTime, ownerStartTime] = await Promise.all([
      readStartTime(pid),
      readStartTime(process.pid),
    ]);
    if (startTime === null) return err(`child ${pid} has no /proc entry`);
    if (ownerStartTime === null) return err(`this process (${process.pid}) has no /proc entry`);
    const record: ChildGroupRecord = {
      bootId: await readBootId(),
      ownerPid: process.pid,
      ownerStartTime,
      pid,
      startTime,
    };
    // Written aside and renamed into place, so a reap never reads a partial
    // record; the temporary name is not a `.json` a reap lists.
    const path = join(dir, `${pid}.json`);
    const tmp = `${path}.tmp.${randomUUID()}`;
    try {
      await writeFile(tmp, JSON.stringify(record));
      await rename(tmp, path);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    return ok(path);
  } catch (e) {
    return err(`could not record child ${pid}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Delete a child's record once it has exited. */
export async function removeChildGroupRecord(path: string): Promise<void> {
  await rm(path, { force: true });
}

/**
 * `SIGKILL` the group `pid` leads; `gone` when no such group exists. Only for
 * a group whose leader the caller has not reaped, or one `judgeRecord` found
 * orphaned: a reaped leader's pid can lead someone else's group.
 */
export function killChildGroup(pid: number): KillOutcome {
  try {
    process.kill(-pid, "SIGKILL");
    return { kind: "killed" };
  } catch (e) {
    if (errorCode(e) === "ESRCH") return { kind: "gone" };
    throw e;
  }
}

/**
 * Judge every record under `childrenDir`: kill an orphaned group and delete
 * its record, leave an owned one, and delete a stale one. A record whose
 * processes' start times cannot be read is left for the next reap. Only
 * `cogmo serve` runs it, at boot, before the runner serves.
 */
export async function reapOrphanedChildGroups(
  childrenDir: string,
  current: { bootId: string; readStartTime: (pid: number) => Promise<string | null> },
): Promise<ReapReport> {
  await sweepTempRecords(childrenDir, Date.now());
  const files = await listRecords(childrenDir);
  const killed: ChildGroupRecord[] = [];
  const owned: ChildGroupRecord[] = [];
  const stale: { file: string; reason: StaleReason }[] = [];
  const unjudged: { file: string; message: string }[] = [];
  // Sequential: each kill acts on the start times just read for that record.
  for (const file of files) {
    const path = join(childrenDir, file);
    const record = await readRecord(path);
    if (record === null) {
      stale.push({ file, reason: "unreadable" });
      await removeChildGroupRecord(path);
      continue;
    }
    const startTimes = await ResultAsync.fromPromise(
      Promise.all([current.readStartTime(record.pid), current.readStartTime(record.ownerPid)]),
      describeError,
    );
    if (startTimes.isErr()) {
      unjudged.push({ file, message: startTimes.error });
      continue;
    }
    const [startTime, ownerStartTime] = startTimes.value;
    const verdict = judgeRecord(record, { bootId: current.bootId, startTime, ownerStartTime });
    const keep = match(verdict)
      .with({ kind: "orphaned" }, () => {
        match(killChildGroup(record.pid))
          .with({ kind: "killed" }, () => killed.push(record))
          // It exited between the check and the kill: nothing was killed.
          .with({ kind: "gone" }, () => stale.push({ file, reason: "leader_gone" }))
          .exhaustive();
        return false;
      })
      // The owner deletes it when the child exits.
      .with({ kind: "owned" }, () => {
        owned.push(record);
        return true;
      })
      .with({ kind: "stale" }, ({ reason }) => {
        stale.push({ file, reason });
        return false;
      })
      .exhaustive();
    if (!keep) await removeChildGroupRecord(path);
  }
  return { killed, owned, stale, unjudged };
}

async function listRecords(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch (e) {
    if (errorCode(e) === "ENOENT") return [];
    throw e;
  }
}

/** A record's temporary file outlives its owner only when the owner died between write and rename. */
const STALE_TEMP_RECORD_MS = 60_000;

/**
 * Remove `<pid>.json.tmp.<id>` files older than a minute: an owner that died
 * between writing one and renaming it left it, and no reap reads it as a
 * record. A live owner's temp file exists for milliseconds, so the age gate
 * keeps a concurrent write safe.
 */
async function sweepTempRecords(dir: string, now: number): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.includes(".json.tmp."));
  } catch (e) {
    if (errorCode(e) === "ENOENT") return;
    throw e;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs > STALE_TEMP_RECORD_MS) await rm(path, { force: true });
    } catch (e) {
      // Renamed or removed by its owner between the listing and here.
      if (errorCode(e) !== "ENOENT") throw e;
    }
  }
}

async function readRecord(path: string): Promise<ChildGroupRecord | null> {
  try {
    const parsed = ChildGroupRecordSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    // A record that does not parse names nothing to kill.
    return null;
  }
}

function errorCode(e: unknown): unknown {
  return e instanceof Error && "code" in e ? e.code : undefined;
}
