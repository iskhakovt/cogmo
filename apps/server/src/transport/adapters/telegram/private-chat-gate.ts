import type { Context, MiddlewareFn } from "grammy";
import { logger } from "../../../logger.js";

/**
 * Drop an update unless it comes from a private chat, and answer nothing
 * (design/transport/telegram.md → Scope). A reply carries the user's personal
 * memory, and in a group, supergroup or channel every member would read it.
 * An update with no chat (an inline query, a tap on an inline-mode message)
 * has no private chat to answer in, so it stops here too.
 */
export function privateChatGate(): MiddlewareFn<Context> {
  return async (ctx, next) => {
    if (ctx.chat?.type !== "private") {
      logger.info(
        { updateId: ctx.update.update_id, chatId: ctx.chat?.id, chatType: ctx.chat?.type },
        "telegram: dropped an update from outside a private chat",
      );
      return;
    }
    await next();
  };
}
