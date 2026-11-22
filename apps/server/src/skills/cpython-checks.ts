import type { Result } from "neverthrow";
import type { LockfileSnapshot } from "./deps.js";
import type { CheckFinding } from "./protocol.js";
import type { SkillSuppression } from "./types.js";

/** What register's CPython checks found, and the release of the toolchain that ran them. */
export interface CpythonCheckOutcome {
  /** Empty for files that pass. */
  findings: readonly CheckFinding[];
  /** The suppressions `skill.py` carries that the checks accept. */
  suppressions: readonly SkillSuppression[];
  /** The release version the skills image baked beside its toolchain. */
  toolchainVersion: string;
  /** Whether the skills image runs a skill's tests; an older image's does not. */
  testRunner: boolean;
}

/** Why register's CPython checks gave no outcome (design/skills.md → Register-time CPython checks). */
export type CpythonCheckError =
  /** uv refused the lockfile's own content: a verdict on the lockfile, terminal for the tip. */
  | { kind: "lockfile_invalid"; detail: string }
  /** A check could not run: nothing is wrong with the tip, and a retry may proceed. */
  | { kind: "unavailable"; detail: string };

/**
 * Register's CPython checks: CPython's compile, ruff, pyrefly and the import
 * check, over `skill.py` and `test_skill.py`, in a session of the skills
 * image, after an install session where the shared venv volume carries a
 * skill's dependencies to it.
 */
export interface CpythonChecks {
  check(params: {
    body: string;
    /** `test_skill.py`; null without one. */
    testBody: string | null;
    /** The manifest's `dependencies`, which the import check allows the modules of. */
    dependencies: readonly string[];
    /** The lockfile those dependencies install from; null without dependencies. */
    lockfile: LockfileSnapshot | null;
    signal: AbortSignal | undefined;
  }): Promise<Result<CpythonCheckOutcome, CpythonCheckError>>;
}
