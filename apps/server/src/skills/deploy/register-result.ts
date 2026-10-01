import { match } from "ts-pattern";
import type { SkillSourceError } from "../skill-source.js";
import type { SkillRiskTier } from "../store/index.js";

export interface RegisterResult {
  name: string;
  riskTier: SkillRiskTier;
  status: "live" | "pending_approval" | "rejected" | "no_op";
  gitSha: string;
  errors?: readonly string[];
  pendingId?: string;
  /** On a `pending_approval` result, the pending manifest's cron schedule, if it declares one. */
  schedule?: string;
}

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
