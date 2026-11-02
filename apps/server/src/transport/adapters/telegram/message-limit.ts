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
  let end = TELEGRAM_MAX_MESSAGE_LENGTH - ELLIPSIS.length;
  // Never cut between the two code units of one character (an emoji).
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end) + ELLIPSIS;
}
