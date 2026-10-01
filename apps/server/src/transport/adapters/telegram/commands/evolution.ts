/** `/learned` and `/reflect`: the Observer's audit log and its manual trigger. */

import { match } from "ts-pattern";
import { MIN_MESSAGES_FOR_EXTRACTION } from "../../../../agent/evolution/index.js";
import type { Transport } from "../../../transport.js";
import { formatEvolutionDetail, formatEvolutionDigest } from "./evolution-format.js";
import { looksLikeUuid } from "./lookup.js";
import { errorMessage, shortenId, type TelegramCommandContext } from "./reply.js";

const USAGE =
  "Usage: /learned [<id>]\n" +
  "  /learned         → recent evolution events (newest first)\n" +
  "  /learned <id>    → full detail for one event (copy id from the list)";

/**
 * `/learned` — list the most recent evolution events for the user.
 * `/learned <id>` — detail view for one event.
 *
 * Surfaces the audit log written by every processed Observer fire (both
 * autonomous on `conversation/idle` and manual via `/reflect`). The digest
 * shows enough to spot what changed at a glance; the detail view fans out
 * each branch (corrections / memories / consolidation / pending drain).
 *
 * See `design/evolution.md` → Audit Log & Manual Trigger.
 */
export async function handleLearned(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const handle = String(ctx.from.id);
  const arg = ctx.match?.trim() ?? "";

  if (arg === "") {
    const res = await transport.evolution.listEvents(handle, { limit: 10 });
    if (res.isErr()) {
      await ctx.reply(errorMessage(res.error));
      return;
    }
    if (res.value.length === 0) {
      await ctx.reply(
        "No evolution events yet. The Observer runs after a conversation goes idle, " +
          "or you can run it now with /reflect.",
      );
      return;
    }
    await ctx.reply(formatEvolutionDigest(res.value, new Date()));
    return;
  }

  // Anything else is treated as an id lookup. Reject obviously-bad shapes
  // early so the DB hit only happens on plausible UUIDs.
  if (!looksLikeUuid(arg)) {
    await ctx.reply(USAGE);
    return;
  }

  const res = await transport.evolution.getEvent(handle, arg);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  if (res.value === null) {
    await ctx.reply(`No evolution event with id "${shortenId(arg)}". Use /learned to list.`);
    return;
  }
  await ctx.reply(formatEvolutionDetail(res.value, new Date()));
}

/**
 * `/reflect` — run the Observer synchronously for the current conversation
 * and reply with a one-line digest. The autonomous idle-fire path is
 * untouched; this is the user-initiated debug-shaped trigger that lets the
 * operator see what extraction would do without waiting for idle.
 *
 * Respects the same min-message gate (`MIN_MESSAGES_FOR_EXTRACTION = 4`)
 * as the autonomous path — too-short conversations reply with a clear
 * "not enough yet" message rather than silently no-op.
 */
export async function handleReflect(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const handle = String(ctx.from.id);
  const addr = String(ctx.chat.id);

  await ctx.reply("Reflecting on this conversation…");

  const res = await transport.evolution.triggerReflection(handle, addr);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }

  const outcome = res.value;
  await match(outcome)
    .with({ status: "no_session" }, () =>
      ctx.reply("No active conversation here — send a message first."),
    )
    .with({ status: "skipped" }, ({ reason }) => {
      const message =
        reason === "too_short"
          ? `Conversation too short to reflect on yet (need at least ${MIN_MESSAGES_FOR_EXTRACTION} messages).`
          : // `conversation_not_found` / `profile_not_found` mean the underlying
            // row vanished mid-call — surfaces as a soft error rather than an
            // exception so the command doesn't crash the bot.
            "Couldn't load the conversation. Try /sessions to confirm it's there.";
      return ctx.reply(message);
    })
    .with({ status: "processed" }, (processed) => {
      const {
        ruleChanges,
        memoryCount,
        drained,
        withheld,
        skippedForUnseenRules,
        deferredToFirstParty,
        eventId,
      } = processed;
      const ruleSummary =
        ruleChanges.extracted +
          ruleChanges.reinforced +
          ruleChanges.promoted +
          ruleChanges.retired +
          ruleChanges.reset ===
        0
          ? "no rule changes"
          : `${ruleChanges.extracted} new, ${ruleChanges.reinforced} reinforced, ${ruleChanges.promoted} promoted` +
            (ruleChanges.retired > 0 ? `, ${ruleChanges.retired} retired` : "") +
            (ruleChanges.reset > 0 ? `, ${ruleChanges.reset} reset` : "");
      const extraction =
        skippedForUnseenRules > 0
          ? "extraction skipped (a user's memory rule this profile can't see)"
          : `${memoryCount} extracted`;
      const memorySummary =
        memoryCount === 0 &&
        drained === 0 &&
        withheld === 0 &&
        skippedForUnseenRules === 0 &&
        deferredToFirstParty === 0
          ? "no memories"
          : `${extraction}, ${drained} drained` +
            (withheld > 0 ? `, ${withheld} withheld` : "") +
            (deferredToFirstParty > 0 ? `, ${deferredToFirstParty} deferred` : "");
      return ctx.reply(
        `Reflected. Rules: ${ruleSummary}. Memories: ${memorySummary}.\n` +
          `/learned ${eventId} for the full breakdown.`,
      );
    })
    .exhaustive();
}
