import type { RegisterResult, SkillRunner } from "./runner.js";

/**
 * Service.skills — the agent-facing surface of {@link SkillRunner}.
 *
 * The full SkillRunner has CLI-only methods (deregister, listToolDefs) that
 * the agent shouldn't call mid-conversation. This namespace exposes only the
 * authoring-loop subset: register a freshly-pushed feature branch, optionally
 * follow up with approveDeploy / denyDeploy / rollback if the user requests it.
 */
export interface SkillsService {
  register(opts: { branch: string }): Promise<RegisterResult>;
  approveDeploy(opts: { pendingId: string; approvedBy?: string }): Promise<RegisterResult>;
  denyDeploy(opts: { pendingId: string; reason?: string }): Promise<void>;
  rollback(opts: { name: string; toGitSha: string }): Promise<RegisterResult>;
}

export function createSkillsService(runner: SkillRunner): SkillsService {
  return {
    register: (opts) => runner.register(opts),
    approveDeploy: (opts) => runner.approveDeploy(opts),
    denyDeploy: (opts) => runner.denyDeploy(opts),
    rollback: (opts) => runner.rollback(opts),
  };
}
