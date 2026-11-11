import { match } from "ts-pattern";
import type { SkillSourceError } from "../skill-source.js";
import type { SkillRiskTier } from "../store/index.js";
import type { DeployFacts } from "./deploy-facts.js";

/** Fields every deploy outcome carries. */
interface RegisterResultBase {
  name: string;
  riskTier: SkillRiskTier;
  gitSha: string;
}

/** Fields an outcome that wrote a deploy row carries. */
interface DeployedResultBase extends RegisterResultBase {
  skillId: string;
  /** The `skill_deploys` row this outcome wrote or resolved. */
  deployId: string;
  /** What the deployed version declares and why it got its tier. */
  facts: DeployFacts;
}

/**
 * The outcome of `register`, `approveDeploy` or `rollback`, and what
 * `announceDeployOutcome` turns into `skills/deploy/outcome`. `name` is empty
 * on a rejection that precedes reading the manifest.
 */
export type RegisterResult =
  /** `gitSha` is main's new tip. */
  | (DeployedResultBase & { status: "live" })
  /**
   * `gitSha` is the branch tip awaiting approval; main has not moved.
   * `deployId` is the pending row an approve or deny names.
   */
  | (DeployedResultBase & { status: "pending_approval" })
  /** The tip is already live: nothing changed. */
  | (RegisterResultBase & { status: "no_op" })
  /** Nothing was written. */
  | (RegisterResultBase & { status: "rejected"; errors: readonly string[] });

/**
 * A check register could not run, which pauses it, since nothing is wrong
 * with the sha: the gates' or the CPython runner's `registrar_unavailable`,
 * the schema import's packages or child, or the lockfile compile's
 * transport.
 */
export const REGISTER_PAUSES = [
  "registrar_unavailable",
  "schema_import_unavailable",
  "lockfile_transport",
] as const;
export type RegisterPause = (typeof REGISTER_PAUSES)[number];

/**
 * Register's checks on a sha, judged without its deploy (design/skills.md →
 * Dry run). `refused` carries register's terminal rejections as
 * `RegisterResult.errors` words them, bounded; `stale_base` a sha `main` is
 * not an ancestor of; `unavailable` the check that could not run.
 */
export type RegisterDryRun =
  | { kind: "passed"; sha: string; riskTier: SkillRiskTier }
  | { kind: "refused"; sha: string; findings: readonly string[] }
  | { kind: "stale_base"; sha: string; mainSha: string }
  | { kind: "unavailable"; sha: string; cause: RegisterPause; detail: string };

export function rejectedResult(gitSha: string, ...errors: readonly string[]): RegisterResult {
  return {
    name: "",
    riskTier: "notify",
    status: "rejected",
    gitSha,
    errors,
  };
}

/** Why approve or rollback refuses a target sha whose source does not read. */
export function targetSourceRejection(error: SkillSourceError): string {
  return match(error)
    .with({ kind: "commit_not_found" }, { kind: "missing_file" }, () => "target_missing_source")
    .with(
      { kind: "invalid_manifest" },
      ({ issues }) => `target_manifest_invalid: ${issues.join("; ")}`,
    )
    .exhaustive();
}
