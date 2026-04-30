import type { Inngest } from "inngest";
import { skillsDeployApprovalRequested } from "../inngest/events.js";
import { logger } from "../logger.js";
import type { RegisterResult, SkillRunner } from "./runner.js";

const log = logger.child({ component: "skills.service" });

/**
 * Service.skills — the agent-facing surface of {@link SkillRunner}.
 *
 * The full SkillRunner has CLI-only methods (deregister, listToolDefs) that
 * the agent shouldn't call mid-conversation. This namespace exposes only the
 * authoring-loop subset: register a freshly-pushed feature branch, optionally
 * follow up with approveDeploy / denyDeploy / rollback if the user requests it.
 *
 * Approve-tier register also fires the
 * `skills/deploy/approval-requested` Inngest event so the per-channel
 * Telegram function can post the Approve / Deny keyboard into this turn's
 * conversation. The callback tap then routes directly to
 * `transport.skills.approveDeploy` / `denyDeploy` (the runner has already
 * returned; there's no `step.waitForEvent` to resume).
 */
export interface SkillsService {
  register(opts: { branch: string }): Promise<RegisterResult>;
  approveDeploy(opts: { pendingId: string; approvedBy?: string }): Promise<RegisterResult>;
  denyDeploy(opts: { pendingId: string; reason?: string }): Promise<void>;
  rollback(opts: { name: string; toGitSha: string }): Promise<RegisterResult>;
}

/**
 * Conversation-scoped — `conversationId` is required so the approval-keyboard
 * event can be routed back to the originating chat. Construct one per
 * conversation turn (see `handle-message.ts`); the CLI calls
 * `runner.register` directly and skips this layer.
 */
export interface SkillsServiceDeps {
  runner: SkillRunner;
  /** Inngest client used to fire approval-requested events. */
  inngest: Inngest;
  /**
   * Conversation that originated this turn — used as the recipient hint for
   * the approval keyboard so the per-channel Telegram function knows which
   * chat to post into.
   */
  conversationId: string;
}

export function createSkillsService(deps: SkillsServiceDeps): SkillsService {
  return {
    async register(opts) {
      const result = await deps.runner.register(opts);
      if (result.status === "pending_approval" && result.pendingId) {
        // Fire-and-forget: an event-emit failure shouldn't poison the
        // register (the deploy is already in pending_approval state on
        // skill_deploys). Worst case the user sees no keyboard and has to
        // approve via the CLI — surfaces in the logs.
        try {
          await deps.inngest.send({
            name: skillsDeployApprovalRequested.name,
            data: {
              pendingId: result.pendingId,
              skillName: result.name,
              gitSha: result.gitSha,
              conversationId: deps.conversationId,
            },
          });
        } catch (err) {
          log.error(
            { err, pendingId: result.pendingId, skillName: result.name },
            "failed to emit skills/deploy/approval-requested — approve via CLI",
          );
        }
      }
      return result;
    },
    approveDeploy: (opts) => deps.runner.approveDeploy(opts),
    denyDeploy: (opts) => deps.runner.denyDeploy(opts),
    rollback: (opts) => deps.runner.rollback(opts),
  };
}
