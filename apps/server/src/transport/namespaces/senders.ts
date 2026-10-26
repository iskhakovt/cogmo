import type { TransportContext } from "./context.js";

/** Who may use the channel at all, asked before an adapter does any work for an update. */
export interface SendersNamespace {
  /**
   * Whether `platformUserHandle` may use this channel: anyone on a `fixed` or
   * `create` channel, and on a `mapped` one only a handle with an identity
   * row. A channel with any other mode, or no row, admits no one.
   */
  admits(platformUserHandle: string): Promise<boolean>;
}

export function createSenders(deps: Omit<TransportContext, "agentStore">): SendersNamespace {
  const { channelId, runInTx, transportStore } = deps;
  return {
    async admits(platformUserHandle) {
      return runInTx(async (tx) => {
        const mode = await transportStore.getChannelIdentityMode(tx, channelId);
        if (mode === "fixed" || mode === "create") return true;
        if (mode !== "mapped") return false;
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        return identity !== undefined;
      });
    },
  };
}
