import { match } from "ts-pattern";
import type { SkillSourceError } from "../skill-source.js";
import type { SkillRiskTier } from "../store/index.js";

/** Fields every deploy outcome carries. */
interface RegisterResultBase {
  name: string;
  riskTier: SkillRiskTier;
  gitSha: string;
}

/**
 * The outcome of `register`, `approveDeploy` or `rollback`. `name` is empty
 * on a rejection that precedes reading the manifest.
 */
export type RegisterResult =
  /** `gitSha` is main's new tip. */
  | (RegisterResultBase & { status: "live" })
  /** `gitSha` is the branch tip awaiting approval; main has not moved. */
  | (RegisterResultBase & {
      status: "pending_approval";
      pendingId: string;
      /** The pending manifest's cron schedule, if it declares one. */
      schedule?: string;
    })
  /** The tip is already live: nothing changed. */
  | (RegisterResultBase & { status: "no_op" })
  /** Nothing was written. */
  | (RegisterResultBase & { status: "rejected"; errors: readonly string[] });

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
