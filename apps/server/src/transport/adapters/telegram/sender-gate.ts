/** The middleware ahead of every handler: an update the channel doesn't admit goes no further. */

import type { Context, MiddlewareFn } from "grammy";
import { logger } from "../../../logger.js";
import type { Transport } from "../../transport.js";

/**
 * Drop an update unless the channel admits its sender, before any handler
 * runs: no reply, no typing indicator, no download. A bot is publicly
 * discoverable, so any answer confirms it is live and tells a stranger what
 * it accepts. An update with no sender (a channel post) has no identity to
 * admit, and no handler takes one.
 */
export function senderGate(transport: Pick<Transport, "senders">): MiddlewareFn<Context> {
  return async (ctx, next) => {
    if (ctx.from === undefined) {
      logger.info({ updateId: ctx.update.update_id }, "telegram: dropped an update with no sender");
      return;
    }
    const handle = String(ctx.from.id);
    if (!(await transport.senders.admits(handle))) {
      logger.info(
        { handle },
        "telegram: dropped an update from a sender the channel doesn't admit",
      );
      return;
    }
    await next();
  };
}
