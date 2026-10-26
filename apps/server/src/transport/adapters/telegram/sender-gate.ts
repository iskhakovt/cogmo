import type { Context, MiddlewareFn } from "grammy";
import { logger } from "../../../logger.js";
import type { Transport } from "../../transport.js";

/**
 * Drop an update unless the channel admits its sender, and answer nothing:
 * any answer tells a stranger the bot is live (design/transport/identity.md →
 * Allowlist enforcement). An update with no sender (a channel post) has no
 * identity to admit, and no handler takes one. A failed check drops the
 * update too: grammY has already marked it handled, and rethrowing would
 * hand the whole update, content included, to `bot.catch`'s log.
 */
export function senderGate(transport: Pick<Transport, "senders">): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const updateId = ctx.update.update_id;
    if (ctx.from === undefined) {
      logger.info({ updateId }, "telegram: dropped an update with no sender");
      return;
    }
    const handle = String(ctx.from.id);
    let admitted: boolean;
    try {
      admitted = await transport.senders.admits(handle);
    } catch (err) {
      logger.error(
        { handle, updateId, err },
        "telegram: dropped an update whose sender check failed",
      );
      return;
    }
    if (!admitted) {
      logger.info(
        { handle },
        "telegram: dropped an update from a sender the channel doesn't admit",
      );
      return;
    }
    await next();
  };
}
