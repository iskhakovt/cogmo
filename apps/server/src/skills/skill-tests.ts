import type { Result } from "neverthrow";
import type { ResourceLimits } from "../sandbox/index.js";
import type { LockfileSnapshot } from "./deps.js";
import type { SkillTestsRequest, TestFinding } from "./protocol.js";

/** Why a skill's tests gave no pass (design/skills.md → Register-time tests → Outcomes). */
export type SkillTestsError =
  /** The suite's findings, terminal for the tip: its code runs inside pytest. */
  | { kind: "failed"; findings: readonly TestFinding[] }
  /** The suite could not run: nothing is wrong with the tip, and a retry may proceed. */
  | { kind: "unavailable"; detail: string };

/**
 * Register's run of a container-tier skill's `pytest` suite, in a session of
 * the skills image with no network interface.
 */
export interface SkillTests {
  /** Whether the backend creates a session with no network (`noNetworkSessions`). */
  offline: boolean;
  /** Whether the shared venv volume carries the install session's venv to the test session. */
  sharedVenv: boolean;
  /**
   * Run the suite over the skill's files. With a lockfile, the session mounts
   * the shared venv volume, which register's install session populated; a
   * lockfile without it, or a backend that is not `offline`, is a caller bug.
   * Resolves to the count of tests the run held.
   */
  run(params: {
    files: SkillTestsRequest["files"];
    lockfile: LockfileSnapshot | null;
    /** The skill's own limits, which the session takes where they exceed the defaults. */
    resourceLimits: Partial<ResourceLimits>;
    signal: AbortSignal | undefined;
  }): Promise<Result<number, SkillTestsError>>;
}
