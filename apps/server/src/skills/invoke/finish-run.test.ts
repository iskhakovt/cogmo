import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { profiles, users } from "../../agent/store/schema.js";
import type { Database, Transactor } from "../../db/index.js";
import { assertStatus, expectDefined, expectOk } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { frontmatterSchemas } from "../deploy/schemas.js";
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
  cached = new SkillSourceCache(undefined).put(
    "sha-1",
    { manifest, body: "" },
    expectDefined(frontmatterSchemas(manifest), "the manifest's schemas"),
    null,
  );
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
  const [user] = await db.insert(users).values({}).returning({ id: users.id });
  const [profile] = await db
    .insert(profiles)
    .values({ userId: null, name: "default", basePrompt: "", model: "m", toolSet: [] })
    .returning({ id: profiles.id });
  const { row } = await tx((trx) =>
    store.startOrRecoverRun(trx, {
      skillId: skill.id,
      trigger: "cron",
      inputs: {},
      gitSha: "sha-1",
      runAs: {
        userId: expectDefined(user, "user").id,
        profileId: expectDefined(profile, "profile").id,
      },
      idempotencyKey: "skill-cron:echo:1",
    }),
  );
  await tx((trx) =>
    store.transitionToDispatched(trx, { id: row.id, deadlineAt: new Date(Date.now() + 90_000) }),
  );
  await tx((trx) =>
    store.transitionToExecuted(trx, {
      id: row.id,
      outcome: { kind: "output", output },
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

  it("finishes an output failing the outputs schema as output_invalid, keeping the output", async () => {
    const runId = await executedRun({ other: 1 });

    const result = await finishRun(
      { store, runInTx: tx },
      { runId, skillName: "echo", cached, executed: { kind: "output", output: { other: 1 } } },
    );

    assertStatus(result, "error");
    expect(result).toMatchObject({ errorKind: "output_invalid", output: { other: 1 } });
    expect(result.error).toMatch(/output failed schema validation for skill 'echo'/);
    const row = await tx((trx) => store.getRun(trx, runId));
    expect(row).toMatchObject({
      status: "error",
      errorKind: "output_invalid",
      output: { other: 1 },
    });
  });

  it("finishes an executed error with the kind the worker reported", async () => {
    const runId = await executedRun({ echo: 1 });
    // The row's own payload is the worker's; the verdict follows `executed`.
    const result = await finishRun(
      { store, runInTx: tx },
      {
        runId,
        skillName: "echo",
        cached,
        executed: { kind: "error", error: { kind: "wall_clock_exceeded", message: "slow" } },
      },
    );

    expect(result).toEqual({
      runId,
      status: "error",
      errorKind: "wall_clock_exceeded",
      error: "slow",
    });
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
