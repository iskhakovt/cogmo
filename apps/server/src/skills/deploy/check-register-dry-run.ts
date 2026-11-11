import * as R from "remeda";
import { match } from "ts-pattern";
import { type DeployDeps, requireRepo } from "./deploy-deps.js";
import { prepareRegister } from "./register.js";
import { cutDryRunText, type RegisterDryRun } from "./register-result.js";

/** The CPython runner's bound on what it reports (design/skills.md → Register-time CPython checks). */
const MAX_FINDINGS = 100;

/**
 * Register's steps 3 to 5 on `sha`, `prepareRegister`, without its deploy
 * (design/skills.md → Dry run): it writes nothing the deploy transaction or
 * its post-commit steps write, only what the checks' sessions and caches
 * write. `signal` is checked at the start and once the checks return, as
 * register checks it, so an abort throws its reason rather than reading as a
 * rejection it caused.
 */
export async function checkRegisterDryRun(
  deps: DeployDeps,
  opts: { sha: string; signal: AbortSignal },
): Promise<RegisterDryRun> {
  const { sha, signal } = opts;
  const repo = requireRepo(deps, "checkRegister");
  signal.throwIfAborted();
  const prepared = await prepareRegister(deps, repo, sha, signal);
  signal.throwIfAborted();
  if (prepared.isOk()) {
    return { kind: "passed", sha, riskTier: prepared.value.classifierLog.risk_tier };
  }
  return match(prepared.error)
    .returnType<RegisterDryRun>()
    .with({ kind: "refused" }, ({ errors }) => ({
      kind: "refused",
      sha,
      findings: boundFindings(errors),
    }))
    .with({ kind: "unavailable" }, ({ cause, error }) => ({
      kind: "unavailable",
      sha,
      cause,
      detail: cutDryRunText(error),
    }))
    .with({ kind: "stale_base" }, ({ mainSha }) => ({ kind: "stale_base", sha, mainSha }))
    .exhaustive();
}

/**
 * The first 100 findings, each cut at 400 code points, then one per check
 * counting what it found past them, the check being a finding's leading
 * `<id>:` (design/coding-delegation.md → Skills-repo pre-submit → Sizes).
 */
function boundFindings(findings: readonly string[]): readonly string[] {
  const left = R.countBy(findings.slice(MAX_FINDINGS), (finding) => finding.split(":", 1)[0] ?? "");
  return [
    ...findings.slice(0, MAX_FINDINGS).map(cutDryRunText),
    ...Object.entries(left).map(([check, n]) => `${check}: and ${n} more ${check} findings`),
  ];
}
