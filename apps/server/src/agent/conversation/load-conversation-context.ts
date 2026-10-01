import type { Transaction, Transactor } from "../../db/index.js";
import { type CoreMemoryScope, type CoreMemoryView, readCoreMemory } from "../core-memory/scope.js";
import type { SectionedRule } from "../rule-sections.js";
import type { CoreMemoryStore, Profile, SteeringRuleStore } from "../store/index.js";

/**
 * Load what the prompt assembler renders: the steering rules the profile and
 * the conversation's user see, every channel's included, and the user's core
 * memory blocks the turn's scope sees. A scope without core memory (a
 * third-party or unloadable profile) withholds the user's instruction rules
 * as it withholds core memory: their text can carry what core memory holds.
 * The reads share one tx and see a consistent snapshot under the project's
 * REPEATABLE READ default.
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
  agentStore: SteeringRuleStore & CoreMemoryStore;
}

export interface LoadConversationContextArgs {
  /** The conversation's user, whose core memory blocks and instruction rules the prompt renders. */
  userId: string;
  /** Which of those the turn sees (`loadCoreMemoryScope`, frozen in a turn). */
  coreMemoryScope: CoreMemoryScope;
  /**
   * Pre-loaded profile from the orchestrator. `undefined` when the
   * profile row was missing (deleted mid-turn, etc.); in that case the
   * use case skips the rule lookup since rules are scoped to a profile.
   */
  profile: Profile | undefined;
}

export interface ConversationContext {
  rules: ReadonlyArray<SectionedRule>;
  coreMemory: CoreMemoryView;
}

export async function loadConversationContext(
  deps: LoadConversationContextDeps,
  args: LoadConversationContextArgs,
): Promise<ConversationContext> {
  return deps.runInTx((tx) => readConversationContext(tx, deps.agentStore, args));
}

/** The same reads in a caller's transaction. */
export async function readConversationContext(
  tx: Transaction,
  agentStore: SteeringRuleStore & CoreMemoryStore,
  args: LoadConversationContextArgs,
): Promise<ConversationContext> {
  const rules = args.profile
    ? await agentStore.getActiveRules(tx, {
        profileId: args.profile.id,
        userId: args.coreMemoryScope.kind === "none" ? null : args.userId,
      })
    : [];
  const coreMemory = await readCoreMemory(tx, agentStore, args.userId, args.coreMemoryScope);
  return { rules, coreMemory };
}
