import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
import {
  type ChildGroupRecord,
  judgeRecord,
  parseStartTime,
  readBootId,
  reapOrphanedChildGroups,
  recordChildGroup,
} from "./process-groups.js";

function record(overrides: Partial<ChildGroupRecord>): ChildGroupRecord {
  return { bootId: "boot-a", instanceId: null, pid: 4242, startTime: "1000", ...overrides };
}

describe("parseStartTime", () => {
  it("reads field 22, after a command name holding spaces and parentheses", () => {
    const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
    const stat = `4242 (evil) (name x) ${fields.join(" ")}\n`;
    expect(parseStartTime(stat)).toBe("22");
  });

  it("is null for a line with no name or too few fields", () => {
    expect(parseStartTime("4242 no-parens 1 2 3")).toBeNull();
    expect(parseStartTime("4242 (short) S 1 2")).toBeNull();
  });
});

describe("judgeRecord", () => {
  it("is orphaned when the boot and the leader's start time match", () => {
    expect(judgeRecord(record({}), { bootId: "boot-a", startTime: "1000" })).toEqual({
      kind: "orphaned",
    });
  });

  it("is stale from another boot, whatever the pid shows", () => {
    expect(judgeRecord(record({}), { bootId: "boot-b", startTime: "1000" })).toEqual({
      kind: "stale",
      reason: "other_boot",
    });
  });

  it("is stale when the leader is gone", () => {
    expect(judgeRecord(record({}), { bootId: "boot-a", startTime: null })).toEqual({
      kind: "stale",
      reason: "leader_gone",
    });
  });

  it("is stale when the pid now names a process started at another time", () => {
    expect(judgeRecord(record({}), { bootId: "boot-a", startTime: "2000" })).toEqual({
      kind: "stale",
      reason: "pid_reused",
    });
  });
});

describe("reapOrphanedChildGroups", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cogmo-process-groups-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is empty for a directory that does not exist", async () => {
    expect(await reapOrphanedChildGroups(join(dir, "missing"), { bootId: "x" })).toEqual({
      killed: [],
      stale: [],
    });
  });

  it("kills a recorded group still alive, and deletes its record", async () => {
    const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
      detached: true,
      stdio: "ignore",
    });
    const exited = once(orphan, "exit");
    try {
      const pid = orphan.pid;
      assert(pid !== undefined);
      const recorded = await recordChildGroup(dir, { pid, instanceId: "instance-1" });
      assert(recorded.isOk(), recorded.isErr() ? recorded.error : "");

      const report = await reapOrphanedChildGroups(dir, { bootId: await readBootId() });

      expect(report.killed).toEqual([expect.objectContaining({ pid, instanceId: "instance-1" })]);
      expect(report.stale).toEqual([]);
      expect(await exited).toEqual([null, "SIGKILL"]);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      orphan.kill("SIGKILL");
    }
  });

  it("kills nothing for a record from another boot or a malformed one, and deletes both", async () => {
    await writeFile(join(dir, "1.json"), JSON.stringify(record({ pid: process.pid })));
    await writeFile(join(dir, "2.json"), "{ cut short");

    const report = await reapOrphanedChildGroups(dir, { bootId: await readBootId() });

    expect(report).toEqual({
      killed: [],
      stale: [
        { file: "1.json", reason: "other_boot" },
        { file: "2.json", reason: "unreadable" },
      ],
    });
    expect(await readdir(dir)).toEqual([]);
  });

  it("kills nothing when the recorded pid now names another process", async () => {
    // This process is alive this boot, but not with the recorded start time.
    await writeFile(
      join(dir, "1.json"),
      JSON.stringify(record({ bootId: await readBootId(), pid: process.pid, startTime: "1" })),
    );

    const report = await reapOrphanedChildGroups(dir, { bootId: await readBootId() });

    expect(report).toEqual({ killed: [], stale: [{ file: "1.json", reason: "pid_reused" }] });
  });
});
