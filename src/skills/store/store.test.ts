import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import type { ClassifierLog, SkillInputs } from "../types.js";
import { DrizzleSkillStore, type InsertSkillParams, type SkillRow } from "./index.js";
import { skillDeploys } from "./schema.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleSkillStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleSkillStore();
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA_NEW = "fedcba9876543210fedcba9876543210fedcba98";

const INPUTS_SCHEMA: SkillInputs = {
  type: "object",
  properties: { x: { type: "integer" } },
  required: ["x"],
};

const STUB_LOG: ClassifierLog = {
  classifier_version: "stub-0",
  risk_tier: "auto",
  declared_effects: [],
  detected_effects: [],
  declared_secrets: [],
  validation_errors: [],
};

function makeSkillParams(overrides: Partial<InsertSkillParams> = {}): InsertSkillParams {
  return {
    name: "echo",
    tier: "wasm",
    riskTier: "auto",
    effects: [],
    schedule: null,
    gitSha: SHA,
    inputs: INPUTS_SCHEMA,
    outputs: null,
    ...overrides,
  };
}

async function seedSkill(overrides: Partial<InsertSkillParams> = {}): Promise<SkillRow> {
  return tx((trx) => store.insertSkill(trx, makeSkillParams(overrides)));
}

describe("DrizzleSkillStore", () => {
  describe("skills", () => {
    it("inserts a skill and round-trips JSONB through Zod", async () => {
      const row = await seedSkill();
      expect(row.name).toBe("echo");
      expect(row.tier).toBe("wasm");
      expect(row.riskTier).toBe("auto");
      expect(row.effects).toEqual([]);
      expect(row.inputs).toEqual(INPUTS_SCHEMA);
      expect(row.outputs).toBeNull();
      expect(row.disabled).toBe(false);
      expect(row.createdAt).toBeInstanceOf(Date);
    });

    it("getSkillByName / getSkillById find the inserted row", async () => {
      const row = await seedSkill();
      const byName = await tx((trx) => store.getSkillByName(trx, "echo"));
      const byId = await tx((trx) => store.getSkillById(trx, row.id));
      expect(byName?.id).toBe(row.id);
      expect(byId?.id).toBe(row.id);
    });

    it("getSkillByName returns null for an unknown name", async () => {
      expect(await tx((trx) => store.getSkillByName(trx, "nope"))).toBeUndefined();
    });

    it("listEnabledSkills excludes disabled rows and sorts by name", async () => {
      await seedSkill({ name: "zebra" });
      await seedSkill({ name: "alpha" });
      const disabled = await seedSkill({ name: "mango" });
      await tx((trx) => store.setSkillDisabled(trx, { id: disabled.id, disabled: true }));

      const live = await tx((trx) => store.listEnabledSkills(trx));
      expect(live.map((s) => s.name)).toEqual(["alpha", "zebra"]);
    });

    it("listAllSkills includes disabled rows, sorted by name", async () => {
      await seedSkill({ name: "zebra" });
      await seedSkill({ name: "alpha" });
      const disabled = await seedSkill({ name: "mango" });
      await tx((trx) => store.setSkillDisabled(trx, { id: disabled.id, disabled: true }));

      const all = await tx((trx) => store.listAllSkills(trx));
      expect(all.map((s) => ({ name: s.name, disabled: s.disabled }))).toEqual([
        { name: "alpha", disabled: false },
        { name: "mango", disabled: true },
        { name: "zebra", disabled: false },
      ]);
    });

    it("hasLiveDeployForSkill is true only when a (skillId, gitSha, status='live') row exists", async () => {
      const row = await seedSkill({ name: "echo", gitSha: SHA });
      // No deploys yet → false.
      expect(
        await tx((trx) => store.hasLiveDeployForSkill(trx, { skillId: row.id, gitSha: SHA })),
      ).toBe(false);

      // Insert a `denied` deploy at SHA → still false.
      await tx((trx) =>
        store.insertDeploy(trx, {
          skillId: row.id,
          gitSha: SHA,
          priorGitSha: null,
          riskTier: "approve",
          status: "denied",
          classifierLog: STUB_LOG,
        }),
      );
      expect(
        await tx((trx) => store.hasLiveDeployForSkill(trx, { skillId: row.id, gitSha: SHA })),
      ).toBe(false);

      // Insert a `live` deploy at SHA → true.
      await tx((trx) =>
        store.insertDeploy(trx, {
          skillId: row.id,
          gitSha: SHA,
          priorGitSha: null,
          riskTier: "auto",
          status: "live",
          classifierLog: STUB_LOG,
        }),
      );
      expect(
        await tx((trx) => store.hasLiveDeployForSkill(trx, { skillId: row.id, gitSha: SHA })),
      ).toBe(true);

      // Different sha is not matched.
      expect(
        await tx((trx) => store.hasLiveDeployForSkill(trx, { skillId: row.id, gitSha: SHA_NEW })),
      ).toBe(false);
    });

    it("updateSkillSha changes git_sha", async () => {
      const row = await seedSkill();
      await tx((trx) => store.updateSkillSha(trx, { id: row.id, gitSha: SHA_NEW }));
      const reloaded = await tx((trx) => store.getSkillById(trx, row.id));
      expect(reloaded?.gitSha).toBe(SHA_NEW);
    });

    it("rejects malformed effects on insert", async () => {
      await expect(
        tx((trx) =>
          store.insertSkill(trx, makeSkillParams({ effects: ["not_a_real_effect" as any] })),
        ),
      ).rejects.toThrow();
    });

    it("rejects duplicate name with a unique-violation error", async () => {
      await seedSkill({ name: "echo" });
      await expect(seedSkill({ name: "echo" })).rejects.toThrow();
    });

    it("setSkillDisabled toggles both directions", async () => {
      const row = await seedSkill();
      await tx((trx) => store.setSkillDisabled(trx, { id: row.id, disabled: true }));
      expect((await tx((trx) => store.getSkillById(trx, row.id)))?.disabled).toBe(true);
      await tx((trx) => store.setSkillDisabled(trx, { id: row.id, disabled: false }));
      expect((await tx((trx) => store.getSkillById(trx, row.id)))?.disabled).toBe(false);
    });

    it("updateSkillSha on missing id is a no-op (no error)", async () => {
      await expect(
        tx((trx) =>
          store.updateSkillSha(trx, {
            id: "019d0000-0000-7000-8000-000000000099",
            gitSha: SHA_NEW,
          }),
        ),
      ).resolves.toBeUndefined();
    });

    it("read-side Zod parse rejects a JSONB blob written via raw SQL with garbage shape", async () => {
      // Insert a row with intentionally bad `effects` JSONB via raw SQL,
      // bypassing the store's write-side parse. Read-side `parseSkillRow`
      // should throw — proves CLAUDE.md "Zod on read AND write" invariant.
      const row = await seedSkill();
      await db.execute(
        sql`UPDATE skills SET effects = ${'["not_a_real_effect"]'}::jsonb WHERE id = ${row.id}`,
      );
      await expect(tx((trx) => store.getSkillById(trx, row.id))).rejects.toThrow();
    });
  });

  describe("skill_deploys", () => {
    it("records a pending-approval deploy and resolves it", async () => {
      const skill = await seedSkill();
      const deploy = await tx((trx) =>
        store.insertDeploy(trx, {
          skillId: skill.id,
          gitSha: SHA,
          priorGitSha: null,
          riskTier: "approve",
          status: "pending_approval",
          classifierLog: STUB_LOG,
        }),
      );
      expect(deploy.status).toBe("pending_approval");
      expect(deploy.classifierLog.classifier_version).toBe("stub-0");

      const pending = await tx((trx) => store.getPendingDeploy(trx, skill.id));
      expect(pending?.id).toBe(deploy.id);

      const resolvedAt = new Date();
      await tx((trx) =>
        store.resolveDeploy(trx, {
          id: deploy.id,
          status: "approved",
          approvedBy: null,
          resolvedAt,
        }),
      );

      expect(await tx((trx) => store.getPendingDeploy(trx, skill.id))).toBeUndefined();
    });

    it("getPendingDeploy returns null when no pending row exists", async () => {
      const skill = await seedSkill();
      await tx((trx) =>
        store.insertDeploy(trx, {
          skillId: skill.id,
          gitSha: SHA,
          priorGitSha: null,
          riskTier: "auto",
          status: "live",
          classifierLog: STUB_LOG,
        }),
      );
      expect(await tx((trx) => store.getPendingDeploy(trx, skill.id))).toBeUndefined();
    });

    it("resolveDeploy updates approvedBy + resolvedAt", async () => {
      const skill = await seedSkill();
      const deploy = await tx((trx) =>
        store.insertDeploy(trx, {
          skillId: skill.id,
          gitSha: SHA,
          priorGitSha: null,
          riskTier: "approve",
          status: "pending_approval",
          classifierLog: STUB_LOG,
        }),
      );
      const resolvedAt = new Date("2026-04-28T12:00:00Z");
      await tx((trx) =>
        store.resolveDeploy(trx, {
          id: deploy.id,
          status: "approved",
          approvedBy: null,
          resolvedAt,
        }),
      );
      expect(await tx((trx) => store.getPendingDeploy(trx, skill.id))).toBeUndefined();
      // No public getter for skill_deploys today (P3.3 will add one); read
      // back via the schema directly to assert the audit fields landed.
      const rows = await db
        .select()
        .from(skillDeploys)
        .where(eq(skillDeploys.id, deploy.id))
        .limit(1);
      expect(rows[0]?.status).toBe("approved");
      expect(rows[0]?.resolvedAt).toBeInstanceOf(Date);
      expect(rows[0]?.approvedBy).toBeNull();
    });

    it("rejects malformed classifier_log via raw SQL on read", async () => {
      const skill = await seedSkill();
      const deploy = await tx((trx) =>
        store.insertDeploy(trx, {
          skillId: skill.id,
          gitSha: SHA,
          priorGitSha: null,
          riskTier: "auto",
          status: "live",
          classifierLog: STUB_LOG,
        }),
      );
      await db.execute(
        sql`UPDATE skill_deploys SET classifier_log = '{"junk":true}'::jsonb WHERE id = ${deploy.id}`,
      );
      // Read path eventually hits ClassifierLogSchema.parse — getPendingDeploy
      // doesn't fetch live rows, so we trigger via a fresh getPendingDeploy
      // for a new pending deploy row that's been similarly mutated.
      const pending = await tx((trx) =>
        store.insertDeploy(trx, {
          skillId: skill.id,
          gitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          priorGitSha: null,
          riskTier: "approve",
          status: "pending_approval",
          classifierLog: STUB_LOG,
        }),
      );
      await db.execute(
        sql`UPDATE skill_deploys SET classifier_log = '{"junk":true}'::jsonb WHERE id = ${pending.id}`,
      );
      await expect(tx((trx) => store.getPendingDeploy(trx, skill.id))).rejects.toThrow();
    });
  });

  describe("skill_runs and skill_context_calls", () => {
    it("inserts a run, updates terminal status, records context calls", async () => {
      const skill = await seedSkill();
      const run = await tx((trx) =>
        store.insertRun(trx, {
          skillId: skill.id,
          trigger: "manual",
          inputs: { x: 7 },
        }),
      );
      expect(run.status).toBe("running");
      expect(run.inputs).toEqual({ x: 7 });
      expect(run.finishedAt).toBeNull();

      await tx((trx) =>
        store.recordContextCall(trx, {
          runId: run.id,
          method: "secrets.get",
          target: "slack_webhook",
          ok: true,
          error: null,
        }),
      );
      await tx((trx) =>
        store.recordContextCall(trx, {
          runId: run.id,
          method: "now",
          target: null,
          ok: true,
          error: null,
        }),
      );

      const calls = await tx((trx) => store.listContextCallsForRun(trx, run.id));
      expect(calls).toHaveLength(2);
      expect(calls[0]?.method).toBe("secrets.get");
      expect(calls[0]?.target).toBe("slack_webhook");
      expect(calls[1]?.target).toBeNull();

      await tx((trx) =>
        store.updateRunResult(trx, {
          id: run.id,
          status: "success",
          output: { echo: 8 },
          error: null,
          finishedAt: new Date(),
        }),
      );

      const reloaded = await tx((trx) => store.getRun(trx, run.id));
      expect(reloaded?.status).toBe("success");
      expect(reloaded?.output).toEqual({ echo: 8 });
      expect(reloaded?.finishedAt).toBeInstanceOf(Date);
    });

    it("records an error result with null output", async () => {
      const skill = await seedSkill();
      const run = await tx((trx) =>
        store.insertRun(trx, {
          skillId: skill.id,
          trigger: "manual",
          inputs: {},
        }),
      );
      await tx((trx) =>
        store.updateRunResult(trx, {
          id: run.id,
          status: "error",
          output: null,
          error: "Boom",
          finishedAt: new Date(),
        }),
      );
      const reloaded = await tx((trx) => store.getRun(trx, run.id));
      expect(reloaded?.status).toBe("error");
      expect(reloaded?.output).toBeNull();
      expect(reloaded?.error).toBe("Boom");
    });

    it("recordContextCall round-trips with null target", async () => {
      const skill = await seedSkill();
      const run = await tx((trx) =>
        store.insertRun(trx, {
          skillId: skill.id,
          trigger: "manual",
          inputs: {},
        }),
      );
      await tx((trx) =>
        store.recordContextCall(trx, {
          runId: run.id,
          method: "now",
          target: null,
          ok: true,
          error: null,
        }),
      );
      const calls = await tx((trx) => store.listContextCallsForRun(trx, run.id));
      expect(calls).toHaveLength(1);
      expect(calls[0]?.target).toBeNull();
    });

    it("listContextCallsForRun preserves ASC created_at ordering", async () => {
      const skill = await seedSkill();
      const run = await tx((trx) =>
        store.insertRun(trx, {
          skillId: skill.id,
          trigger: "manual",
          inputs: {},
        }),
      );
      const methods = ["now", "user", "log.info", "secrets.get", "memory.recall"] as const;
      for (const method of methods) {
        await tx((trx) =>
          store.recordContextCall(trx, {
            runId: run.id,
            method,
            target: null,
            ok: true,
            error: null,
          }),
        );
      }
      const calls = await tx((trx) => store.listContextCallsForRun(trx, run.id));
      expect(calls.map((c) => c.method)).toEqual([...methods]);
    });

    it("rejects null/undefined inputs (skill_runs.inputs is NOT NULL)", async () => {
      const skill = await seedSkill();
      await expect(
        tx((trx) =>
          store.insertRun(trx, {
            skillId: skill.id,
            trigger: "manual",
            inputs: null as any,
          }),
        ),
      ).rejects.toThrow(/inputs must not be null/);
      await expect(
        tx((trx) =>
          store.insertRun(trx, {
            skillId: skill.id,
            trigger: "manual",
            inputs: undefined as any,
          }),
        ),
      ).rejects.toThrow(/inputs must not be null/);
    });

    it("output:null on updateRunResult round-trips correctly", async () => {
      const skill = await seedSkill();
      const run = await tx((trx) =>
        store.insertRun(trx, {
          skillId: skill.id,
          trigger: "manual",
          inputs: {},
        }),
      );
      await tx((trx) =>
        store.updateRunResult(trx, {
          id: run.id,
          status: "success",
          output: null,
          error: null,
          finishedAt: new Date(),
        }),
      );
      const after = await tx((trx) => store.getRun(trx, run.id));
      expect(after?.output).toBeNull();
    });
  });

  describe("triggers enum coverage", () => {
    it.each(["manual", "cron", "event"] as const)("accepts trigger=%s", async (trigger) => {
      const skill = await seedSkill({ name: `t-${trigger}` });
      const run = await tx((trx) =>
        store.insertRun(trx, {
          skillId: skill.id,
          trigger,
          inputs: {},
        }),
      );
      const reloaded = await tx((trx) => store.getRun(trx, run.id));
      expect(reloaded?.trigger).toBe(trigger);
    });
  });
});
