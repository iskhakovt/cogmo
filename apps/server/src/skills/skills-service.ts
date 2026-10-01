import type { Inngest } from "inngest";
import { skillsDeployApprovalRequested } from "../inngest/events.js";
import { logger } from "../logger.js";
import type { RegisterResult, SkillRunner } from "./runner.js";
import type { SkillRunIdentity } from "./store/index.js";

const log = logger.child({ component: "skills.service" });

/**
 * Service.skills — the agent-facing surface of {@link SkillRunner}.
 *
 * The full SkillRunner has operator methods (approve, deny, rollback,
 * deregister) that the agent shouldn't call mid-conversation. This namespace
 * exposes only the authoring-loop step: register a freshly-pushed feature
 * branch, with the turn's conversation as the deploy's origin.
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
}

/**
 * Conversation-scoped — `conversationId` is required so the approval-keyboard
 * event can be routed back to the originating chat. Construct one per
 * conversation turn (see `agent/handle-message/chat-turn-service.ts`); the CLI calls
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
  /** The turn's user and profile: a schedule this service puts live runs as them. */
  origin: SkillRunIdentity;
}

export function createSkillsService(deps: SkillsServiceDeps): SkillsService {
  return {
    async register(opts) {
      const result = await deps.runner.register({
        ...opts,
        origin: { kind: "conversation", ...deps.origin },
      });
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
              schedule: result.schedule ?? null,
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
  };
}
