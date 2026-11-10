import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import {
  type ChildGroupRecord,
  parseStartTime,
  readBootId,
} from "../skills/worker-wasm/process-groups.js";
import { bootstrapSkillRunner } from "./skills.js";
import type { CoreDeps, SkillRunnerSandboxes } from "./stages.js";

/** What a process with no sandbox backend configured passes. */
const NO_SANDBOXES: SkillRunnerSandboxes = { invoke: null, register: null };

/** `env` reads `COGMO_SKILLS_PATH` when the module loads, so it is set first. */
const skillsPath = vi.hoisted(() => {
  const path = `${process.env.TMPDIR ?? "/tmp"}/cogmo-boot-skills-${process.pid}`;
  process.env.COGMO_SKILLS_PATH = path;
  return path;
});

const childrenDir = join(skillsPath, ".wasm-children");

async function startTimeOf(pid: number): Promise<string> {
  const startTime = parseStartTime(await readFile(`/proc/${pid}/stat`, "utf8"));
  assert(startTime !== null);
  return startTime;
}

describe("bootstrapSkillRunner", () => {
  let orphan: ChildProcess;
  let pid: number;

  beforeEach(async () => {
    await mkdir(childrenDir, { recursive: true });
    orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
      detached: true,
      stdio: "ignore",
    });
    assert(orphan.pid !== undefined);
    pid = orphan.pid;
    // A child whose owner is gone: this process's pid with a start time it never had.
    const record: ChildGroupRecord = {
      bootId: await readBootId(),
      ownerPid: process.pid,
      ownerStartTime: "1",
      pid,
      startTime: await startTimeOf(pid),
    };
    await writeFile(join(childrenDir, `${pid}.json`), JSON.stringify(record));
  });

  afterEach(async () => {
    orphan.kill("SIGKILL");
    await rm(skillsPath, { recursive: true, force: true });
  });

  it("leaves wasm children and their records alone for a CLI process", async () => {
    await bootstrapSkillRunner(mock<CoreDeps>(), NO_SANDBOXES, { reapWasmChildren: false });

    expect(orphan.exitCode).toBeNull();
    expect(orphan.signalCode).toBeNull();
    expect(await readdir(childrenDir)).toEqual([`${pid}.json`]);
  });

  it("kills a dead owner's wasm children before the serve's runner exists", async () => {
    const exited = once(orphan, "exit");

    await bootstrapSkillRunner(mock<CoreDeps>(), NO_SANDBOXES, { reapWasmChildren: true });

    expect(await exited).toEqual([null, "SIGKILL"]);
    expect(await readdir(childrenDir)).toEqual([]);
  });

  it("skips the reap on a host without Linux's /proc, reading no boot id", async () => {
    const bootId = vi.fn(readBootId);

    await bootstrapSkillRunner(
      mock<CoreDeps>(),
      NO_SANDBOXES,
      { reapWasmChildren: true },
      { wasmReapHostOverride: { platform: "darwin", readBootId: bootId } },
    );

    expect(bootId).not.toHaveBeenCalled();
    expect(orphan.exitCode).toBeNull();
    expect(orphan.signalCode).toBeNull();
    expect(await readdir(childrenDir)).toEqual([`${pid}.json`]);
  });

  it("skips the reap when the boot id is unreadable, rather than failing the boot", async () => {
    const unreadable = Object.assign(new Error("ENOENT: no such file or directory"), {
      code: "ENOENT",
    });

    await bootstrapSkillRunner(
      mock<CoreDeps>(),
      NO_SANDBOXES,
      { reapWasmChildren: true },
      {
        wasmReapHostOverride: {
          platform: "linux",
          readBootId: () => Promise.reject(unreadable),
        },
      },
    );

    expect(orphan.exitCode).toBeNull();
    expect(orphan.signalCode).toBeNull();
    expect(await readdir(childrenDir)).toEqual([`${pid}.json`]);
  });
});

describe("bootstrapSkillRunner's grammar check", () => {
  it("fails the boot when the vendored grammar under the working directory cannot load", async () => {
    // A working directory with no `vendor/`, as an image missing the grammar.
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(skillsPath);
    try {
      await expect(
        bootstrapSkillRunner(mock<CoreDeps>(), NO_SANDBOXES, { reapWasmChildren: false }),
      ).rejects.toThrow(
        `the Python grammar at ${join(skillsPath, "vendor", "tree-sitter-python", "tree-sitter-python.wasm")} did not load`,
      );
    } finally {
      cwd.mockRestore();
    }
  });
});
