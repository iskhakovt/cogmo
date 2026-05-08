import type { Transactor } from "../../db/index.js";
import type { TransportStore } from "../../transport/store/index.js";
import type { AgentStore, Profile } from "../store/index.js";

/**
 * Compose the per-turn context the prompt assembler needs: the
 * active `Profile`, the channel types currently delivering the
 * conversation, and the steering rules at the intersection. Three
 * reads share one tx — under Postgres' default READ COMMITTED, that
 * means each statement still sees its own freshly-committed snapshot,
 * so a concurrent session-close or rule-promotion can land between
 * the reads. We accept that here: the profile is effectively immutable
 * during a turn, and channel-types / rules drift in a non-harmful way
 * for prompt assembly. If a strictly consistent snapshot is ever
 * needed, lift to REPEATABLE READ via `tx.transaction(cb, { isolationLevel })`.
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
  profileId: string;
}

export interface ConversationContext {
  profile: Profile | undefined;
  channelTypes: ReadonlyArray<string>;
  rules: ReadonlyArray<{ rule: string }>;
}

export async function loadConversationContext(
  deps: LoadConversationContextDeps,
  args: LoadConversationContextArgs,
): Promise<ConversationContext> {
  return deps.runInTx(async (tx) => {
    const profile = await deps.agentStore.getProfile(tx, args.profileId);
    const channelTypes = await deps.transportStore.getActiveChannelTypes(tx, args.conversationId);
    const rules = await deps.agentStore.getActiveRules(tx, args.profileId, channelTypes);
    return { profile, channelTypes, rules };
  });
}
