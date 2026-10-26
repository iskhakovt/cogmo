import { match } from "ts-pattern";
import { logger } from "../../logger.js";
import type { TransportContext } from "./context.js";

/** Who may use the channel at all, asked before an adapter does any work for an update. */
export interface SendersNamespace {
  /**
   * Whether `platformUserHandle` may use this channel: anyone on a `fixed`
   * channel, and on a `mapped` or `create` one only a handle with an identity
   * row. A channel with no row admits no one.
   */
  admits(platformUserHandle: string): Promise<boolean>;
}

export function createSenders(deps: Omit<TransportContext, "agentStore">): SendersNamespace {
  const { channelId, runInTx, transportStore } = deps;
  return {
    async admits(platformUserHandle) {
      return runInTx(async (tx) => {
        const mode = await transportStore.getChannelIdentityMode(tx, channelId);
        if (mode === undefined) {
          logger.warn({ channelId }, "senders: the adapter's channel has no row");
          return false;
        }
        // `create` admits only known handles until something auto-creates identities.
        return match(mode)
          .with("fixed", async () => true)
          .with(
            "mapped",
            "create",
            async () =>
              (await transportStore.resolveUser(tx, channelId, platformUserHandle)) !== undefined,
          )
          .exhaustive();
      });
    },
  };
}
