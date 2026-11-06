import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { fakeRunInTx } from "../../test/factories.js";
import type { SkillRunRecoveryPoint, SkillRunRow, SkillStore } from "../store/index.js";
import { startRun } from "./start-run.js";

const CREATED_AT = new Date("2026-01-01T00:00:00Z");

function runRow(overrides: Partial<SkillRunRow>): SkillRunRow {
  return {
    id: "run-1",
    skillId: "skill-1",
    trigger: "manual",
    inputs: {},
    status: "running",
    output: null,
    error: null,
    errorKind: null,
    resourceUsage: null,
    idempotencyKey: "key-1",
    recoveryPoint: "started",
    deadlineAt: null,
    gitSha: "sha-1",
    runAsUserId: "user-1",
    runAsProfileId: "profile-1",
    shadow: false,
    createdAt: CREATED_AT,
    finishedAt: null,
    ...overrides,
  };
}

function keyedStore(kind: "new" | "recovered", row: SkillRunRow): SkillStore {
  const store = mock<SkillStore>();
  store.startOrRecoverRun.mockResolvedValue({ kind, row });
  return store;
}

const ARGS = {
  skillId: "skill-1",
  trigger: "manual",
  inputs: {},
  gitSha: "sha-1",
  runAs: { userId: "user-1", profileId: "profile-1" },
} as const;

describe("startRun", () => {
  it("executes a fresh row when there is no idempotency key", async () => {
    const store = mock<SkillStore>();
    store.insertRun.mockResolvedValue(runRow({ idempotencyKey: null }));

    const start = await startRun({ store, runInTx: fakeRunInTx }, ARGS);

    expect(start).toEqual({ kind: "execute", runId: "run-1", createdAt: CREATED_AT });
    expect(store.insertRun).toHaveBeenCalledWith(expect.anything(), ARGS);
    expect(store.startOrRecoverRun).not.toHaveBeenCalled();
  });

  it("executes a keyed row this attempt inserted", async () => {
    const store = keyedStore("new", runRow({}));

    const start = await startRun(
      { store, runInTx: fakeRunInTx },
      { ...ARGS, idempotencyKey: "key-1" },
    );

    expect(start).toEqual({ kind: "execute", runId: "run-1", createdAt: CREATED_AT });
    expect(store.startOrRecoverRun).toHaveBeenCalledWith(expect.anything(), {
      ...ARGS,
      idempotencyKey: "key-1",
    });
  });

  it.each<[SkillRunRecoveryPoint, Partial<SkillRunRow>, unknown]>([
    ["started", {}, { kind: "inflight", runId: "run-1" }],
    ["dispatched", { deadlineAt: CREATED_AT }, { kind: "inflight", runId: "run-1" }],
    [
      "executed",
      { output: { n: 1 } },
      { kind: "finish", runId: "run-1", executed: { kind: "output", output: { n: 1 } } },
    ],
    [
      "executed",
      { error: "boom", errorKind: "skill_raised" },
      {
        kind: "finish",
        runId: "run-1",
        executed: { kind: "error", error: { kind: "skill_raised", message: "boom" } },
      },
    ],
    [
      "finished",
      { status: "success", output: { n: 1 } },
      { kind: "replay", result: { runId: "run-1", status: "success", output: { n: 1 } } },
    ],
    [
      "finished",
      { status: "error", error: "boom", errorKind: "host_lost" },
      {
        kind: "replay",
        result: { runId: "run-1", status: "error", errorKind: "host_lost", error: "boom" },
      },
    ],
    [
      "finished",
      { status: "error", error: "bad", errorKind: "output_invalid", output: { n: "x" } },
      {
        kind: "replay",
        result: {
          runId: "run-1",
          status: "error",
          errorKind: "output_invalid",
          error: "bad",
          output: { n: "x" },
        },
      },
    ],
  ])("takes up a recovered row at %s", async (recoveryPoint, fields, expected) => {
    const store = keyedStore("recovered", runRow({ recoveryPoint, ...fields }));

    const start = await startRun(
      { store, runInTx: fakeRunInTx },
      { ...ARGS, idempotencyKey: "key-1" },
    );

    expect(start).toEqual(expected);
  });

  it("rejects a recovered finished error row with no reason as an invariant violation", async () => {
    const store = keyedStore(
      "recovered",
      runRow({ recoveryPoint: "finished", status: "error", error: null }),
    );

    await expect(
      startRun({ store, runInTx: fakeRunInTx }, { ...ARGS, idempotencyKey: "key-1" }),
    ).rejects.toThrow(/run-1 finished with status 'error' and no error/);
  });

  it("rejects a recovered error row with no kind as an invariant violation", async () => {
    const store = keyedStore(
      "recovered",
      runRow({ recoveryPoint: "executed", error: "boom", errorKind: null }),
    );

    await expect(
      startRun({ store, runInTx: fakeRunInTx }, { ...ARGS, idempotencyKey: "key-1" }),
    ).rejects.toThrow(/run-1 has an error and no error_kind/);
  });
});
