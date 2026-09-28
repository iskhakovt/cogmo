import type { Chat, MessageOrigin } from "grammy/types";
import { match } from "ts-pattern";
import type { ForwardedOrigin, InboundTextBlock } from "../../content.js";

/**
 * A message's text or caption as an inbound text block, marked `forwarded`
 * when Telegram reports the message's `forward_origin`.
 */
export function inboundTextBlock(
  text: string,
  origin: MessageOrigin | undefined,
): InboundTextBlock {
  return { type: "text", text, ...(origin !== undefined && { forwarded: forwardedFrom(origin) }) };
}

function forwardedFrom(origin: MessageOrigin): ForwardedOrigin {
  const from = match(origin)
    .with({ type: "user" }, (o) => personName(o.sender_user))
    .with({ type: "hidden_user" }, (o) => o.sender_user_name)
    .with({ type: "chat" }, (o) => signed(chatName(o.sender_chat), o.author_signature))
    .with({ type: "channel" }, (o) => signed(o.chat.title, o.author_signature))
    .exhaustive();
  return { origin: origin.type, from, sentAt: new Date(origin.date * 1000).toISOString() };
}

function personName(person: { first_name: string; last_name?: string }): string {
  return person.last_name === undefined
    ? person.first_name
    : `${person.first_name} ${person.last_name}`;
}

function chatName(chat: Chat): string {
  return chat.type === "private" ? personName(chat) : chat.title;
}

/** A chat's name with the post author's signature, when the post carries one. */
function signed(name: string, signature: string | undefined): string {
  return signature === undefined ? name : `${name} (${signature})`;
}
