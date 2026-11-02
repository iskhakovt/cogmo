import type { EventPublisher } from "../inngest/durable.js";
import { announceDeployOutcome } from "./deploy/announce-outcome.js";
import type { RegisterResult, SkillRunner } from "./runner.js";
import type { SkillRunIdentity } from "./store/index.js";

/**
 * Service.skills — the agent-facing surface of {@link SkillRunner}.
 *
 * The full SkillRunner has operator methods (approve, deny, rollback,
 * deregister) that the agent shouldn't call mid-conversation. This namespace
 * exposes only the authoring-loop step: register a freshly-pushed feature
 * branch, with the turn's conversation as the deploy's origin.
 *
 * Every register is announced in the turn's conversation
 * (`announceDeployOutcome`): a channel posts what went live with a Disable
 * button, a pending deploy with Approve / Deny, or the rejection's errors.
 */
export interface SkillsService {
  register(opts: { branch: string }): Promise<RegisterResult>;
}

/**
 * Conversation-scoped — `conversationId` is required so the outcome message
 * reaches the originating chat. Construct one per conversation turn (see
 * `agent/handle-message/chat-turn-service.ts`); the CLI calls
 * `runner.register` directly and skips this layer.
 */
export interface SkillsServiceDeps {
  runner: SkillRunner;
  /** Emits the deploy's `skills/deploy/outcome`. */
  inngest: EventPublisher;
  /** Conversation that originated this turn: where the outcome is posted. */
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
      await announceDeployOutcome(
        { publisher: deps.inngest },
        { result, conversationId: deps.conversationId },
      );
      return result;
    },
  };
}
