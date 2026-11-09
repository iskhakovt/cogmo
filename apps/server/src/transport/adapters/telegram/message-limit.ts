import * as R from "remeda";

/** Telegram's cap on one message's text. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/** Telegram's cap on a callback query answer's text, the toast a tap shows. */
const TELEGRAM_MAX_TOAST_LENGTH = 200;

const ELLIPSIS = "…";

/**
 * `lines` packed into as few messages as fit under the cap, split only
 * between lines, so a line (a skill with its pending deploy id) is never cut
 * in two. A single line over the cap is fitted on its own.
 */
export function packTelegramMessages(lines: readonly string[]): string[] {
  const packed = R.reduce(
    lines,
    (acc: { messages: string[]; current: string }, line) => {
      const joined = acc.current === "" ? line : `${acc.current}\n${line}`;
      if (joined.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
        return { messages: acc.messages, current: joined };
      }
      return {
        messages: acc.current === "" ? acc.messages : [...acc.messages, acc.current],
        current: fitTelegramMessage(line),
      };
    },
    { messages: [], current: "" },
  );
  return packed.current === "" ? packed.messages : [...packed.messages, packed.current];
}

/**
 * `text` as Telegram accepts it in one message: unchanged when it fits, else
 * cut to the cap with an ellipsis. For a message whose facts also live in the
 * database (a deploy outcome), a shortened message beats a refused send.
 */
export function fitTelegramMessage(text: string): string {
  return fitTo(text, TELEGRAM_MAX_MESSAGE_LENGTH);
}

/**
 * `text` as Telegram accepts it in a callback query answer: unchanged when it
 * fits, else cut to the cap with an ellipsis. An answer over the cap fails,
 * and the tapper sees only the button's spinner.
 */
export function fitTelegramToast(text: string): string {
  return fitTo(text, TELEGRAM_MAX_TOAST_LENGTH);
}

function fitTo(text: string, cap: number): string {
  if (text.length <= cap) return text;
  let end = cap - ELLIPSIS.length;
  // Never cut between the two code units of one character (an emoji).
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end) + ELLIPSIS;
}
