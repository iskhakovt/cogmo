import { match } from "ts-pattern";
import type { EventPublisher } from "../../inngest/durable.js";
import { type SkillsDeployOutcomeData, skillsDeployOutcome } from "../../inngest/events.js";
import { logger } from "../../logger.js";
import type { RegisterResult } from "./register-result.js";

const log = logger.child({ component: "skills.announce-outcome" });

/**
 * Tell the user how a register ended (design/skills.md → Notifications and
 * undo): emit `skills/deploy/outcome` for the deploy's conversation, which a
 * channel renders with the deploy's facts and buttons. `no_op` and an `auto`
 * deploy announce nothing. A rejection is announced only when
 * `announceRejections` is set: the coding-task auto-register has no other
 * voice, while `register_skill`'s rejection reaches the user through the
 * model, which also keeps a duplicate register (a `pending_deploy_exists`
 * rejection) silent. Runs after the deploy commits, so a failed emit is
 * logged and dropped rather than failing a deploy that already happened:
 * `/skills` lists every deploy.
 */
export async function announceDeployOutcome(
  deps: { publisher: EventPublisher },
  args: { result: RegisterResult; conversationId: string; announceRejections: boolean },
): Promise<void> {
  const data = outcomeEventData(args.result, args.conversationId, args.announceRejections);
  if (data === null) return;
  try {
    await deps.publisher.send({ name: skillsDeployOutcome.name, data });
  } catch (err) {
    log.error(
      {
        err,
        outcome: data.outcome,
        skillName: data.skillName,
        gitSha: data.gitSha,
        conversationId: args.conversationId,
      },
      "failed to emit skills/deploy/outcome; /skills still lists the deploy",
    );
  }
}

function outcomeEventData(
  result: RegisterResult,
  conversationId: string,
  announceRejections: boolean,
): SkillsDeployOutcomeData | null {
  return match(result)
    .returnType<SkillsDeployOutcomeData | null>()
    .with({ status: "live", riskTier: "auto" }, () => null)
    .with({ status: "rejected" }, (rejected) =>
      announceRejections
        ? {
            outcome: "rejected" as const,
            conversationId,
            skillName: rejected.name,
            gitSha: rejected.gitSha,
            errors: [...rejected.errors],
          }
        : null,
    )
    .with({ status: "live" }, { status: "pending_approval" }, (deployed) => ({
      outcome: deployed.status,
      conversationId,
      skillId: deployed.skillId,
      deployId: deployed.deployId,
      skillName: deployed.name,
      riskTier: deployed.riskTier,
      reasons: [...deployed.facts.reasons],
      gitSha: deployed.gitSha,
      priorGitSha: deployed.facts.priorGitSha,
      description: deployed.facts.description,
      effects: {
        declared: [...deployed.facts.effects.declared],
        detected: [...deployed.facts.effects.detected],
      },
      hosts: [...deployed.facts.hosts],
      secrets: deployed.facts.secrets.map((s) => ({ name: s.name, bound: s.bound })),
      dependencies: [...deployed.facts.dependencies],
      schedule: deployed.facts.schedule,
    }))
    .with({ status: "no_op" }, () => null)
    .exhaustive();
}
