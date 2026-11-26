/** `/learned` and `/reflect`: the Observer's audit log and its manual trigger. */

import { match } from "ts-pattern";
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
 * operator see what extraction would do without waiting for idle. A fire
 * with no turn left to observe and no staged row replies that nothing is new.
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
    .with({ status: "skipped" }, ({ reason }) =>
      ctx.reply(
        match(reason)
          .with("nothing_new", () => "Nothing new since the Observer last ran.")
          // The row vanished mid-call: a soft error, so the command doesn't crash the bot.
          .with(
            "conversation_not_found",
            "profile_not_found",
            () => "Couldn't load the conversation. Try /sessions to confirm it's there.",
          )
          .exhaustive(),
      ),
    )
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
        `${memoryCount} extracted` +
        (skippedForUnseenRules > 0
          ? `, ${skippedForUnseenRules} turn(s) held (a user's memory rule a profile can't see)`
          : "");
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
