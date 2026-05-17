import type { Transactor } from "../../db/index.js";
import type { TransportStore } from "../../transport/store/index.js";
import type { AgentStore, Profile } from "../store/index.js";

/**
 * Compose the steering-rule context the prompt assembler needs: the
 * channel types currently delivering the conversation and the steering
 * rules at the intersection of `(profile, channels)`. Two reads share
 * one tx and see a consistent snapshot under the project's REPEATABLE
 * READ default.
 *
 * The `Profile` row is NOT re-read here — the orchestrator passes the
 * row it already loaded for voice-mode + tool-catalog resolution, so a
 * concurrent `/settings` mid-turn can't make the prompt's tool-filter
 * disagree with its base prompt.
 *
 * Use-case shape: `function name(deps, args)` in a kebab-case file
 * under the relevant domain folder. `deps` carries store interfaces +
 * a `Transactor`; `args` carries per-call inputs.
 */
export interface LoadConversationContextDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  transportStore: TransportStore;
}

export interface LoadConversationContextArgs {
  conversationId: string;
  /**
   * Pre-loaded profile from the orchestrator. `undefined` when the
   * profile row was missing (deleted mid-turn, etc.); in that case the
   * use case skips the rule lookup since rules are scoped to a profile.
   */
  profile: Profile | undefined;
}

export interface ConversationContext {
  channelTypes: ReadonlyArray<string>;
  rules: ReadonlyArray<{ rule: string }>;
}

export async function loadConversationContext(
  deps: LoadConversationContextDeps,
  args: LoadConversationContextArgs,
): Promise<ConversationContext> {
  return deps.runInTx(async (tx) => {
    const channelTypes = await deps.transportStore.getActiveChannelTypes(tx, args.conversationId);
    const rules = args.profile
      ? await deps.agentStore.getActiveRules(tx, args.profile.id, channelTypes)
      : [];
    return { channelTypes, rules };
  });
}
