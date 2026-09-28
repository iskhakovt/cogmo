import type { Transaction, Transactor } from "../../db/index.js";
import type { ToolDefinition } from "../../llm/types.js";
import type { CoreMemoryScope, CoreMemoryView } from "../core-memory/scope.js";
import type { PromptSource } from "../prompt.js";
import type { AgentStore, Profile } from "../store/index.js";
import { configDigest, hasIdentityOverride } from "../system-prompt-snapshot.js";
import { readConversationContext } from "./load-conversation-context.js";

/** What loading and opening a chat turn's system prompt epoch need. */
export interface SystemPromptDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  promptSource: PromptSource;
}

export interface RenderSystemPromptArgs {
  /** The conversation's user, whose core memory `# User` renders. */
  userId: string;
  /** The profile row the turn loaded; `undefined` when it is gone, which renders no rules. */
  profile: Profile | undefined;
  /** Which core memory the turn sees (`freeze-core-memory-scope`). */
  coreMemoryScope: CoreMemoryScope;
  /** The definitions `# Tools` lists: the frozen tool table's. */
  toolDefinitions: ReadonlyArray<ToolDefinition>;
  /** The frozen tool table (`freeze-turn-inputs`), whose `tools` the epoch sends. */
  toolTable: string;
}

/**
 * A chat turn's system prompt as it renders now, from `tx`'s snapshot of the
 * steering rules and core memory; its configuration digest; and the core
 * memory it shows.
 */
export async function renderSystemPrompt(
  tx: Transaction,
  deps: Pick<SystemPromptDeps, "agentStore" | "promptSource">,
  args: RenderSystemPromptArgs,
): Promise<{ rendered: string; configDigest: string; coreMemory: CoreMemoryView }> {
  const { rules, coreMemory } = await readConversationContext(tx, deps.agentStore, args);
  const context = {
    profile: args.profile,
    rules,
    coreMemory,
    toolDefinitions: args.toolDefinitions,
  };
  return {
    rendered: await deps.promptSource.assemble(context),
    configDigest: configDigest({
      configuration: await deps.promptSource.configuration(context),
      toolTable: args.toolTable,
      scope: args.coreMemoryScope,
      identityOverride: hasIdentityOverride(coreMemory),
    }),
    coreMemory,
  };
}
