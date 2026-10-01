import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { expectOk } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { parseManifest } from "../manifest.js";
import { SkillSourceCache, type SkillSourceCacheEntry } from "../source-cache.js";
import { DrizzleSkillStore } from "../store/index.js";
import { finishRun } from "./finish-run.js";

const MANIFEST = `---
name: echo
description: echoes its input back
tier: wasm
inputs:
  type: object
  properties: {}
outputs:
  type: object
  required: [echo]
---
`;

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const store = new DrizzleSkillStore();
let cached: SkillSourceCacheEntry;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  const { manifest } = expectOk(parseManifest(MANIFEST));
  cached = new SkillSourceCache(undefined).put("sha-1", { manifest, body: "" }, null);
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

/** A keyed run row at `recovery_point='executed'` holding `output`. */
async function executedRun(output: unknown): Promise<string> {
  const skill = await tx((trx) =>
    store.insertSkill(trx, {
      name: "echo",
      tier: "wasm",
      riskTier: "auto",
      effects: [],
      schedule: null,
      scheduleNextRunAt: null,
      scheduleRunAs: null,
      gitSha: "sha-1",
      lockfileHash: null,
      inputs: { type: "object", properties: {} },
      outputs: null,
    }),
  );
  const { row } = await tx((trx) =>
    store.startOrRecoverRun(trx, {
      skillId: skill.id,
      trigger: "cron",
      inputs: {},
      idempotencyKey: "skill-cron:echo:1",
    }),
  );
  await tx((trx) =>
    store.transitionToExecuted(trx, {
      id: row.id,
      output,
      error: null,
      resourceUsage: { wallClockMs: 1, peakMemoryBytes: null },
      finishedAt: new Date(),
    }),
  );
  return row.id;
}

describe("finishRun", () => {
  it("validates the executed output and finishes the row", async () => {
    const runId = await executedRun({ echo: 1 });

    const result = await finishRun(
      { store, runInTx: tx },
      { runId, skillName: "echo", cached, executed: { kind: "output", output: { echo: 1 } } },
    );

    expect(result).toEqual({ runId, status: "success", output: { echo: 1 } });
    const row = await tx((trx) => store.getRun(trx, runId));
    expect(row?.recoveryPoint).toBe("finished");
    expect(row?.status).toBe("success");
  });

  it("finishes an output failing the outputs schema as an error", async () => {
    const runId = await executedRun({ other: 1 });

    const result = await finishRun(
      { store, runInTx: tx },
      { runId, skillName: "echo", cached, executed: { kind: "output", output: { other: 1 } } },
    );

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/output failed schema validation for skill 'echo'/);
  });

  it("returns the settled result when another attempt finished the row first", async () => {
    const runId = await executedRun({ echo: 1 });
    const args = {
      runId,
      skillName: "echo",
      cached,
      executed: { kind: "output", output: { echo: 1 } },
    } as const;
    await finishRun({ store, runInTx: tx }, args);

    const second = await finishRun({ store, runInTx: tx }, args);

    expect(second).toEqual({ runId, status: "success", output: { echo: 1 } });
  });
});
