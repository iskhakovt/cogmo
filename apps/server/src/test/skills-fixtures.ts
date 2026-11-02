/** `RegisterResult` builders for tests of what consumes a deploy outcome. */

import type { DeployFacts } from "../skills/deploy/deploy-facts.js";
import type { RegisterResult } from "../skills/runner.js";

type LiveResult = Extract<RegisterResult, { status: "live" }>;
type PendingResult = Extract<RegisterResult, { status: "pending_approval" }>;

export const FIXTURE_SKILL_ID = "019d0000-0000-7000-8000-0000000000ab";
export const FIXTURE_DEPLOY_ID = "019d0000-0000-7000-8000-0000000000cd";

/** A first deploy declaring nothing. */
export function deployFactsFixture(overrides: Partial<DeployFacts> = {}): DeployFacts {
  return {
    description: "Echoes its input back.",
    effects: { declared: [], detected: [] },
    hosts: [],
    secrets: [],
    dependencies: [],
    schedule: null,
    reasons: [],
    priorGitSha: null,
    ...overrides,
  };
}

export function liveRegisterResult(overrides: Partial<LiveResult> = {}): LiveResult {
  return {
    name: "echo",
    riskTier: "notify",
    status: "live",
    gitSha: "abc1234",
    skillId: FIXTURE_SKILL_ID,
    deployId: FIXTURE_DEPLOY_ID,
    facts: deployFactsFixture(),
    ...overrides,
  };
}

export function pendingRegisterResult(overrides: Partial<PendingResult> = {}): PendingResult {
  return {
    name: "notifier",
    riskTier: "approve",
    status: "pending_approval",
    gitSha: "abcdef0123456789",
    skillId: FIXTURE_SKILL_ID,
    deployId: FIXTURE_DEPLOY_ID,
    facts: deployFactsFixture({ effects: { declared: ["sends_message"], detected: [] } }),
    ...overrides,
  };
}
