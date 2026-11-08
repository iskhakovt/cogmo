import type { SystemPromptEpochReason } from "../store/schema.js";
import { type EpochSnapshot, epochOf } from "../system-prompt-snapshot.js";
import {
  type RenderSystemPromptArgs,
  renderSystemPrompt,
  type SystemPromptDeps,
} from "./render-system-prompt.js";

/**
 * Render the system prompt and store it as the epoch `openedBy` opens. The
 * render and the insert share a transaction, so the row's `created_at` is when
 * the core memory it shows was read, which later turns count changes from.
 * A retry after the insert committed returns the stored row as `recovered`.
 */
export async function openSystemPromptEpoch(
  deps: SystemPromptDeps,
  args: RenderSystemPromptArgs & {
    conversationId: string;
    openedBy: string;
    historyStart: string;
    attachmentCutoff: string | null;
    reason: SystemPromptEpochReason;
  },
): Promise<{ kind: "new" | "recovered"; epoch: EpochSnapshot }> {
  return deps.runInTx(async (tx) => {
    const { rendered, configDigest } = await renderSystemPrompt(tx, deps, args);
    const { kind, row } = await deps.agentStore.insertOrRecoverSystemPromptSnapshot(tx, {
      conversationId: args.conversationId,
      openedBy: args.openedBy,
      historyStart: args.historyStart,
      rendered,
      configDigest,
      attachmentCutoff: args.attachmentCutoff,
      reason: args.reason,
    });
    return { kind, epoch: epochOf(row) };
  });
}
