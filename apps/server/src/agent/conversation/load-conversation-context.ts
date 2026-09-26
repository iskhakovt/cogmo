import type { Transactor } from "../../db/index.js";
import type { TransportStore } from "../../transport/store/index.js";
import type { CoreMemoryBlock } from "../service.js";
import type { AgentStore, Profile } from "../store/index.js";

/**
 * Load what the prompt assembler renders: the channel types currently
 * delivering the conversation, the steering rules at the intersection of
 * `(profile, channels)`, and the core memory blocks of the conversation's
 * user. The reads share one tx and see a consistent snapshot under the
 * project's REPEATABLE READ default.
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
  /** The conversation's user, whose core memory blocks the prompt renders. */
  userId: string;
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
  coreMemory: ReadonlyArray<CoreMemoryBlock>;
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
    const coreMemory = await deps.agentStore.getCoreMemoryBlocks(tx, args.userId);
    return { channelTypes, rules, coreMemory };
  });
}
