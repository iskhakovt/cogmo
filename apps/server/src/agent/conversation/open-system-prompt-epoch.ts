import type { Transactor } from "../../db/index.js";
import { type EpochSnapshot, epochOf } from "../system-prompt-snapshot.js";
import {
  type RenderSystemPromptArgs,
  type RenderSystemPromptDeps,
  renderSystemPrompt,
} from "./render-system-prompt.js";

export interface OpenSystemPromptEpochDeps extends RenderSystemPromptDeps {
  runInTx: Transactor;
}

/**
 * Render the system prompt and store it as the epoch `openedBy` opens. The
 * render and the insert share a transaction, so the row's `created_at` is when
 * the core memory it shows was read, which announcements count changes from.
 * A retry after the insert committed returns the stored row.
 */
export async function openSystemPromptEpoch(
  deps: OpenSystemPromptEpochDeps,
  args: RenderSystemPromptArgs & { conversationId: string; openedBy: string; historyStart: string },
): Promise<EpochSnapshot> {
  return deps.runInTx(async (tx) => {
    const { rendered, configDigest } = await renderSystemPrompt(tx, deps, args);
    const { row } = await deps.agentStore.insertOrRecoverSystemPromptSnapshot(tx, {
      conversationId: args.conversationId,
      openedBy: args.openedBy,
      historyStart: args.historyStart,
      rendered,
      configDigest,
    });
    return epochOf(row);
  });
}
