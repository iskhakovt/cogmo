import type { Transactor } from "../../db/index.js";
import { type EpochSnapshot, epochOf } from "../system-prompt-snapshot.js";
import {
  type RenderSystemPromptArgs,
  type RenderSystemPromptDeps,
  renderSystemPrompt,
} from "./render-system-prompt.js";

export interface LoadSystemPromptDeps extends RenderSystemPromptDeps {
  runInTx: Transactor;
}

/** What a chat turn decides its epoch from; see `continuesEpoch`. */
export interface LoadedSystemPrompt {
  /** The system prompt as it renders now: what an epoch opened by this turn would send. */
  rendered: string;
  configDigest: string;
  /** The conversation's current epoch, or null before its first. */
  snapshot: EpochSnapshot | null;
}

/** Render a chat turn's system prompt and load the conversation's current epoch, in one read. */
export async function loadSystemPrompt(
  deps: LoadSystemPromptDeps,
  args: RenderSystemPromptArgs & { conversationId: string },
): Promise<LoadedSystemPrompt> {
  return deps.runInTx(async (tx) => {
    const latest = await deps.agentStore.getLatestSystemPromptSnapshot(tx, args.conversationId);
    return {
      ...(await renderSystemPrompt(tx, deps, args)),
      snapshot: latest === undefined ? null : epochOf(latest),
    };
  });
}
