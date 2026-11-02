import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
import {
  type ChildGroupRecord,
  ChildGroupRecordSchema,
  judgeRecord,
  killChildGroup,
  parseStartTime,
  readBootId,
  reapOrphanedChildGroups,
  recordChildGroup,
} from "./process-groups.js";

function record(overrides: Partial<ChildGroupRecord>): ChildGroupRecord {
  return {
    bootId: "boot-a",
    ownerPid: 100,
    ownerStartTime: "500",
    pid: 4242,
    startTime: "1000",
    ...overrides,
  };
}

/** A sleeping `node`, leading its own group when `detached`. */
function sleeper(opts: { detached: boolean }): { child: ChildProcess; pid: number } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
    detached: opts.detached,
    stdio: "ignore",
  });
  const pid = child.pid;
  assert(pid !== undefined);
  return { child, pid };
}

async function startTimeOf(pid: number): Promise<string> {
  const startTime = parseStartTime(await readFile(`/proc/${pid}/stat`, "utf8"));
  assert(startTime !== null);
  return startTime;
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
  const live = { bootId: "boot-a", startTime: "1000", ownerStartTime: "500" };

  it("is owned while the owner's start time still matches its pid", () => {
    expect(judgeRecord(record({}), live)).toEqual({ kind: "owned" });
  });

  it("is orphaned when the child matches and the owner is gone", () => {
    expect(judgeRecord(record({}), { ...live, ownerStartTime: null })).toEqual({
      kind: "orphaned",
    });
  });

  it("is orphaned when the owner's pid now names another process", () => {
    expect(judgeRecord(record({}), { ...live, ownerStartTime: "600" })).toEqual({
      kind: "orphaned",
    });
  });

  it("is stale from another boot, whatever the pids show", () => {
    expect(judgeRecord(record({}), { ...live, bootId: "boot-b" })).toEqual({
      kind: "stale",
      reason: "other_boot",
    });
  });

  it("is stale when the child is gone, whoever owns it", () => {
    expect(judgeRecord(record({}), { ...live, startTime: null })).toEqual({
      kind: "stale",
      reason: "leader_gone",
    });
  });

  it("is stale when the child's pid now names a process started at another time", () => {
    expect(judgeRecord(record({}), { ...live, startTime: "2000", ownerStartTime: null })).toEqual({
      kind: "stale",
      reason: "pid_reused",
    });
  });
});

describe("killChildGroup", () => {
  it("is gone for a group that no longer exists", async () => {
    const { child, pid } = sleeper({ detached: true });
    child.kill("SIGKILL");
    await once(child, "exit");
    expect(killChildGroup(pid)).toEqual({ kind: "gone" });
  });
});

describe("recordChildGroup", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cogmo-process-groups-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("names this process as the owner, with both start times", async () => {
    const { child, pid } = sleeper({ detached: true });
    try {
      const recorded = await recordChildGroup(dir, pid);
      assert(recorded.isOk(), recorded.isErr() ? recorded.error : "");
      const written = ChildGroupRecordSchema.parse(
        JSON.parse(await readFile(recorded.value, "utf8")),
      );
      expect(written).toEqual({
        bootId: await readBootId(),
        ownerPid: process.pid,
        ownerStartTime: await startTimeOf(process.pid),
        pid,
        startTime: await startTimeOf(pid),
      });
    } finally {
      child.kill("SIGKILL");
    }
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

  /** A record for the live `pid`, owned by this process with `ownerStartTime`. */
  async function writeRecord(pid: number, ownerStartTime: string): Promise<void> {
    const written: ChildGroupRecord = {
      bootId: await readBootId(),
      ownerPid: process.pid,
      ownerStartTime,
      pid,
      startTime: await startTimeOf(pid),
    };
    await writeFile(join(dir, `${pid}.json`), JSON.stringify(written));
  }

  it("is empty for a directory that does not exist", async () => {
    expect(await reapOrphanedChildGroups(join(dir, "missing"), { bootId: "x" })).toEqual({
      killed: [],
      owned: [],
      stale: [],
    });
  });

  it("kills the group of a child whose owner is gone, and deletes its record", async () => {
    const { child, pid } = sleeper({ detached: true });
    const exited = once(child, "exit");
    try {
      // This process's pid with a start time it never had: an owner since replaced.
      await writeRecord(pid, "1");

      const report = await reapOrphanedChildGroups(dir, { bootId: await readBootId() });

      expect(report).toEqual({
        killed: [expect.objectContaining({ pid })],
        owned: [],
        stale: [],
      });
      expect(await exited).toEqual([null, "SIGKILL"]);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("leaves a live owner's child running and its record in place", async () => {
    const { child, pid } = sleeper({ detached: true });
    try {
      await writeRecord(pid, await startTimeOf(process.pid));

      const report = await reapOrphanedChildGroups(dir, { bootId: await readBootId() });

      expect(report).toEqual({ killed: [], owned: [expect.objectContaining({ pid })], stale: [] });
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(await readdir(dir)).toEqual([`${pid}.json`]);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("deletes an orphaned record whose group is gone by the kill as stale", async () => {
    // Alive with the recorded start time, but leading no group of its own, so
    // the kill finds no such group: what a child exiting under the reap leaves.
    const { child, pid } = sleeper({ detached: false });
    try {
      await writeRecord(pid, "1");

      const report = await reapOrphanedChildGroups(dir, { bootId: await readBootId() });

      expect(report).toEqual({
        killed: [],
        owned: [],
        stale: [{ file: `${pid}.json`, reason: "leader_gone" }],
      });
      expect(await readdir(dir)).toEqual([]);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("kills nothing for a record from another boot or a malformed one, and deletes both", async () => {
    await writeFile(join(dir, "1.json"), JSON.stringify(record({ pid: process.pid })));
    await writeFile(join(dir, "2.json"), "{ cut short");

    const report = await reapOrphanedChildGroups(dir, { bootId: await readBootId() });

    expect(report).toEqual({
      killed: [],
      owned: [],
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

    expect(report).toEqual({
      killed: [],
      owned: [],
      stale: [{ file: "1.json", reason: "pid_reused" }],
    });
  });
});
