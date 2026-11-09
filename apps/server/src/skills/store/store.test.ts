import { eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { profiles, users } from "../../agent/store/schema.js";
import type { Database, Transaction, Transactor } from "../../db/index.js";
import { assertKind, expectDefined } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { channels, userIdentities } from "../../transport/store/schema.js";
import type { ClassifierLog, SkillInputs, SkillSchemas } from "../types.js";
import {
  DrizzleSkillStore,
  type ExecuteRegisterParams,
  type InsertDeployParams,
  type InsertSkillParams,
  type NewRunParams,
  type SkillRow,
  type SkillRunIdentity,
} from "./index.js";
import { skillDeploys, skillRuns, skills } from "./schema.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleSkillStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleSkillStore();
});

/** Install owner + default profile, seeded fresh for every test. */
let owner: SkillRunIdentity;

async function seedIdentity(name: string): Promise<SkillRunIdentity> {
  const [user] = await db.insert(users).values({}).returning({ id: users.id });
  const [profile] = await db
    .insert(profiles)
    .values({ userId: null, name, basePrompt: "", model: "m", toolSet: [] })
    .returning({ id: profiles.id });
  return { userId: expectDefined(user, "user").id, profileId: expectDefined(profile, name).id };
}

/** The owner's identity on a fresh telegram channel, as `approved_by` references it. */
async function seedUserIdentity(): Promise<string> {
  const [channel] = await db
    .insert(channels)
    .values({ type: "telegram", credentials: {}, identityMode: "mapped" })
    .returning({ id: channels.id });
  const [identity] = await db
    .insert(userIdentities)
    .values({
      userId: owner.userId,
      channelId: expectDefined(channel, "channel").id,
      platformHandle: "tg-approver",
      isWildcard: false,
      autoCreated: false,
    })
    .returning({ id: userIdentities.id });
  return expectDefined(identity, "identity").id;
}

beforeEach(async () => {
  owner = await seedIdentity("default");
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA_NEW = "fedcba9876543210fedcba9876543210fedcba98";
const SHA_EDIT = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const SHA_THIRD = "1111111111111111111111111111111111111111";

/** The audit columns every new run records: the skill's sha and the owner as run-as. */
function audit(): Pick<NewRunParams, "gitSha" | "runAs"> {
  return { gitSha: SHA, runAs: owner };
}

/** A deadline well past any test's clock. */
const DEADLINE = new Date("2099-01-01T00:00:00Z");

/** Move a `started` run to `dispatched`, as a runtime does before it sends the task. */
async function dispatch(id: string): Promise<void> {
  expect(
    await tx((trx) => store.transitionToDispatched(trx, { id, deadlineAt: DEADLINE })),
  ).toEqual({
    kind: "dispatched",
  });
}

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
  declared_dependencies: [],
  validation_errors: [],
  reasons: [],
  declared_network: null,
  toolchain_version: null,
};

const STUB_SCHEMAS: SkillSchemas = { inputs: { type: "object" }, outputs: null };

function makeSkillParams(overrides: Partial<InsertSkillParams> = {}): InsertSkillParams {
  return {
    name: "echo",
    tier: "wasm",
    riskTier: "auto",
    effects: [],
    schedule: null,
    scheduleNextRunAt: null,
    gitSha: SHA,
    lockfileHash: null,
    inputs: INPUTS_SCHEMA,
    outputs: null,
    scheduleRunAs: overrides.schedule ? owner : null,
    ...overrides,
  };
}

async function seedSkill(overrides: Partial<InsertSkillParams> = {}): Promise<SkillRow> {
  return tx((trx) => store.insertSkill(trx, makeSkillParams(overrides)));
}

/** A notify-tier, unscheduled `echo` at `SHA`, deployed by the owner. */
function executeRegisterParams(
  overrides: Partial<ExecuteRegisterParams> = {},
): ExecuteRegisterParams {
  return {
    name: "echo",
    tier: "wasm",
    riskTier: "notify",
    effects: [],
    schedule: null,
    scheduleNextRunAt: null,
    branchTipSha: SHA,
    lockfileHash: null,
    inputs: INPUTS_SCHEMA,
    outputs: null,
    classifierLog: STUB_LOG,
    runAs: owner,
    applyFilesystem: async () => {},
    ...overrides,
  };
}

/** The mirror singleton, `behind` at `localSha`. */
async function seedMirror(localSha: string): Promise<void> {
  await tx(async (trx) => {
    await store.ensureMirror(trx);
    await store.markMainAdvanced(trx, localSha);
  });
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
      await tx((trx) => store.disableSkill(trx, disabled.id));

      const live = await tx((trx) => store.listEnabledSkills(trx));
      expect(live.map((s) => s.name)).toEqual(["alpha", "zebra"]);
    });

    it("listAllSkills includes disabled rows, sorted by name", async () => {
      await seedSkill({ name: "zebra" });
      await seedSkill({ name: "alpha" });
      const disabled = await seedSkill({ name: "mango" });
      await tx((trx) => store.disableSkill(trx, disabled.id));

      const all = await tx((trx) => store.listAllSkills(trx));
      expect(all.map((s) => ({ name: s.name, disabled: s.disabled }))).toEqual([
        { name: "alpha", disabled: false },
        { name: "mango", disabled: true },
        { name: "zebra", disabled: false },
      ]);
    });

    it("liveDeploySchemas reads the latest deploy of the sha that went live and recorded schemas", async () => {
      const row = await seedSkill({ name: "echo", gitSha: SHA });
      const schemasOf = (title: string): SkillSchemas => ({
        inputs: { type: "object", title },
        outputs: null,
      });
      const insert = (
        status: InsertDeployParams["status"],
        schemas: SkillSchemas,
        gitSha: string,
      ) =>
        tx((trx) =>
          store.insertDeploy(trx, {
            skillId: row.id,
            gitSha,
            priorGitSha: null,
            riskTier: "auto",
            status,
            classifierLog: STUB_LOG,
            schemas,
            resolvedAt: status === "pending_approval" ? null : new Date(),
          }),
        );
      const read = (name: string) =>
        tx((trx) => store.liveDeploySchemas(trx, { name, gitSha: SHA }));

      await insert("denied", schemasOf("denied"), SHA);
      await insert("pending_approval", schemasOf("pending"), SHA);
      expect(await read("echo")).toBeNull();

      await insert("live", schemasOf("live"), SHA);
      const rolledBack = await insert("live", schemasOf("rolled back"), SHA);
      await db.execute(
        sql`UPDATE skill_deploys SET status = 'rolled_back', restores_git_sha = ${SHA} WHERE id = ${rolledBack.id}`,
      );
      await insert("live", schemasOf("other sha"), "b".repeat(40));
      expect(await read("echo")).toEqual(schemasOf("rolled back"));
      expect(await read("other-skill")).toBeNull();

      // A row from before the column records none.
      await db.execute(sql`UPDATE skill_deploys SET schemas = NULL WHERE id = ${rolledBack.id}`);
      expect(await read("echo")).toEqual(schemasOf("live"));
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
          schemas: STUB_SCHEMAS,
          resolvedAt: new Date(),
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
          schemas: STUB_SCHEMAS,
          resolvedAt: new Date(),
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

    it("hasLiveDeployForSkill accepts a rolled_back row whose target went live, and only that", async () => {
      const row = await seedSkill({ name: "echo", gitSha: SHA });
      const guard = (gitSha: string) =>
        tx((trx) => store.hasLiveDeployForSkill(trx, { skillId: row.id, gitSha }));
      const rollback = (restoring: string, restores: string) =>
        tx((trx) =>
          store.executeRollback(trx, {
            ...executeRegisterParams({}),
            restoringGitSha: restoring,
            restoresGitSha: restores,
            expectedLiveSha: null,
          }),
        );
      await tx((trx) =>
        store.insertDeploy(trx, {
          skillId: row.id,
          gitSha: SHA_NEW,
          priorGitSha: null,
          riskTier: "auto",
          status: "live",
          classifierLog: STUB_LOG,
          schemas: STUB_SCHEMAS,
          resolvedAt: new Date(),
        }),
      );

      // A restoring commit for a target that went live passes.
      await rollback(SHA_EDIT, SHA_NEW);
      expect(await guard(SHA_EDIT)).toBe(true);
      // One for a target that never did is refused.
      await rollback(SHA_THIRD, SHA);
      expect(await guard(SHA_THIRD)).toBe(false);
    });

    it("executeRollback refuses, writing nothing, when the skill is no longer at the expected live sha", async () => {
      const row = await seedSkill({ name: "echo", gitSha: SHA_NEW });
      let moved = false;

      const result = await tx((trx) =>
        store.executeRollback(trx, {
          ...executeRegisterParams({}),
          restoringGitSha: SHA_EDIT,
          restoresGitSha: SHA,
          expectedLiveSha: SHA,
          applyFilesystem: async () => {
            moved = true;
          },
        }),
      );

      expect(result).toEqual({ kind: "live_version_moved" });
      expect(moved).toBe(false);
      expect((await tx((trx) => store.getSkillById(trx, row.id)))?.gitSha).toBe(SHA_NEW);
      expect(await tx((trx) => store.hasDeployAt(trx, SHA_EDIT))).toBe(false);
    });

    it("restoredTargetAt names a rolled_back row's target, and hasDeployAt any row's sha", async () => {
      await seedSkill({ name: "echo", gitSha: SHA });
      await tx((trx) =>
        store.executeRollback(trx, {
          ...executeRegisterParams({}),
          restoringGitSha: SHA_EDIT,
          restoresGitSha: SHA_NEW,
          expectedLiveSha: null,
        }),
      );

      expect(
        await tx((trx) => store.restoredTargetAt(trx, { name: "echo", gitSha: SHA_EDIT })),
      ).toBe(SHA_NEW);
      expect(
        await tx((trx) => store.restoredTargetAt(trx, { name: "echo", gitSha: SHA_NEW })),
      ).toBeNull();
      expect(
        await tx((trx) => store.restoredTargetAt(trx, { name: "other", gitSha: SHA_EDIT })),
      ).toBeNull();
      expect(await tx((trx) => store.hasDeployAt(trx, SHA_EDIT))).toBe(true);
      expect(await tx((trx) => store.hasDeployAt(trx, SHA_THIRD))).toBe(false);
    });

    it("mirror state: inserts the singleton once, behind with no sha, and leaves a present row", async () => {
      expect(await tx((trx) => store.getMirror(trx))).toBeNull();
      expect(await tx((trx) => store.lockMirror(trx))).toBe(false);
      await tx((trx) => store.ensureMirror(trx));
      expect(await tx((trx) => store.lockMirror(trx))).toBe(true);
      expect(await tx((trx) => store.getMirror(trx))).toEqual({
        status: "behind",
        localSha: null,
        pushedSha: null,
        lastFailure: null,
      });
      await tx((trx) => store.markMainAdvanced(trx, SHA));
      await tx((trx) => store.ensureMirror(trx));
      expect(await tx((trx) => store.getMirror(trx))).toEqual({
        status: "behind",
        localSha: SHA,
        pushedSha: null,
        lastFailure: null,
      });
    });

    it("mirror state: a landed push of local_sha syncs, and an advance makes it behind again", async () => {
      await seedMirror(SHA);
      // A push of another sha leaves it behind.
      expect(await tx((trx) => store.recordMirrorLanded(trx, SHA_NEW))).toBe(false);
      await tx((trx) => store.recordMirrorFailed(trx, "unreachable"));
      expect(await tx((trx) => store.recordMirrorLanded(trx, SHA))).toBe(true);
      expect(await tx((trx) => store.getMirror(trx))).toEqual({
        status: "synced",
        localSha: SHA,
        pushedSha: SHA,
        lastFailure: null,
      });

      await tx((trx) => store.markMainAdvanced(trx, SHA_NEW));
      expect(await tx((trx) => store.getMirror(trx))).toMatchObject({
        status: "behind",
        localSha: SHA_NEW,
        pushedSha: SHA,
      });
    });

    it("mirror state: marking main advanced to the sha the row already holds changes nothing", async () => {
      await seedMirror(SHA);
      await tx((trx) => store.recordMirrorLanded(trx, SHA));
      await tx((trx) => store.markMainAdvanced(trx, SHA));
      expect(await tx((trx) => store.getMirror(trx))).toMatchObject({
        status: "synced",
        localSha: SHA,
      });
    });

    it("mirror state: a failed push keeps behind with its cause; a synced row records none", async () => {
      await seedMirror(SHA);
      await tx((trx) => store.recordMirrorFailed(trx, "auth"));
      expect(await tx((trx) => store.getMirror(trx))).toMatchObject({
        status: "behind",
        lastFailure: "auth",
      });
      await tx((trx) => store.recordMirrorLanded(trx, SHA));
      await tx((trx) => store.recordMirrorFailed(trx, "timeout"));
      expect(await tx((trx) => store.getMirror(trx))).toMatchObject({
        status: "synced",
        lastFailure: null,
      });
    });

    it("mirror state: diverged returns to behind only at the local_sha it was read at", async () => {
      await seedMirror(SHA);
      expect(await tx((trx) => store.recordMirrorBehind(trx, SHA))).toBe(false);
      await tx((trx) => store.recordMirrorDiverged(trx));
      expect(await tx((trx) => store.recordMirrorBehind(trx, SHA_NEW))).toBe(false);
      expect(await tx((trx) => store.recordMirrorBehind(trx, SHA))).toBe(true);
      expect(await tx((trx) => store.getMirror(trx))).toEqual({
        status: "behind",
        localSha: SHA,
        pushedSha: null,
        lastFailure: null,
      });
    });

    it("mirror state: diverged is entered once from behind, kept by an advance, and left by a landed push", async () => {
      await seedMirror(SHA);
      expect(await tx((trx) => store.recordMirrorDiverged(trx))).toBe(true);
      expect(await tx((trx) => store.recordMirrorDiverged(trx))).toBe(false);
      await tx((trx) => store.markMainAdvanced(trx, SHA_NEW));
      expect(await tx((trx) => store.getMirror(trx))).toEqual({
        status: "diverged",
        localSha: SHA_NEW,
        pushedSha: null,
        lastFailure: "rejected",
      });

      expect(await tx((trx) => store.recordMirrorLanded(trx, SHA_NEW))).toBe(true);
      expect(await tx((trx) => store.getMirror(trx))).toMatchObject({
        status: "synced",
        lastFailure: null,
      });
    });

    it("records the layout commit once, and forgets it", async () => {
      expect(await tx((trx) => store.getLayoutCommitSha(trx))).toBeNull();
      expect(await tx((trx) => store.recordLayoutCommit(trx, SHA))).toBe(SHA);
      expect(await tx((trx) => store.getLayoutCommitSha(trx))).toBe(SHA);
      // The singleton keeps the first: a second insert meets it in the conflict arm.
      expect(await tx((trx) => store.recordLayoutCommit(trx, SHA_NEW))).toBe(SHA);
      expect(await tx((trx) => store.getLayoutCommitSha(trx))).toBe(SHA);
      await tx((trx) => store.forgetLayoutCommit(trx));
      expect(await tx((trx) => store.getLayoutCommitSha(trx))).toBeNull();
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

    it("disableSkill / enableSkill toggle both directions", async () => {
      const row = await seedSkill();
      await tx((trx) => store.disableSkill(trx, row.id));
      expect((await tx((trx) => store.getSkillById(trx, row.id)))?.disabled).toBe(true);
      await tx((trx) => store.enableSkill(trx, { id: row.id, runAs: owner }));
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
      // should throw — proves the "Zod on read AND write" invariant
      // (`architecture-rules.md`).
      const row = await seedSkill();
      await db.execute(
        sql`UPDATE skills SET effects = ${'["not_a_real_effect"]'}::jsonb WHERE id = ${row.id}`,
      );
      await expect(tx((trx) => store.getSkillById(trx, row.id))).rejects.toThrow();
    });
  });

  describe("skill_deploys", () => {
    it("records a pending-approval deploy and finds it", async () => {
      const skill = await seedSkill();
      const deploy = await tx((trx) =>
        store.insertDeploy(trx, {
          skillId: skill.id,
          gitSha: SHA,
          priorGitSha: null,
          riskTier: "approve",
          status: "pending_approval",
          classifierLog: STUB_LOG,
          schemas: STUB_SCHEMAS,
          resolvedAt: null,
        }),
      );
      expect(deploy.status).toBe("pending_approval");
      expect(deploy.resolvedAt).toBeNull();
      expect(deploy.classifierLog.classifier_version).toBe("stub-0");

      const pending = await tx((trx) => store.getPendingDeploy(trx, skill.id));
      expect(pending?.id).toBe(deploy.id);

      await tx((trx) => store.denyPendingDeploy(trx, { pendingId: deploy.id }));
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
          schemas: STUB_SCHEMAS,
          resolvedAt: new Date(),
        }),
      );
      expect(await tx((trx) => store.getPendingDeploy(trx, skill.id))).toBeUndefined();
    });

    function deployParams(
      skillId: string,
      status: InsertDeployParams["status"],
      resolvedAt: Date | null,
    ): InsertDeployParams {
      return {
        skillId,
        gitSha: SHA,
        priorGitSha: null,
        riskTier: "approve",
        status,
        classifierLog: STUB_LOG,
        schemas: STUB_SCHEMAS,
        resolvedAt,
      };
    }

    it("listPendingDeploys returns every pending row oldest first, and drops a resolved one", async () => {
      const first = await seedSkill({ name: "first" });
      const second = await seedSkill({ name: "second" });
      const firstPending = await tx((trx) =>
        store.insertDeploy(trx, deployParams(first.id, "pending_approval", null)),
      );
      const secondPending = await tx((trx) =>
        store.insertDeploy(trx, {
          ...deployParams(second.id, "pending_approval", null),
          gitSha: SHA_NEW,
        }),
      );
      await tx((trx) => store.insertDeploy(trx, deployParams(first.id, "live", new Date())));

      const pending = await tx((trx) => store.listPendingDeploys(trx));
      expect(pending.map((d) => [d.id, d.skillId, d.gitSha])).toEqual([
        [firstPending.id, first.id, SHA],
        [secondPending.id, second.id, SHA_NEW],
      ]);

      await tx((trx) => store.denyPendingDeploy(trx, { pendingId: firstPending.id }));
      const afterDeny = await tx((trx) => store.listPendingDeploys(trx));
      expect(afterDeny.map((d) => d.id)).toEqual([secondPending.id]);
    });

    it("listPendingDeploys returns nothing when no deploy is pending", async () => {
      const skill = await seedSkill();
      await tx((trx) => store.insertDeploy(trx, deployParams(skill.id, "live", new Date())));
      expect(await tx((trx) => store.listPendingDeploys(trx))).toEqual([]);
    });

    it("the CHECK refuses a terminal row without resolved_at and a pending row with one", async () => {
      const skill = await seedSkill();
      await expect(
        tx((trx) => store.insertDeploy(trx, deployParams(skill.id, "live", null))),
      ).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/chk_skill_deploys_resolved_at_iff_terminal/) },
      });
      await expect(
        tx((trx) =>
          store.insertDeploy(trx, deployParams(skill.id, "pending_approval", new Date())),
        ),
      ).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/chk_skill_deploys_resolved_at_iff_terminal/) },
      });
    });

    it("the CHECK refuses approved_by on a row that is not live", async () => {
      const skill = await seedSkill();
      const approver = await seedUserIdentity();
      const denied = await tx((trx) =>
        store.insertDeploy(trx, deployParams(skill.id, "denied", new Date())),
      );
      await expect(
        db.update(skillDeploys).set({ approvedBy: approver }).where(eq(skillDeploys.id, denied.id)),
      ).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/chk_skill_deploys_approved_by_only_live/) },
      });
      const live = await tx((trx) =>
        store.insertDeploy(trx, deployParams(skill.id, "live", new Date())),
      );
      await db
        .update(skillDeploys)
        .set({ approvedBy: approver })
        .where(eq(skillDeploys.id, live.id));
      expect((await tx((trx) => store.getDeployById(trx, live.id)))?.approvedBy).toBe(approver);
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
          schemas: STUB_SCHEMAS,
          resolvedAt: new Date(),
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
          schemas: STUB_SCHEMAS,
          resolvedAt: null,
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
          ...audit(),
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

      await dispatch(run.id);

      await tx((trx) =>
        store.transitionToExecuted(trx, {
          id: run.id,
          outcome: { kind: "output", output: { echo: 8 } },
          resourceUsage: { wallClockMs: 42, peakMemoryBytes: 1_048_576 },
          finishedAt: new Date(),
        }),
      );
      await tx((trx) =>
        store.transitionToFinished(trx, {
          id: run.id,
          verdict: { status: "success", output: { echo: 8 } },
        }),
      );

      const reloaded = await tx((trx) => store.getRun(trx, run.id));
      expect(reloaded?.status).toBe("success");
      expect(reloaded?.output).toEqual({ echo: 8 });
      expect(reloaded?.finishedAt).toBeInstanceOf(Date);
      expect(reloaded?.resourceUsage).toEqual({ wallClockMs: 42, peakMemoryBytes: 1_048_576 });
    });

    it("records an error result with null output", async () => {
      const skill = await seedSkill();
      const run = await tx((trx) =>
        store.insertRun(trx, {
          ...audit(),
          skillId: skill.id,
          trigger: "manual",
          inputs: {},
        }),
      );
      await dispatch(run.id);
      await tx((trx) =>
        store.transitionToExecuted(trx, {
          id: run.id,
          outcome: { kind: "error", error: { kind: "skill_raised", message: "Boom" } },
          resourceUsage: { wallClockMs: 7, peakMemoryBytes: null },
          finishedAt: new Date(),
        }),
      );
      await tx((trx) =>
        store.transitionToFinished(trx, {
          id: run.id,
          verdict: { status: "error", error: { kind: "skill_raised", message: "Boom" } },
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
          ...audit(),
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
          ...audit(),
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
            ...audit(),
            skillId: skill.id,
            trigger: "manual",
            inputs: null as any,
          }),
        ),
      ).rejects.toThrow(/inputs must not be null/);
      await expect(
        tx((trx) =>
          store.insertRun(trx, {
            ...audit(),
            skillId: skill.id,
            trigger: "manual",
            inputs: undefined as any,
          }),
        ),
      ).rejects.toThrow(/inputs must not be null/);
    });

    it("output:null on transitionToFinished round-trips correctly", async () => {
      const skill = await seedSkill();
      const run = await tx((trx) =>
        store.insertRun(trx, {
          ...audit(),
          skillId: skill.id,
          trigger: "manual",
          inputs: {},
        }),
      );
      await dispatch(run.id);
      await tx((trx) =>
        store.transitionToExecuted(trx, {
          id: run.id,
          outcome: { kind: "output", output: null },
          resourceUsage: { wallClockMs: 1, peakMemoryBytes: null },
          finishedAt: new Date(),
        }),
      );
      await tx((trx) =>
        store.transitionToFinished(trx, {
          id: run.id,
          verdict: { status: "success", output: null },
        }),
      );
      const after = await tx((trx) => store.getRun(trx, run.id));
      expect(after?.output).toBeNull();
    });
  });

  describe("resource_usage round-trip", () => {
    it("insertRun starts with resourceUsage=null (status='running')", async () => {
      const skill = await seedSkill();
      const run = await tx((trx) =>
        store.insertRun(trx, {
          ...audit(),
          skillId: skill.id,
          trigger: "manual",
          inputs: {},
        }),
      );
      expect(run.resourceUsage).toBeNull();
      expect(run.status).toBe("running");
    });

    it("transitionToExecuted persists both wall-clock and peak-memory", async () => {
      const skill = await seedSkill();
      const run = await tx((trx) =>
        store.insertRun(trx, {
          ...audit(),
          skillId: skill.id,
          trigger: "cron",
          inputs: {},
        }),
      );
      await dispatch(run.id);
      await tx((trx) =>
        store.transitionToExecuted(trx, {
          id: run.id,
          outcome: { kind: "output", output: { ok: true } },
          resourceUsage: { wallClockMs: 123, peakMemoryBytes: 5_242_880 },
          finishedAt: new Date(),
        }),
      );
      const reloaded = await tx((trx) => store.getRun(trx, run.id));
      expect(reloaded?.resourceUsage).toEqual({ wallClockMs: 123, peakMemoryBytes: 5_242_880 });
    });

    it("transitionToExecuted tolerates peakMemoryBytes=null (wasm / timeout paths)", async () => {
      const skill = await seedSkill();
      const run = await tx((trx) =>
        store.insertRun(trx, {
          ...audit(),
          skillId: skill.id,
          trigger: "manual",
          inputs: {},
        }),
      );
      await dispatch(run.id);
      await tx((trx) =>
        store.transitionToExecuted(trx, {
          id: run.id,
          outcome: {
            kind: "error",
            error: { kind: "wall_clock_exceeded", message: "wall_clock_exceeded" },
          },
          resourceUsage: { wallClockMs: 30_000, peakMemoryBytes: null },
          finishedAt: new Date(),
        }),
      );
      const reloaded = await tx((trx) => store.getRun(trx, run.id));
      expect(reloaded?.resourceUsage).toEqual({ wallClockMs: 30_000, peakMemoryBytes: null });
    });

    it("rejects negative wallClockMs at the Zod boundary", async () => {
      const skill = await seedSkill();
      const run = await tx((trx) =>
        store.insertRun(trx, {
          ...audit(),
          skillId: skill.id,
          trigger: "manual",
          inputs: {},
        }),
      );
      // Negative wallClockMs passes TypeScript (z.number().int() is just `number`
      // at the type level) but Zod rejects at the store boundary.
      await dispatch(run.id);
      await expect(
        tx((trx) =>
          store.transitionToExecuted(trx, {
            id: run.id,
            outcome: { kind: "output", output: null },
            resourceUsage: { wallClockMs: -1, peakMemoryBytes: null },
            finishedAt: new Date(),
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe("triggers enum coverage", () => {
    it.each(["manual", "cron", "event"] as const)("accepts trigger=%s", async (trigger) => {
      const skill = await seedSkill({ name: `t-${trigger}` });
      const run = await tx((trx) =>
        store.insertRun(trx, {
          ...audit(),
          skillId: skill.id,
          trigger,
          inputs: {},
        }),
      );
      const reloaded = await tx((trx) => store.getRun(trx, run.id));
      expect(reloaded?.trigger).toBe(trigger);
    });
  });

  describe("schedule / next_run_at invariant", () => {
    it("inserts a scheduled skill with both schedule and next_run_at set", async () => {
      const nra = new Date("2026-06-01T09:00:00Z");
      const row = await seedSkill({
        name: "cron-skill",
        schedule: "0 9 * * *",
        scheduleNextRunAt: nra,
      });
      expect(row.schedule).toBe("0 9 * * *");
      expect(row.nextRunAt?.toISOString()).toBe(nra.toISOString());
      expect(row.lastFiredAt).toBeNull();
    });

    it("rejects schedule set without scheduleNextRunAt at the store boundary", async () => {
      await expect(
        tx((trx) =>
          store.insertSkill(
            trx,
            makeSkillParams({ schedule: "0 9 * * *", scheduleNextRunAt: null }),
          ),
        ),
      ).rejects.toThrow(/schedule and scheduleNextRunAt must agree/);
    });

    it("rejects scheduleNextRunAt set without schedule at the store boundary", async () => {
      await expect(
        tx((trx) =>
          store.insertSkill(
            trx,
            makeSkillParams({ schedule: null, scheduleNextRunAt: new Date() }),
          ),
        ),
      ).rejects.toThrow(/schedule and scheduleNextRunAt must agree/);
    });
  });

  describe("lockDueScheduledSkills + advanceSkillSchedule", () => {
    it("returns nothing when no rows are due", async () => {
      await seedSkill({
        name: "future",
        schedule: "0 9 * * *",
        scheduleNextRunAt: new Date("2099-01-01T00:00:00Z"),
      });
      const due = await tx((trx) =>
        store.lockDueScheduledSkills(trx, {
          now: new Date("2026-06-01T09:00:00Z"),
          limit: 10,
        }),
      );
      expect(due).toEqual([]);
    });

    it("locks due rows in next_run_at order", async () => {
      const a = await seedSkill({
        name: "later",
        schedule: "30 9 * * *",
        scheduleNextRunAt: new Date("2026-06-01T08:30:00Z"),
      });
      const b = await seedSkill({
        name: "earlier",
        schedule: "0 8 * * *",
        scheduleNextRunAt: new Date("2026-06-01T08:00:00Z"),
      });
      const due = await tx((trx) =>
        store.lockDueScheduledSkills(trx, {
          now: new Date("2026-06-01T09:00:00Z"),
          limit: 10,
        }),
      );
      expect(due.map((r) => r.id)).toEqual([b.id, a.id]);
    });

    it("skips disabled rows", async () => {
      const row = await seedSkill({
        name: "disabled-scheduled",
        schedule: "0 9 * * *",
        scheduleNextRunAt: new Date("2026-06-01T09:00:00Z"),
      });
      await tx((trx) => store.disableSkill(trx, row.id));
      const due = await tx((trx) =>
        store.lockDueScheduledSkills(trx, {
          now: new Date("2026-06-01T10:00:00Z"),
          limit: 10,
        }),
      );
      expect(due).toEqual([]);
    });

    it("skips rows with null schedule (defense in depth — partial index already filters)", async () => {
      await seedSkill({ name: "unscheduled", schedule: null, scheduleNextRunAt: null });
      const due = await tx((trx) =>
        store.lockDueScheduledSkills(trx, {
          now: new Date("2026-06-01T10:00:00Z"),
          limit: 10,
        }),
      );
      expect(due).toEqual([]);
    });

    it("honours the limit cap", async () => {
      for (let i = 0; i < 3; i++) {
        await seedSkill({
          name: `s${i}`,
          schedule: "0 9 * * *",
          scheduleNextRunAt: new Date(`2026-06-0${i + 1}T09:00:00Z`),
        });
      }
      const due = await tx((trx) =>
        store.lockDueScheduledSkills(trx, {
          now: new Date("2026-07-01T00:00:00Z"),
          limit: 2,
        }),
      );
      expect(due).toHaveLength(2);
    });

    it("advanceSkillSchedule writes both last_fired_at and next_run_at", async () => {
      const row = await seedSkill({
        name: "advancing",
        schedule: "0 9 * * *",
        scheduleNextRunAt: new Date("2026-06-01T09:00:00Z"),
      });
      const lastFiredAt = new Date("2026-06-01T09:00:00Z");
      const nextRunAt = new Date("2026-06-02T09:00:00Z");
      await tx((trx) => store.advanceSkillSchedule(trx, row.id, { lastFiredAt, nextRunAt }));
      const after = await tx((trx) => store.getSkillById(trx, row.id));
      expect(after?.lastFiredAt?.toISOString()).toBe(lastFiredAt.toISOString());
      expect(after?.nextRunAt?.toISOString()).toBe(nextRunAt.toISOString());
    });
  });

  describe("startOrRecoverRun + recovery_point transitions", () => {
    it("kind='new' on first call; row starts in recovery_point='started'", async () => {
      const skill = await seedSkill({ name: "with-key" });
      const result = await tx((trx) =>
        store.startOrRecoverRun(trx, {
          ...audit(),
          skillId: skill.id,
          trigger: "cron",
          inputs: { x: 1 },
          idempotencyKey: "skill-cron:abc:2026-06-01T09:00:00.000Z",
        }),
      );
      expect(result.kind).toBe("new");
      expect(result.row.recoveryPoint).toBe("started");
      expect(result.row.idempotencyKey).toBe("skill-cron:abc:2026-06-01T09:00:00.000Z");
      expect(result.row.status).toBe("running");
      expect(result.row.resourceUsage).toBeNull();
    });

    it("getRunByIdempotencyKey finds the keyed row and nothing for an unused key", async () => {
      const skill = await seedSkill({ name: "with-key" });
      const { row } = await tx((trx) =>
        store.startOrRecoverRun(trx, {
          ...audit(),
          skillId: skill.id,
          trigger: "cron",
          inputs: { x: 1 },
          idempotencyKey: "skill-cron:abc:lookup",
        }),
      );
      await tx((trx) =>
        store.insertRun(trx, {
          ...audit(),
          skillId: skill.id,
          trigger: "manual",
          inputs: {},
        }),
      );

      const found = await tx((trx) => store.getRunByIdempotencyKey(trx, "skill-cron:abc:lookup"));
      expect(found?.id).toBe(row.id);
      expect(await tx((trx) => store.getRunByIdempotencyKey(trx, "other"))).toBeUndefined();
    });

    it("kind='recovered' on second call with same key — returns the existing row", async () => {
      const skill = await seedSkill({ name: "with-key" });
      const key = "skill-cron:abc:2026-06-01T09:00:00.000Z";
      const first = await tx((trx) =>
        store.startOrRecoverRun(trx, {
          ...audit(),
          skillId: skill.id,
          trigger: "cron",
          inputs: { x: 1 },
          idempotencyKey: key,
        }),
      );
      const second = await tx((trx) =>
        store.startOrRecoverRun(trx, {
          ...audit(),
          skillId: skill.id,
          trigger: "cron",
          inputs: { x: 1 },
          idempotencyKey: key,
        }),
      );
      expect(second.kind).toBe("recovered");
      expect(second.row.id).toBe(first.row.id);
      expect(second.row.recoveryPoint).toBe("started");
    });

    it("kind='recovered' returns the stored row as it stands, untouched by the retry's params", async () => {
      // The runner branches on the recovered row's recovery point and payload.
      const skill = await seedSkill({ name: "with-key" });
      const key = "skill-tool:turn-1:0:0";
      const first = await tx((trx) =>
        store.startOrRecoverRun(trx, {
          ...audit(),
          skillId: skill.id,
          trigger: "event",
          inputs: { x: 1 },
          idempotencyKey: key,
        }),
      );
      await dispatch(first.row.id);
      await tx((trx) =>
        store.transitionToExecuted(trx, {
          id: first.row.id,
          outcome: { kind: "output", output: { echo: 1 } },
          resourceUsage: { wallClockMs: 3, peakMemoryBytes: null },
          finishedAt: new Date("2026-06-01T09:00:03Z"),
        }),
      );
      const stored = await tx((trx) => store.getRun(trx, first.row.id));

      const retry = await tx((trx) =>
        store.startOrRecoverRun(trx, {
          ...audit(),
          skillId: skill.id,
          trigger: "manual",
          inputs: { x: 2 },
          idempotencyKey: key,
        }),
      );

      expect(retry.kind).toBe("recovered");
      expect(retry.row).toEqual(stored);
    });

    it("transitionToExecuted advances recovery_point and writes the payload", async () => {
      const skill = await seedSkill();
      const { row } = await tx((trx) =>
        store.startOrRecoverRun(trx, {
          ...audit(),
          skillId: skill.id,
          trigger: "cron",
          inputs: {},
          idempotencyKey: "k-1",
        }),
      );
      const finishedAt = new Date("2026-06-01T09:00:42Z");
      await dispatch(row.id);
      await tx((trx) =>
        store.transitionToExecuted(trx, {
          id: row.id,
          outcome: { kind: "output", output: { echo: 42 } },
          resourceUsage: { wallClockMs: 42, peakMemoryBytes: 1_048_576 },
          finishedAt,
        }),
      );
      const reloaded = await tx((trx) => store.getRun(trx, row.id));
      expect(reloaded?.recoveryPoint).toBe("executed");
      expect(reloaded?.output).toEqual({ echo: 42 });
      expect(reloaded?.error).toBeNull();
      expect(reloaded?.resourceUsage).toEqual({ wallClockMs: 42, peakMemoryBytes: 1_048_576 });
      expect(reloaded?.finishedAt?.toISOString()).toBe(finishedAt.toISOString());
      // Status is NOT touched by the executed transition — validation
      // hasn't run yet, so the terminal state isn't known. Stays
      // 'running' until transitionToFinished.
      expect(reloaded?.status).toBe("running");
    });

    it("transitionToFinished sets status and advances recovery_point", async () => {
      const skill = await seedSkill();
      const { row } = await tx((trx) =>
        store.startOrRecoverRun(trx, {
          ...audit(),
          skillId: skill.id,
          trigger: "cron",
          inputs: {},
          idempotencyKey: "k-2",
        }),
      );
      await dispatch(row.id);
      await tx((trx) =>
        store.transitionToExecuted(trx, {
          id: row.id,
          outcome: { kind: "output", output: { echo: 1 } },
          resourceUsage: { wallClockMs: 1, peakMemoryBytes: null },
          finishedAt: new Date(),
        }),
      );
      await tx((trx) =>
        store.transitionToFinished(trx, {
          id: row.id,
          verdict: { status: "success", output: { echo: 1 } },
        }),
      );
      const reloaded = await tx((trx) => store.getRun(trx, row.id));
      expect(reloaded?.recoveryPoint).toBe("finished");
      expect(reloaded?.status).toBe("success");
    });

    it("transitionToFinished reports a row another attempt already finished", async () => {
      const skill = await seedSkill();
      const { row } = await tx((trx) =>
        store.startOrRecoverRun(trx, {
          ...audit(),
          skillId: skill.id,
          trigger: "cron",
          inputs: {},
          idempotencyKey: "k-race",
        }),
      );
      await dispatch(row.id);
      await tx((trx) =>
        store.transitionToExecuted(trx, {
          id: row.id,
          outcome: { kind: "output", output: { echo: 1 } },
          resourceUsage: { wallClockMs: 1, peakMemoryBytes: null },
          finishedAt: new Date(),
        }),
      );
      const finish = () =>
        tx((trx) =>
          store.transitionToFinished(trx, {
            id: row.id,
            verdict: { status: "success", output: { echo: 1 } },
          }),
        );

      expect(await finish()).toEqual({ kind: "transitioned" });
      const second = await finish();
      assertKind(second, "already_finished");
      expect(second.row.status).toBe("success");
      expect(second.row.output).toEqual({ echo: 1 });
    });

    it("transitionToFinished throws on a row still at started", async () => {
      const skill = await seedSkill();
      const { row } = await tx((trx) =>
        store.startOrRecoverRun(trx, {
          ...audit(),
          skillId: skill.id,
          trigger: "cron",
          inputs: {},
          idempotencyKey: "k-started",
        }),
      );
      await expect(
        tx((trx) =>
          store.transitionToFinished(trx, {
            id: row.id,
            verdict: { status: "success", output: null },
          }),
        ),
      ).rejects.toThrow(/recovery_point != 'executed'/);
    });

    describe("per-state CHECKs", () => {
      /** A one-shot run at `recovery_point='executed'` holding an output. */
      async function executedRun(): Promise<string> {
        const skill = await seedSkill();
        const run = await tx((trx) =>
          store.insertRun(trx, {
            ...audit(),
            skillId: skill.id,
            trigger: "manual",
            inputs: {},
          }),
        );
        await dispatch(run.id);
        await tx((trx) =>
          store.transitionToExecuted(trx, {
            id: run.id,
            outcome: { kind: "output", output: { echo: 1 } },
            resourceUsage: { wallClockMs: 1, peakMemoryBytes: null },
            finishedAt: new Date(),
          }),
        );
        return run.id;
      }

      function rejectedBy(constraint: string) {
        return { cause: { message: expect.stringMatching(new RegExp(constraint)) } };
      }

      it("a started row cannot carry the executed payload", async () => {
        const skill = await seedSkill();
        const run = await tx((trx) =>
          store.insertRun(trx, {
            ...audit(),
            skillId: skill.id,
            trigger: "manual",
            inputs: {},
          }),
        );
        await expect(
          db.update(skillRuns).set({ finishedAt: new Date() }).where(eq(skillRuns.id, run.id)),
        ).rejects.toMatchObject(rejectedBy("chk_skill_runs_executed_payload"));
        await expect(
          db
            .update(skillRuns)
            .set({ error: "boom", errorKind: "skill_raised" })
            .where(eq(skillRuns.id, run.id)),
        ).rejects.toMatchObject(rejectedBy("chk_skill_runs_executed_payload"));
      });

      it("a terminal status exists only in the finished phase, and finished is never running", async () => {
        const id = await executedRun();
        await expect(
          db.update(skillRuns).set({ status: "success" }).where(eq(skillRuns.id, id)),
        ).rejects.toMatchObject(rejectedBy("chk_skill_runs_status_iff_finished"));
        await expect(
          db.update(skillRuns).set({ recoveryPoint: "finished" }).where(eq(skillRuns.id, id)),
        ).rejects.toMatchObject(rejectedBy("chk_skill_runs_status_iff_finished"));
      });

      it("an error verdict records its reason and keeps no output", async () => {
        const id = await executedRun();
        await expect(
          db
            .update(skillRuns)
            .set({ status: "error", recoveryPoint: "finished" })
            .where(eq(skillRuns.id, id)),
        ).rejects.toMatchObject(rejectedBy("chk_skill_runs_outcome"));
        await expect(
          db
            .update(skillRuns)
            .set({
              status: "error",
              recoveryPoint: "finished",
              error: "boom",
              errorKind: "skill_raised",
            })
            .where(eq(skillRuns.id, id)),
        ).rejects.toMatchObject(rejectedBy("chk_skill_runs_outcome"));
      });

      it("an output_invalid verdict keeps the output", async () => {
        const id = await executedRun();
        await db
          .update(skillRuns)
          .set({
            status: "error",
            recoveryPoint: "finished",
            error: "bad",
            errorKind: "output_invalid",
          })
          .where(eq(skillRuns.id, id));
        const row = await tx((trx) => store.getRun(trx, id));
        expect(row).toMatchObject({
          output: { echo: 1 },
          error: "bad",
          errorKind: "output_invalid",
        });
      });

      it("an executed row keeps no output beside an error", async () => {
        const executedOnly = await executedRun();
        await expect(
          db
            .update(skillRuns)
            .set({ error: "bad", errorKind: "output_invalid" })
            .where(eq(skillRuns.id, executedOnly)),
        ).rejects.toMatchObject(rejectedBy("chk_skill_runs_outcome"));
      });

      it("an error has its kind, and nothing else does", async () => {
        const id = await executedRun();
        await expect(
          db.update(skillRuns).set({ output: null, error: "boom" }).where(eq(skillRuns.id, id)),
        ).rejects.toMatchObject(rejectedBy("chk_skill_runs_error_kind_with_error"));
        await expect(
          db.update(skillRuns).set({ errorKind: "skill_raised" }).where(eq(skillRuns.id, id)),
        ).rejects.toMatchObject(rejectedBy("chk_skill_runs_error_kind_with_error"));
      });

      it("deadline_at arrives with dispatched, and a dispatched row has no executed payload", async () => {
        const skill = await seedSkill();
        const run = await tx((trx) =>
          store.insertRun(trx, { ...audit(), skillId: skill.id, trigger: "manual", inputs: {} }),
        );
        await expect(
          db.update(skillRuns).set({ deadlineAt: DEADLINE }).where(eq(skillRuns.id, run.id)),
        ).rejects.toMatchObject(rejectedBy("chk_skill_runs_deadline_at"));
        await expect(
          db.update(skillRuns).set({ recoveryPoint: "dispatched" }).where(eq(skillRuns.id, run.id)),
        ).rejects.toMatchObject(rejectedBy("chk_skill_runs_deadline_at"));
        await dispatch(run.id);
        await expect(
          db.update(skillRuns).set({ finishedAt: new Date() }).where(eq(skillRuns.id, run.id)),
        ).rejects.toMatchObject(rejectedBy("chk_skill_runs_executed_payload"));
      });

      it("the audit columns are set together", async () => {
        const skill = await seedSkill();
        const run = await tx((trx) =>
          store.insertRun(trx, { ...audit(), skillId: skill.id, trigger: "manual", inputs: {} }),
        );
        await expect(
          db.update(skillRuns).set({ gitSha: null }).where(eq(skillRuns.id, run.id)),
        ).rejects.toMatchObject(rejectedBy("chk_skill_runs_audit_together"));
        await expect(
          db.update(skillRuns).set({ runAsProfileId: null }).where(eq(skillRuns.id, run.id)),
        ).rejects.toMatchObject(rejectedBy("chk_skill_runs_audit_together"));
      });

      it("a success verdict carries no error", async () => {
        const id = await executedRun();
        await expect(
          db
            .update(skillRuns)
            .set({
              status: "success",
              recoveryPoint: "finished",
              error: "boom",
              errorKind: "skill_raised",
            })
            .where(eq(skillRuns.id, id)),
        ).rejects.toMatchObject(rejectedBy("chk_skill_runs_outcome"));
      });
    });

    it("UNIQUE constraint allows multiple null-key rows for the same skill", async () => {
      // CLI / ad-hoc invocations land with idempotency_key=NULL. Postgres
      // default NULL-not-equal semantics under UNIQUE constraints let
      // null-key rows coexist freely — non-null keys collide, nulls
      // don't. Verifies the constraint definition matches the intent.
      const skill = await seedSkill();
      const a = await tx((trx) =>
        store.insertRun(trx, {
          ...audit(),
          skillId: skill.id,
          trigger: "manual",
          inputs: {},
        }),
      );
      const b = await tx((trx) =>
        store.insertRun(trx, {
          ...audit(),
          skillId: skill.id,
          trigger: "manual",
          inputs: {},
        }),
      );
      expect(a.id).not.toBe(b.id);
      expect(a.idempotencyKey).toBeNull();
      expect(b.idempotencyKey).toBeNull();
    });

    it("records the run's sha and run-as on insert, and runs it live", async () => {
      const skill = await seedSkill();
      const runAs = await seedIdentity("other");
      const run = await tx((trx) =>
        store.insertRun(trx, {
          skillId: skill.id,
          trigger: "manual",
          inputs: {},
          gitSha: SHA_NEW,
          runAs,
        }),
      );
      expect(run).toMatchObject({
        gitSha: SHA_NEW,
        runAsUserId: runAs.userId,
        runAsProfileId: runAs.profileId,
        shadow: false,
        deadlineAt: null,
        errorKind: null,
      });
    });

    it("explicit idempotencyKey on insertRun stamps the column", async () => {
      const skill = await seedSkill();
      const row = await tx((trx) =>
        store.insertRun(trx, {
          ...audit(),
          skillId: skill.id,
          trigger: "cron",
          inputs: {},
          idempotencyKey: "explicit-key",
        }),
      );
      expect(row.idempotencyKey).toBe("explicit-key");
      expect(row.recoveryPoint).toBe("started");
    });
  });

  describe("dispatch, pre-dispatch failure and the sweep", () => {
    const CUTOFFS = {
      createdBefore: new Date("2026-06-01T09:15:00Z"),
      deadlineBefore: new Date("2026-06-01T09:30:00Z"),
    };
    const USAGE = { wallClockMs: 5, peakMemoryBytes: null };

    async function startedRun(createdAt: string): Promise<string> {
      const skill = await seedSkill({ name: `s-${createdAt.replace(/\W/g, "")}` });
      const run = await tx((trx) =>
        store.insertRun(trx, { ...audit(), skillId: skill.id, trigger: "cron", inputs: {} }),
      );
      await db
        .update(skillRuns)
        .set({ createdAt: new Date(createdAt) })
        .where(eq(skillRuns.id, run.id));
      return run.id;
    }

    async function dispatchedRun(createdAt: string, deadlineAt: string): Promise<string> {
      const id = await startedRun(createdAt);
      await tx((trx) =>
        store.transitionToDispatched(trx, { id, deadlineAt: new Date(deadlineAt) }),
      );
      return id;
    }

    async function sweep(id: string, stuckAt: "started" | "dispatched") {
      return tx((trx) =>
        store.sweepRun(trx, {
          run: { id, stuckAt, createdAt: new Date("2026-06-01T09:00:00Z") },
          cutoffs: CUTOFFS,
          message: "swept",
          resourceUsage: USAGE,
          finishedAt: new Date("2026-06-01T09:30:00Z"),
        }),
      );
    }

    it("transitionToDispatched writes deadline_at and moves started to dispatched", async () => {
      const id = await startedRun("2026-06-01T09:00:00Z");
      const deadlineAt = new Date("2026-06-01T09:01:30Z");
      expect(await tx((trx) => store.transitionToDispatched(trx, { id, deadlineAt }))).toEqual({
        kind: "dispatched",
      });
      const row = await tx((trx) => store.getRun(trx, id));
      expect(row).toMatchObject({ recoveryPoint: "dispatched", status: "running", deadlineAt });
    });

    it("transitionToDispatched returns swept with the row the sweeper finished", async () => {
      const id = await startedRun("2026-06-01T09:00:00Z");
      expect(await sweep(id, "started")).toEqual({ kind: "swept" });
      const dispatched = await tx((trx) =>
        store.transitionToDispatched(trx, { id, deadlineAt: DEADLINE }),
      );
      assertKind(dispatched, "swept");
      expect(dispatched.row).toMatchObject({ recoveryPoint: "finished", errorKind: "host_lost" });
    });

    it("a transition meeting a row swept from the other state throws", async () => {
      const lostAfterDispatch = await dispatchedRun("2026-06-01T09:00:00Z", "2026-06-01T09:02:00Z");
      await sweep(lostAfterDispatch, "dispatched");
      await expect(
        tx((trx) =>
          store.failBeforeDispatch(trx, {
            id: lostAfterDispatch,
            error: { kind: "runtime_unavailable", message: "pool gone" },
            resourceUsage: USAGE,
            finishedAt: new Date(),
          }),
        ),
      ).rejects.toThrow(/not one the sweeper finished as host_lost/);

      const lostBeforeDispatch = await startedRun("2026-06-01T09:00:01Z");
      await sweep(lostBeforeDispatch, "started");
      await expect(
        tx((trx) =>
          store.transitionToExecuted(trx, {
            id: lostBeforeDispatch,
            outcome: { kind: "output", output: null },
            resourceUsage: USAGE,
            finishedAt: new Date(),
          }),
        ),
      ).rejects.toThrow(/not one the sweeper finished as result_lost/);
    });

    it("transitionToDispatched throws on a row it already dispatched", async () => {
      const id = await startedRun("2026-06-01T09:00:00Z");
      await dispatch(id);
      await expect(
        tx((trx) => store.transitionToDispatched(trx, { id, deadlineAt: DEADLINE })),
      ).rejects.toThrow(/row is at 'dispatched'/);
    });

    it("transitionToExecuted throws on a row never dispatched", async () => {
      const id = await startedRun("2026-06-01T09:00:00Z");
      await expect(
        tx((trx) =>
          store.transitionToExecuted(trx, {
            id,
            outcome: { kind: "output", output: null },
            resourceUsage: USAGE,
            finishedAt: new Date(),
          }),
        ),
      ).rejects.toThrow(/row is at 'started'/);
    });

    it("transitionToExecuted records a worker error with its kind", async () => {
      const id = await startedRun("2026-06-01T09:00:00Z");
      await dispatch(id);
      const outcome = {
        kind: "error",
        error: { kind: "load_failed", message: "SyntaxError" },
      } as const;
      expect(
        await tx((trx) =>
          store.transitionToExecuted(trx, {
            id,
            outcome,
            resourceUsage: USAGE,
            finishedAt: new Date(),
          }),
        ),
      ).toEqual({ kind: "transitioned" });
      const row = await tx((trx) => store.getRun(trx, id));
      expect(row).toMatchObject({
        recoveryPoint: "executed",
        status: "running",
        output: null,
        error: "SyntaxError",
        errorKind: "load_failed",
      });
    });

    it("a late transitionToExecuted returns swept and writes nothing", async () => {
      const id = await dispatchedRun("2026-06-01T09:00:00Z", "2026-06-01T09:02:00Z");
      expect(await sweep(id, "dispatched")).toEqual({ kind: "swept" });
      const late = await tx((trx) =>
        store.transitionToExecuted(trx, {
          id,
          outcome: { kind: "output", output: { late: true } },
          resourceUsage: { wallClockMs: 99, peakMemoryBytes: 1 },
          finishedAt: new Date(),
        }),
      );
      assertKind(late, "swept");
      expect(late.row).toMatchObject({
        recoveryPoint: "finished",
        status: "error",
        errorKind: "result_lost",
        output: null,
        resourceUsage: USAGE,
      });
    });

    it("failBeforeDispatch moves started to executed with its pausing kind", async () => {
      const id = await startedRun("2026-06-01T09:00:00Z");
      const finishedAt = new Date("2026-06-01T09:00:04Z");
      expect(
        await tx((trx) =>
          store.failBeforeDispatch(trx, {
            id,
            error: { kind: "dependency_unavailable", message: "populate failed" },
            resourceUsage: USAGE,
            finishedAt,
          }),
        ),
      ).toEqual({ kind: "transitioned" });
      const row = await tx((trx) => store.getRun(trx, id));
      expect(row).toMatchObject({
        recoveryPoint: "executed",
        status: "running",
        error: "populate failed",
        errorKind: "dependency_unavailable",
        deadlineAt: null,
        finishedAt,
      });
    });

    it("failBeforeDispatch returns swept on a swept row and throws on a dispatched one", async () => {
      const fail = (id: string) =>
        tx((trx) =>
          store.failBeforeDispatch(trx, {
            id,
            error: { kind: "runtime_unavailable", message: "pool gone" },
            resourceUsage: USAGE,
            finishedAt: new Date(),
          }),
        );
      const swept = await startedRun("2026-06-01T09:00:00Z");
      await sweep(swept, "started");
      expect(await fail(swept)).toMatchObject({ kind: "swept", row: { errorKind: "host_lost" } });

      const dispatched = await startedRun("2026-06-01T09:00:01Z");
      await dispatch(dispatched);
      await expect(fail(dispatched)).rejects.toThrow(/row is at 'dispatched'/);
    });

    it("listStuckRuns finds started rows past the bound and dispatched rows past their deadline", async () => {
      const oldStarted = await startedRun("2026-06-01T09:00:00Z");
      await startedRun("2026-06-01T09:20:00Z");
      const lateDispatched = await dispatchedRun("2026-06-01T09:01:00Z", "2026-06-01T09:10:00Z");
      await dispatchedRun("2026-06-01T09:02:00Z", "2026-06-01T09:40:00Z");
      const executed = await dispatchedRun("2026-06-01T09:03:00Z", "2026-06-01T09:05:00Z");
      await tx((trx) =>
        store.transitionToExecuted(trx, {
          id: executed,
          outcome: { kind: "output", output: null },
          resourceUsage: USAGE,
          finishedAt: new Date(),
        }),
      );

      const stuck = await tx((trx) => store.listStuckRuns(trx, { cutoffs: CUTOFFS, limit: 10 }));
      expect(stuck).toEqual([
        { id: oldStarted, stuckAt: "started", createdAt: new Date("2026-06-01T09:00:00Z") },
        { id: lateDispatched, stuckAt: "dispatched", createdAt: new Date("2026-06-01T09:01:00Z") },
      ]);
      expect(
        await tx((trx) => store.listStuckRuns(trx, { cutoffs: CUTOFFS, limit: 1 })),
      ).toHaveLength(1);
    });

    it("sweepRun finishes a started row host_lost and a dispatched one result_lost", async () => {
      const started = await startedRun("2026-06-01T09:00:00Z");
      const dispatched = await dispatchedRun("2026-06-01T09:00:01Z", "2026-06-01T09:10:00Z");
      expect(await sweep(started, "started")).toEqual({ kind: "swept" });
      expect(await sweep(dispatched, "dispatched")).toEqual({ kind: "swept" });
      const finished = {
        recoveryPoint: "finished",
        status: "error",
        output: null,
        error: "swept",
        resourceUsage: USAGE,
        finishedAt: new Date("2026-06-01T09:30:00Z"),
      };
      expect(await tx((trx) => store.getRun(trx, started))).toMatchObject({
        ...finished,
        errorKind: "host_lost",
        deadlineAt: null,
      });
      expect(await tx((trx) => store.getRun(trx, dispatched))).toMatchObject({
        ...finished,
        errorKind: "result_lost",
        deadlineAt: new Date("2026-06-01T09:10:00Z"),
      });
    });

    it("sweepRun leaves a row that moved on, or is not past its bound", async () => {
      const dispatchedSince = await startedRun("2026-06-01T09:00:00Z");
      await dispatch(dispatchedSince);
      expect(await sweep(dispatchedSince, "started")).toEqual({ kind: "moved_on" });

      const fresh = await startedRun("2026-06-01T09:20:00Z");
      expect(await sweep(fresh, "started")).toEqual({ kind: "moved_on" });

      const inTime = await dispatchedRun("2026-06-01T09:00:02Z", "2026-06-01T09:40:00Z");
      expect(await sweep(inTime, "dispatched")).toEqual({ kind: "moved_on" });
      expect(await tx((trx) => store.getRun(trx, inTime))).toMatchObject({
        recoveryPoint: "dispatched",
      });
    });

    it("an output_invalid verdict round-trips its output through transitionToFinished", async () => {
      const id = await startedRun("2026-06-01T09:00:00Z");
      await dispatch(id);
      await tx((trx) =>
        store.transitionToExecuted(trx, {
          id,
          outcome: { kind: "output", output: { n: "x" } },
          resourceUsage: USAGE,
          finishedAt: new Date(),
        }),
      );
      await tx((trx) =>
        store.transitionToFinished(trx, {
          id,
          verdict: {
            status: "error",
            error: { kind: "output_invalid", message: "n must be a number", output: { n: "x" } },
          },
        }),
      );
      expect(await tx((trx) => store.getRun(trx, id))).toMatchObject({
        status: "error",
        errorKind: "output_invalid",
        error: "n must be a number",
        output: { n: "x" },
      });
    });
  });

  describe("run-as identity", () => {
    const NOTIFY_LOG: ClassifierLog = { ...STUB_LOG, risk_tier: "notify" };
    const APPROVE_LOG: ClassifierLog = { ...STUB_LOG, risk_tier: "approve" };
    const noFs = async () => {};

    function registerParams(overrides: Partial<ExecuteRegisterParams> = {}): ExecuteRegisterParams {
      return executeRegisterParams({
        name: "cron-skill",
        schedule: "0 9 * * *",
        scheduleNextRunAt: new Date("2026-06-01T09:00:00Z"),
        classifierLog: NOTIFY_LOG,
        ...overrides,
      });
    }

    function register(overrides: Partial<ExecuteRegisterParams> = {}) {
      return tx((trx) => store.executeRegister(trx, registerParams(overrides)));
    }

    function runAsOf(row: SkillRow | undefined): [string | null, string | null] {
      return [expectDefined(row, "skill").runAsUserId, expectDefined(row, "skill").runAsProfileId];
    }

    async function reload(name: string): Promise<SkillRow | undefined> {
      return tx((trx) => store.getSkillByName(trx, name));
    }

    it("insertSkill stores the run-as identity alongside the schedule", async () => {
      const row = await seedSkill({
        schedule: "0 9 * * *",
        scheduleNextRunAt: new Date("2026-06-01T09:00:00Z"),
      });
      expect(runAsOf(row)).toEqual([owner.userId, owner.profileId]);
    });

    it("insertSkill refuses a schedule without a run-as identity, and the reverse", async () => {
      await expect(
        seedSkill({
          schedule: "0 9 * * *",
          scheduleNextRunAt: new Date("2026-06-01T09:00:00Z"),
          scheduleRunAs: null,
        }),
      ).rejects.toThrow(/schedule and scheduleRunAs must agree/);
      await expect(seedSkill({ scheduleRunAs: owner })).rejects.toThrow(
        /schedule and scheduleRunAs must agree/,
      );
    });

    it("the CHECK refuses a disabled row keeping its run-as identity", async () => {
      const row = await seedSkill({
        schedule: "0 9 * * *",
        scheduleNextRunAt: new Date("2026-06-01T09:00:00Z"),
      });
      await expect(
        db.update(skills).set({ disabled: true }).where(eq(skills.id, row.id)),
      ).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/chk_skills_run_as_iff_live_schedule/) },
      });
    });

    it("disabling a scheduled skill clears its identity and keeps the schedule", async () => {
      const row = await seedSkill({
        schedule: "0 9 * * *",
        scheduleNextRunAt: new Date("2026-06-01T09:00:00Z"),
      });
      await tx((trx) => store.disableSkill(trx, row.id));
      const after = await reload(row.name);
      expect(runAsOf(after)).toEqual([null, null]);
      expect(after?.schedule).toBe("0 9 * * *");
    });

    it("enabling a scheduled skill writes the enabler's identity", async () => {
      const row = await seedSkill({
        schedule: "0 9 * * *",
        scheduleNextRunAt: new Date("2026-06-01T09:00:00Z"),
      });
      await tx((trx) => store.disableSkill(trx, row.id));
      const enabler = await seedIdentity("enabler");
      await tx((trx) => store.enableSkill(trx, { id: row.id, runAs: enabler }));
      expect(runAsOf(await reload(row.name))).toEqual([enabler.userId, enabler.profileId]);
    });

    it("enabling an unscheduled skill writes no identity", async () => {
      const row = await seedSkill();
      await tx((trx) => store.disableSkill(trx, row.id));
      await tx((trx) => store.enableSkill(trx, { id: row.id, runAs: owner }));
      expect(runAsOf(await reload(row.name))).toEqual([null, null]);
    });

    it("the CHECK refuses a scheduled row losing its run-as identity", async () => {
      const row = await seedSkill({
        schedule: "0 9 * * *",
        scheduleNextRunAt: new Date("2026-06-01T09:00:00Z"),
      });
      await expect(
        db.update(skills).set({ runAsProfileId: null }).where(eq(skills.id, row.id)),
      ).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/chk_skills_run_as_iff_live_schedule/) },
      });
    });

    function approve(pendingId: string, runAs: SkillRunIdentity) {
      return tx((trx) =>
        store.executeApprove(trx, {
          pendingId,
          approvedBy: null,
          tier: "wasm",
          riskTier: "approve",
          effects: [],
          schedule: "0 9 * * *",
          scheduleNextRunAt: new Date("2026-06-01T09:00:00Z"),
          lockfileHash: null,
          inputs: INPUTS_SCHEMA,
          outputs: null,
          runAs,
          applyFilesystem: noFs,
        }),
      );
    }

    function rollback(toGitSha: string, runAs: SkillRunIdentity) {
      return tx((trx) =>
        store.executeRollback(trx, {
          name: "cron-skill",
          restoringGitSha: toGitSha,
          restoresGitSha: toGitSha,
          expectedLiveSha: null,
          tier: "wasm",
          riskTier: "notify",
          effects: [],
          schedule: "0 9 * * *",
          scheduleNextRunAt: new Date("2026-06-01T09:00:00Z"),
          lockfileHash: null,
          inputs: INPUTS_SCHEMA,
          outputs: null,
          classifierLog: NOTIFY_LOG,
          runAs,
          applyFilesystem: noFs,
        }),
      );
    }

    /** A live `cron-skill` at `SHA_NEW`, approved by a user of its own. */
    async function approvedUpgrade(): Promise<SkillRunIdentity> {
      await register();
      const pending = await register({
        branchTipSha: SHA_NEW,
        riskTier: "approve",
        classifierLog: APPROVE_LOG,
      });
      if (pending.kind !== "pending_approval") throw new Error(`got ${pending.kind}`);
      const approver = await seedIdentity("approver");
      expect((await approve(pending.deploy.id, approver)).kind).toBe("live");
      expect(runAsOf(await reload("cron-skill"))).toEqual([approver.userId, approver.profileId]);
      return approver;
    }

    it("a first deploy with a schedule captures the deploy's identity", async () => {
      const result = await register();
      expect(result.kind).toBe("live");
      expect(runAsOf(await reload("cron-skill"))).toEqual([owner.userId, owner.profileId]);
    });

    it("a redeploy keeping the schedule captures its own identity", async () => {
      await register();
      const other = await seedIdentity("other");
      await register({ branchTipSha: SHA_NEW, runAs: other });
      expect(runAsOf(await reload("cron-skill"))).toEqual([other.userId, other.profileId]);
    });

    it("a redeploy dropping the schedule clears the identity", async () => {
      await register();
      await register({ branchTipSha: SHA_NEW, schedule: null, scheduleNextRunAt: null });
      expect(runAsOf(await reload("cron-skill"))).toEqual([null, null]);
    });

    it("a pending deploy leaves the live identity alone until approved", async () => {
      await register();
      const other = await seedIdentity("other");
      await register({
        branchTipSha: SHA_NEW,
        riskTier: "approve",
        classifierLog: APPROVE_LOG,
        runAs: other,
      });
      expect(runAsOf(await reload("cron-skill"))).toEqual([owner.userId, owner.profileId]);
    });

    it("a pending first deploy has no identity until approved, then the approver's", async () => {
      const pending = await register({ riskTier: "approve", classifierLog: APPROVE_LOG });
      if (pending.kind !== "pending_approval") throw new Error(`got ${pending.kind}`);
      expect(runAsOf(pending.skill)).toEqual([null, null]);

      const approver = await seedIdentity("approver");
      expect((await approve(pending.deploy.id, approver)).kind).toBe("live");
      expect(runAsOf(await reload("cron-skill"))).toEqual([approver.userId, approver.profileId]);
    });

    it("an unapproved redeploy after an approval runs as its own identity, not the approver", async () => {
      await approvedUpgrade();
      const author = await seedIdentity("author");
      const redeploy = await register({ branchTipSha: SHA_THIRD, runAs: author });
      expect(redeploy.kind).toBe("live");
      expect(runAsOf(await reload("cron-skill"))).toEqual([author.userId, author.profileId]);
    });

    it("a rollback does not inherit a previous approver", async () => {
      await approvedUpgrade();
      expect((await rollback(SHA, owner)).kind).toBe("live");
      expect(runAsOf(await reload("cron-skill"))).toEqual([owner.userId, owner.profileId]);
    });

    it("deleting the run-as user is refused, not cascaded into the skill", async () => {
      const row = await seedSkill({
        schedule: "0 9 * * *",
        scheduleNextRunAt: new Date("2026-06-01T09:00:00Z"),
      });
      await expect(db.delete(users).where(eq(users.id, owner.userId))).rejects.toMatchObject({
        cause: { code: "23503" },
      });
      expect(await tx((trx) => store.getSkillById(trx, row.id))).toBeDefined();
    });
  });

  describe("deploy transitions", () => {
    const APPROVE_LOG: ClassifierLog = { ...STUB_LOG, risk_tier: "approve" };
    const noFs = async () => {};
    const UNKNOWN_ID = "019d0000-0000-7000-8000-0000000000ff";

    function register(overrides: Partial<ExecuteRegisterParams> = {}) {
      return tx((trx) => store.executeRegister(trx, executeRegisterParams(overrides)));
    }

    /** A live `echo` at `SHA` with an approve-tier upgrade to `SHA_NEW` pending. */
    async function pendingUpgrade(): Promise<{ pendingId: string; skill: SkillRow }> {
      await register();
      const pending = await register({
        branchTipSha: SHA_NEW,
        riskTier: "approve",
        classifierLog: APPROVE_LOG,
      });
      assertKind(pending, "pending_approval");
      return { pendingId: pending.deploy.id, skill: pending.skill };
    }

    function approve(trx: Transaction, pendingId: string) {
      return store.executeApprove(trx, {
        pendingId,
        approvedBy: null,
        tier: "wasm",
        riskTier: "approve",
        effects: [],
        schedule: null,
        scheduleNextRunAt: null,
        lockfileHash: null,
        inputs: INPUTS_SCHEMA,
        outputs: null,
        runAs: owner,
        applyFilesystem: noFs,
      });
    }

    async function reloadDeploy(id: string) {
      return expectDefined(await tx((trx) => store.getDeployById(trx, id)), "deploy");
    }

    it("records the live version a deploy replaces, and none after a denied first deploy", async () => {
      const denied = await register({ riskTier: "approve", classifierLog: APPROVE_LOG });
      assertKind(denied, "pending_approval");
      await tx((trx) => store.denyPendingDeploy(trx, { pendingId: denied.deploy.id }));

      const first = await register({ branchTipSha: SHA_NEW });
      assertKind(first, "live");
      expect(first.deploy.priorGitSha).toBeNull();

      const edit = await register({ branchTipSha: SHA_EDIT });
      assertKind(edit, "live");
      expect(edit.deploy.priorGitSha).toBe(SHA_NEW);
    });

    it("counts a rolled-back version as live when the next deploy names what it replaces", async () => {
      await register();
      const edit = await register({ branchTipSha: SHA_NEW });
      assertKind(edit, "live");
      const base = executeRegisterParams({});
      const rolledBack = await tx((trx) =>
        store.executeRollback(trx, {
          name: base.name,
          restoringGitSha: SHA_EDIT,
          restoresGitSha: SHA_EDIT,
          expectedLiveSha: null,
          tier: base.tier,
          riskTier: base.riskTier,
          effects: base.effects,
          schedule: base.schedule,
          scheduleNextRunAt: base.scheduleNextRunAt,
          lockfileHash: base.lockfileHash,
          inputs: base.inputs,
          outputs: base.outputs,
          classifierLog: base.classifierLog,
          runAs: base.runAs,
          applyFilesystem: noFs,
        }),
      );
      assertKind(rolledBack, "live");
      expect(rolledBack.deploy.priorGitSha).toBe(SHA_NEW);

      const next = await register({ branchTipSha: SHA });
      assertKind(next, "live");
      expect(next.deploy.priorGitSha).toBe(SHA_EDIT);
    });

    it("deny resolves a pending deploy and leaves the skills row alone", async () => {
      const { pendingId, skill } = await pendingUpgrade();
      const outcome = await tx((trx) => store.denyPendingDeploy(trx, { pendingId }));
      expect(outcome).toEqual({ kind: "transitioned" });
      const deploy = await reloadDeploy(pendingId);
      expect(deploy.status).toBe("denied");
      expect(deploy.resolvedAt).toBeInstanceOf(Date);
      expect(await tx((trx) => store.getSkillById(trx, skill.id))).toEqual(skill);
    });

    it("deny of an unknown id is not_found", async () => {
      const outcome = await tx((trx) => store.denyPendingDeploy(trx, { pendingId: UNKNOWN_ID }));
      expect(outcome).toEqual({ kind: "not_found" });
    });

    it("deny of an approved deploy is not_pending with the row's status", async () => {
      const { pendingId } = await pendingUpgrade();
      assertKind(await tx((trx) => approve(trx, pendingId)), "live");
      const outcome = await tx((trx) => store.denyPendingDeploy(trx, { pendingId }));
      expect(outcome).toEqual({ kind: "not_pending", status: "live" });
      expect((await reloadDeploy(pendingId)).status).toBe("live");
    });

    it("deny of a denied deploy is not_pending, and the row keeps its first resolution", async () => {
      const { pendingId } = await pendingUpgrade();
      await tx((trx) => store.denyPendingDeploy(trx, { pendingId }));
      const first = await reloadDeploy(pendingId);
      const outcome = await tx((trx) => store.denyPendingDeploy(trx, { pendingId }));
      expect(outcome).toEqual({ kind: "not_pending", status: "denied" });
      expect(await reloadDeploy(pendingId)).toEqual(first);
    });

    it("approve of a denied deploy is rejected and leaves the skills row alone", async () => {
      const { pendingId, skill } = await pendingUpgrade();
      await tx((trx) => store.denyPendingDeploy(trx, { pendingId }));
      const outcome = await tx((trx) => approve(trx, pendingId));
      assertKind(outcome, "rejected");
      expect(outcome.reason).toBe("deploy_not_pending: status is 'denied'");
      expect(await tx((trx) => store.getSkillById(trx, skill.id))).toEqual(skill);
    });

    it("approve writes nothing when its guarded UPDATE matches no row", async () => {
      // Pins that the conditional UPDATE is the transaction's first write: a
      // zero-row match leaves `skills` untouched because nothing precedes it.
      // The hook denies the row on the same connection right before that
      // statement executes. The real race converges here too, by a longer
      // path — under REPEATABLE READ the loser's UPDATE raises `40001` and
      // the transactor's retry reads the row as `denied`.
      const { pendingId, skill } = await pendingUpgrade();
      const outcome = await tx((trx) =>
        approve(
          hookBeforeUpdate(trx, skillDeploys, async () => {
            await trx
              .update(skillDeploys)
              .set({ status: "denied", resolvedAt: new Date() })
              .where(eq(skillDeploys.id, pendingId));
          }),
          pendingId,
        ),
      );
      assertKind(outcome, "rejected");
      expect(await tx((trx) => store.getSkillById(trx, skill.id))).toEqual(skill);
      expect((await reloadDeploy(pendingId)).status).toBe("denied");
      expect(outcome.reason).toBe("deploy_not_pending: status is 'denied'");
    });
  });
});

/**
 * `trx` with one seam: `beforeUpdate` runs, on the same connection, right
 * before each UPDATE on `table` executes. Everything else passes through.
 * Puts a use case's guarded write in front of a row it did not read, which
 * one PGlite connection cannot otherwise arrange.
 */
function hookBeforeUpdate(
  trx: Transaction,
  table: PgTable,
  beforeUpdate: () => Promise<void>,
): Transaction {
  const hookExecute = <Q extends object>(query: Q): Q =>
    new Proxy(query, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (prop !== "execute" || typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          await beforeUpdate();
          return value.apply(target, args);
        };
      },
    });
  return new Proxy(trx, {
    get(target, prop, receiver) {
      if (prop !== "update") return Reflect.get(target, prop, receiver);
      return (updated: PgTable) => {
        const builder = target.update(updated);
        if (updated !== table) return builder;
        return new Proxy(builder, {
          get(b, p, r) {
            const value: unknown = Reflect.get(b, p, r);
            if (p !== "set" || typeof value !== "function") return value;
            return (values: unknown) => hookExecute(value.call(b, values));
          },
        });
      };
    },
  });
}
