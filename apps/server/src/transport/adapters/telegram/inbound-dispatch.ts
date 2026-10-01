/**
 * Where a chat's inbound goes: into an open boundary hold, to the active
 * session, behind a new boundary prompt, or into a fresh conversation.
 */

import type { Bot } from "grammy";
import { logger } from "../../../logger.js";
import type { AdapterDeps } from "../../adapter-module.js";
import type { InboundContent } from "../../content.js";
import type { BufferedInboundEntry, PriorClosedConversation } from "../../store/index.js";
import type { Transport } from "../../transport.js";

/**
 * Max characters in the first-user-message snippet used for the "↶ Resume X"
 * button label. Telegram inline button labels render up to ~40 chars cleanly
 * before truncation on mobile; this leaves room for the `↶ Resume ` prefix.
 */
const BOUNDARY_SNIPPET_MAX_CHARS = 25;

export interface InboundDispatchDeps {
  transport: Transport;
  api: Bot["api"];
  boundary: AdapterDeps["boundary"];
}

/** Dispatch one inbound for `addr`, after the ones already in flight for it. */
export type DispatchInbound = (
  ctx: { reply: (text: string) => Promise<{ message_id: number }> },
  addr: string,
  handle: string,
  content: InboundContent,
  platformTs: Date,
) => Promise<void>;

function boundaryButtonLabel(prior: PriorClosedConversation): string {
  // Snippet is already capped at BOUNDARY_SNIPPET_MAX_CHARS by the store;
  // alias is user-set and unbounded — truncate to the same cap so a long
  // emoji-laden alias can't push the button past Telegram's 64-byte
  // callback-text limit. Code-point slice (Array.from) so multi-byte
  // graphemes don't split mid-char.
  const raw = prior.alias ?? prior.firstUserSnippet ?? "previous chat";
  const chars = Array.from(raw);
  return chars.length <= BOUNDARY_SNIPPET_MAX_CHARS
    ? raw
    : `${chars.slice(0, BOUNDARY_SNIPPET_MAX_CHARS - 1).join("")}…`;
}

/**
 * Send the boundary prompt and persist the hold. Two-message-API trip:
 * `ctx.reply` first to obtain a message id, then `editMessageReplyMarkup`
 * once the boundary row exists (so the inline-keyboard `callback_data` can
 * carry the row's id). The intermediate state — prompt text without
 * buttons — is only visible for the round-trip latency.
 *
 * Returns `true` when the hold was created (caller should NOT emit the
 * inbound; it's buffered). Returns `false` to fall through to fresh-create.
 */
async function fireBoundaryPrompt(
  { transport, api, boundary: boundaryConfig }: InboundDispatchDeps,
  ctx: { reply: (text: string) => Promise<{ message_id: number }> },
  addr: string,
  handle: string,
  prior: PriorClosedConversation,
  firstInbound: BufferedInboundEntry,
): Promise<boolean> {
  let promptMessageId: number | null = null;
  try {
    const label = boundaryButtonLabel(prior);
    const sent = await ctx.reply(
      "It's been a while since our last chat. Pick up where we left off, or start fresh?",
    );
    promptMessageId = sent.message_id;
    const { boundaryId } = await transport.boundary.start({
      platformAddress: addr,
      platformUserHandle: handle,
      priorConversationId: prior.conversationId,
      promptMessageId: String(sent.message_id),
      firstInbound,
      timeoutMs: boundaryConfig.promptTimeoutMs,
    });
    await api.editMessageReplyMarkup(addr, sent.message_id, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: `↶ Resume ${label}`, callback_data: `boundary:${boundaryId}:resume` },
            { text: "✦ Start fresh", callback_data: `boundary:${boundaryId}:fresh` },
          ],
        ],
      },
    });
    return true;
  } catch (err) {
    logger.error({ err }, "telegram: failed to fire boundary prompt — falling back to fresh");
    // If `ctx.reply` succeeded but a later step (boundary.start /
    // editMessageReplyMarkup) threw, the user is staring at a
    // button-less "Pick up where we left off?" prompt with no follow-up.
    // Best-effort delete so the caller's createConversation+emit fallback
    // produces a clean reply thread. Failure to delete is logged at warn
    // — the user just sees a stale prompt above the agent reply.
    if (promptMessageId !== null) {
      try {
        await api.deleteMessage(addr, promptMessageId);
      } catch (delErr) {
        logger.warn(
          { err: delErr, promptMessageId },
          "telegram: failed to delete dangling boundary prompt",
        );
      }
    }
    return false;
  }
}

/**
 * Single entry point for every channel-side inbound (text, photo, document,
 * voice). Routes through the boundary-hold gate before falling back to the
 * normal `resolveSession` → `createConversation` → `emit` flow.
 *
 *   1. If a hold is already open for this address, append + return.
 *   2. `resolveSession` — if active, emit normally.
 *   3. Else `boundary.peek` — if there's a substantive prior, fire the
 *      prompt + buffer the inbound and return.
 *   4. Else `createConversation` + emit as before.
 */
async function doDispatch(
  deps: InboundDispatchDeps,
  ctx: { reply: (text: string) => Promise<{ message_id: number }> },
  addr: string,
  handle: string,
  content: InboundContent,
  platformTs: Date,
): Promise<void> {
  const { transport, boundary: boundaryConfig } = deps;
  const buffered: BufferedInboundEntry = {
    content,
    platformTs: platformTs.toISOString(),
  };

  const pending = await transport.boundary.findActive(addr);
  if (pending) {
    await transport.boundary.append(pending.id, buffered);
    return;
  }

  let session = await transport.resolveSession(addr);
  if (!session) {
    const prior = await transport.boundary.peek(
      addr,
      boundaryConfig.minUserTurns,
      BOUNDARY_SNIPPET_MAX_CHARS,
    );
    if (prior) {
      const fired = await fireBoundaryPrompt(deps, ctx, addr, handle, prior, buffered);
      if (fired) return;
    }
    const result = await transport.createConversation(addr, handle, { isPrivate: true });
    if (result.isErr()) {
      if (result.error.code === "identity_rejected") {
        logger.info({ handle }, "telegram: rejected unauthorized user");
      } else {
        logger.error({ error: result.error }, "failed to create conversation");
      }
      return;
    }
    session = result.value;
  }

  const emitResult = await transport.emit(session.id, content, platformTs);
  if (emitResult.isErr()) {
    logger.error({ error: emitResult.error }, "failed to emit message");
  }
}

/**
 * Per-chat dispatch tail. Serialises `dispatchInbound` calls keyed on
 * `addr` so two inbounds arriving close-together don't both observe
 * `findActive → null` + `peek → prior` and race to create competing
 * boundary holds (UNIQUE constraint catches the conflict but the loser
 * would otherwise fall through to `createConversation` and split the
 * chat across two conversations).
 *
 * grammY's default polling runner already serialises updates from one
 * chat through the middleware chain, so this is belt-and-braces — but
 * the cost is one Map entry per active chat and the future-proofing is
 * worth it for webhook deployments or concurrency-enabled runners.
 */
export function createInboundDispatch(deps: InboundDispatchDeps): DispatchInbound {
  const dispatchTails = new Map<string, Promise<void>>();

  return async function dispatchInbound(
    ctx: { reply: (text: string) => Promise<{ message_id: number }> },
    addr: string,
    handle: string,
    content: InboundContent,
    platformTs: Date,
  ): Promise<void> {
    const prev = dispatchTails.get(addr) ?? Promise.resolve();
    const myTurn = prev.then(() => doDispatch(deps, ctx, addr, handle, content, platformTs));
    // Wrap with a swallowed-error tail so a thrown body doesn't break the
    // chain for the next inbound on this chat.
    const tail: Promise<void> = myTurn.then(
      () => undefined,
      () => undefined,
    );
    dispatchTails.set(addr, tail);
    // Auto-cleanup once we're the still-most-recent tail.
    tail.then(() => {
      if (dispatchTails.get(addr) === tail) dispatchTails.delete(addr);
    });
    return myTurn;
  };
}
