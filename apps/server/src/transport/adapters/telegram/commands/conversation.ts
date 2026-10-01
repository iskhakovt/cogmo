/** `/status`, `/voice`, `/repair`, `/compact`: acting on the chat's current conversation. */

import { match } from "ts-pattern";
import { isCoreCompartment } from "../../../../agent/evolution/memory-extraction-schema.js";
import type { Transport } from "../../../transport.js";
import { renderConversationStatus } from "../sessions-ux.js";
import { looksLikeUuid } from "./lookup.js";
import { errorMessage, type TelegramCommandContext } from "./reply.js";

/**
 * `/repair` — clear a conversation's auto-repair cooldown so the next
 * inbound runs normally.
 *
 * `/repair`              → acts on the current session's conversation.
 * `/repair <alias|uuid>` → acts on the named conversation.
 *
 * The user-facing escape hatch over `recover-conversation`'s automated
 * cooldown write. Idempotent — repairing a conversation that isn't
 * cooling down succeeds with a "no-op" reply rather than erroring.
 */
export async function handleRepair(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const handle = String(ctx.from.id);
  const addr = String(ctx.chat.id);
  const arg = ctx.match?.trim();

  let conversationId: string | undefined;
  let label: string;
  if (arg) {
    if (looksLikeUuid(arg)) {
      conversationId = arg;
      label = arg;
    } else {
      const list = await transport.conversations.list(handle);
      if (list.isErr()) {
        await ctx.reply(errorMessage(list.error));
        return;
      }
      const match = list.value.find((c) => c.alias === arg);
      if (!match) {
        await ctx.reply(`No conversation with alias "${arg}". Use /sessions to list.`);
        return;
      }
      conversationId = match.id;
      label = arg;
    }
  } else {
    const session = await transport.resolveSession(addr);
    if (!session) {
      await ctx.reply("No active conversation. Use /sessions and /resume <alias> first.");
      return;
    }
    conversationId = session.conversationId;
    label = "current conversation";
  }

  const res = await transport.conversations.repair(handle, conversationId);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  if (res.value.wasCoolingDown) {
    await ctx.reply(`Repaired ${label}. Send a message to retry.`);
  } else {
    await ctx.reply(`${label} isn't cooling down — nothing to repair.`);
  }
}

/**
 * `/voice` — set the per-conversation voice mode override.
 *
 * Forms:
 *   /voice                    — show the current effective mode + provider
 *   /voice auto               — mirror inbound modality (voice in → voice out)
 *   /voice always             — TTS every reply
 *   /voice off | /voice never — text only
 *   /voice clear              — clear override; follow profile default
 *
 * Mutates `conversations.voice_mode` via Transport.conversations.setVoiceMode.
 */
export async function handleVoice(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const handle = String(ctx.from.id);
  const addr = String(ctx.chat.id);
  const arg = ctx.match?.trim().toLowerCase() ?? "";

  const session = await transport.resolveSession(addr);
  if (!session) {
    await ctx.reply("No active conversation. Send a message first.");
    return;
  }
  const conversationId = session.conversationId;

  if (arg === "") {
    // Show current — read directly via getCurrent.
    const current = await transport.conversations.getCurrent(handle, addr);
    if (current.isErr()) {
      await ctx.reply(errorMessage(current.error));
      return;
    }
    const mode = current.value?.voiceMode ?? null;
    const label = mode === null ? "follow profile default" : mode;
    await ctx.reply(
      [
        `Voice mode: ${label}`,
        "",
        "Set: /voice auto | /voice always | /voice off",
        "Clear override: /voice clear",
      ].join("\n"),
    );
    return;
  }

  let mode: "auto" | "always" | "never" | null;
  if (arg === "auto") mode = "auto";
  else if (arg === "always") mode = "always";
  else if (arg === "off" || arg === "never") mode = "never";
  else if (arg === "clear") mode = null;
  else {
    await ctx.reply("Usage: /voice [auto|always|off|clear]");
    return;
  }

  const res = await transport.conversations.setVoiceMode(handle, conversationId, mode);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  const label = mode === null ? "cleared (following profile default)" : mode;
  await ctx.reply(`Voice mode: ${label}`);
}

/**
 * `/status` — show the active conversation's profile, last-turn token use,
 * steering rules, and MCP fan-out at a glance. Read-only, no LLM call.
 */
export async function handleStatus(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const handle = String(ctx.from.id);
  const addr = String(ctx.chat.id);
  const res = await transport.conversations.summary(handle, addr);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  if (!res.value) {
    await ctx.reply("No active conversation yet — send a message first.");
    return;
  }
  // Mirror replyProfileScope's conditional-fetch pattern: load the
  // customs / restricted-classes registries only when the rendered scope
  // can actually surface a marker, so a `/status` on an unscoped profile
  // doesn't pay for two extra round-trips. Both fetches degrade
  // best-effort — the user asked for status, not a registry list, so
  // a registry error renders without markers rather than failing.
  const summary = res.value;
  const scope = summary.profile.memoryScope;
  const needsCustoms = scope?.compartments.some((c) => !isCoreCompartment(c)) ?? false;
  const hasClasses = scope?.profileClasses !== undefined && scope.profileClasses.length > 0;
  const hasSpeaker = summary.profile.profileClass !== null;
  // Restricted markers can fire either inside `formatScope` (when the
  // scope sets profileClasses) or via the speaker auto-include rendering,
  // which appends the speaker class even when the operator's list omits
  // it. Both paths consult the restricted-class set, so fetch whenever
  // either could fire.
  const needsRestricted = hasClasses || hasSpeaker;
  const customsRes = needsCustoms ? await transport.compartments.list(handle) : undefined;
  const customs = customsRes?.isOk() ? new Set(customsRes.value.map((c) => c.name)) : undefined;
  const classesRes = needsRestricted ? await transport.profileClasses.list(handle) : undefined;
  const restrictedClasses = classesRes?.isOk()
    ? new Set(classesRes.value.filter((c) => c.restricted).map((c) => c.name))
    : undefined;
  await ctx.reply(
    renderConversationStatus(summary, {
      ...(customs !== undefined && { customCompartments: customs }),
      ...(restrictedClasses !== undefined && { restrictedClasses }),
    }),
  );
}

/**
 * `/compact` — summarize the conversation now and store the result.
 *
 * The pre-ack matters more here than on most commands: the summarization
 * round trip is the whole latency of the command, and it runs against the
 * profile's summarization model rather than returning from cache.
 */
export async function handleCompact(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const handle = String(ctx.from.id);
  const addr = String(ctx.chat.id);

  await ctx.reply("Compacting conversation…");

  const res = await transport.conversations.compact(handle, addr);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }

  // Exhaustive on the outcome, not just on the skip reason: a new status that
  // fell through would leave the user's pre-ack as the last thing they saw,
  // which is the dead end `compaction_failed` exists to prevent.
  const message = match(res.value)
    .with({ status: "no_session" }, () => "No active conversation here — send a message first.")
    .with(
      { status: "skipped", reason: "too_short" },
      () => "Nothing to compact — too little sits outside the retained window to be worth it.",
    )
    .with(
      { status: "skipped", reason: "nothing_new" },
      () => "Already compacted — a turn stored a summary for this span.",
    )
    .with(
      { status: "skipped", reason: "empty_summary" },
      () => "The summarization model returned no text — nothing stored. Try again.",
    )
    .with(
      { status: "skipped", reason: "truncated" },
      () =>
        "This conversation is too large to summarize in one pass — the summary hit the model's " +
        "output limit, so nothing was stored rather than freezing a half-written one. Re-running " +
        "won't help; /new starts a fresh conversation.",
    )
    .with(
      { status: "compacted" },
      (o) =>
        `Compacted ${o.messagesSummarized} message(s) into a summary via ${o.model}; ` +
        `${o.messagesKept} kept verbatim.\n` +
        "Your next turn starts from the summary — no compaction wait.",
    )
    .exhaustive();
  await ctx.reply(message);
}
