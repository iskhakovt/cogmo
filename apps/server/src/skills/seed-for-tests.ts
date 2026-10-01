import type { Transactor } from "../db/index.js";
import { STUB_CLASSIFIER_VERSION } from "./classifier.js";
import { hashLockfileContents } from "./deps.js";
import { manifestErrorIssues, parseManifest } from "./manifest.js";
import type { SkillSourceCache } from "./source-cache.js";
import type { InsertSkillParams, SkillRow, SkillRunIdentity, SkillStore } from "./store/index.js";
import type { ClassifierLog } from "./types.js";

/**
 * Test seeding helper. Inserts a skills row + live skill_deploys row from
 * a directly-handed manifest+body, populating the source cache so `invoke()`
 * can find it without going through git. Used by store-level tests where
 * spinning up a real bare repo would be overkill.
 *
 * The real `register` RPC is the production path; tests touching the deploy
 * pipeline use that, not this.
 */
export interface RegisterForTestsParams {
  name: string;
  manifestSource: string;
  body: string;
  /** Optional fake commit sha — defaults to a deterministic hash of the body. */
  gitSha?: string;
  /**
   * Optional `requirements.lock` contents. When set, the skill row gets
   * `lockfile_hash = sha256(contents)` and the cache entry is populated so
   * `invoke` threads the lockfile through to the populator on first call.
   * Bypasses the register-time compile-and-byte-compare (covered by
   * `makeSandboxLockfileCompiler` unit tests); use this for e2e tests
   * that want to exercise the populator + activation path against a real
   * sandbox without bootstrapping a git repo.
   *
   * **Pass output from `uv pip compile --generate-hashes` only.** This
   * bypass trusts the input is shape-valid: malformed lockfiles slip
   * past the compile + byte-compare contract and either crash
   * `uv pip sync` inside the sandbox or pin nonsense in the cache.
   * Production paths can't reach this method.
   */
  lockfileContents?: string;
}

export interface SeedDeps {
  store: SkillStore;
  runInTx: Transactor;
  sourceCache: SkillSourceCache;
  defaultRunAs: SkillRunIdentity;
  scheduleNextRunAt(schedule: string | null): Date | null;
}

/** Seed a live skill straight from a manifest and body, bypassing git and the classifier. */
export async function seedSkillForTests(
  deps: SeedDeps,
  params: RegisterForTestsParams,
): Promise<SkillRow> {
  const parsed = parseManifest(params.manifestSource);
  if (!parsed.isOk()) {
    throw new Error(
      `__registerForTests: invalid manifest: ${manifestErrorIssues(parsed.error).join("; ")}`,
    );
  }
  const manifest = parsed.value.manifest;
  if (manifest.name !== params.name) {
    throw new Error(
      `__registerForTests: manifest.name '${manifest.name}' != params.name '${params.name}'`,
    );
  }

  const gitSha = params.gitSha ?? hashStub(params.manifestSource + params.body);
  const schedule = manifest.schedule ?? null;
  const lockfileSnapshot = params.lockfileContents
    ? {
        hash: hashLockfileContents(params.lockfileContents),
        contents: params.lockfileContents,
      }
    : null;
  const insertParams: InsertSkillParams = {
    name: manifest.name,
    tier: manifest.tier,
    riskTier: "auto",
    effects: manifest.effects,
    schedule,
    scheduleNextRunAt: deps.scheduleNextRunAt(schedule),
    scheduleRunAs: schedule === null ? null : deps.defaultRunAs,
    gitSha,
    lockfileHash: lockfileSnapshot?.hash ?? null,
    inputs: manifest.inputs,
    outputs: manifest.outputs ?? null,
  };

  const row = await deps.runInTx((tx) => deps.store.insertSkill(tx, insertParams));
  // Fixed classifier log — bypasses the real classifier so tests that don't
  // care about risk-tier promotion can seed a skill cleanly.
  const testClassifierLog: ClassifierLog = {
    classifier_version: STUB_CLASSIFIER_VERSION,
    risk_tier: "auto",
    declared_effects: [],
    detected_effects: [],
    declared_secrets: [],
    declared_dependencies: [],
    validation_errors: [],
  };
  await deps.runInTx((tx) =>
    deps.store.insertDeploy(tx, {
      skillId: row.id,
      gitSha,
      priorGitSha: null,
      riskTier: "auto",
      status: "live",
      classifierLog: testClassifierLog,
    }),
  );

  deps.sourceCache.put(gitSha, { manifest, body: params.body }, lockfileSnapshot);

  return row;
}

/**
 * Deterministic short hash for stub git_sha values in tests. Not
 * cryptographically meaningful — only needs to be unique-enough so that
 * `updateSkillSha` round-trips don't collide on re-register.
 */
function hashStub(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(h, 31) + input.charCodeAt(i)) | 0;
  }
  // Pad to look vaguely like a git short SHA.
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  return `stub${hex}`;
}
