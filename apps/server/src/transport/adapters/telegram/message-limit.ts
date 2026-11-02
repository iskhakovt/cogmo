/** Telegram's cap on one message's text. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

const ELLIPSIS = "…";

/**
 * `text` as Telegram accepts it in one message: unchanged when it fits, else
 * cut to the cap with an ellipsis. For a message whose facts also live in the
 * database (a deploy outcome, the skills inventory), a shortened message
 * beats a refused send.
 */
export function fitTelegramMessage(text: string): string {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) return text;
  return text.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH - ELLIPSIS.length) + ELLIPSIS;
}
