/** `/classes`: the profile-class registry. */

import type { Transport } from "../../../transport.js";
import { errorMessage, type TelegramCommandContext } from "./reply.js";

const USAGE =
  "Usage: /classes [list|add <name> <description>|rm <name> [confirm]|restrict <name>|unrestrict <name> [confirm]]\n" +
  "  /classes                          → list registered profile classes\n" +
  "  /classes add intimate <desc>      → register a new class for /profile class to reference\n" +
  "  /classes rm intimate              → remove a class (must not be assigned to any profile)\n" +
  "  /classes restrict intimate        → mark a class as restricted (recall fails closed unless opted in)\n" +
  "  /classes unrestrict intimate      → clear the restricted flag\n" +
  "  … confirm                         → go ahead when it deletes the class's core-memory blocks";

export async function handleClasses(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const handle = String(ctx.from.id);
  const trimmed = (ctx.match ?? "").trim();
  if (!trimmed) {
    return replyClassesList(transport, ctx, handle);
  }
  const [sub, ...rest] = trimmed.split(/\s+/).filter(Boolean);
  switch (sub) {
    case "list":
      return replyClassesList(transport, ctx, handle);
    case "add": {
      // Add takes a name (single token) plus a free-form description (rest).
      // Empty description is rejected at the Transport boundary by the
      // store's NOT NULL on `description`; we surface that with a clearer
      // message here.
      const name = rest[0]?.trim();
      const description = rest.slice(1).join(" ").trim();
      if (!name || !description) {
        await ctx.reply(USAGE);
        return;
      }
      return replyClassesAdd(transport, ctx, handle, name, description);
    }
    case "rm":
    case "remove":
    case "delete": {
      const target = parseConfirmable(rest);
      if (!target) {
        await ctx.reply(USAGE);
        return;
      }
      return replyClassesDelete(transport, ctx, handle, target.name, target.confirm);
    }
    case "restrict":
    case "unrestrict": {
      const target = parseConfirmable(rest);
      if (!target || (sub === "restrict" && target.confirm)) {
        await ctx.reply(USAGE);
        return;
      }
      return replyClassesSetRestricted(
        transport,
        ctx,
        handle,
        target.name,
        sub === "restrict",
        target.confirm,
      );
    }
    default:
      await ctx.reply(USAGE);
  }
}

async function replyClassesList(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
): Promise<void> {
  const res = await transport.profileClasses.list(handle);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  if (res.value.length === 0) {
    await ctx.reply(
      "No profile classes registered. Use /classes add <name> <description> to create one.",
    );
    return;
  }
  let sawRestricted = false;
  const lines = res.value.map((c) => {
    if (c.restricted) sawRestricted = true;
    const marker = c.restricted ? " (restricted)" : "";
    return `• ${c.name}${marker} — ${c.description}`;
  });
  const legend = sawRestricted
    ? "\n\n(restricted) — readers must opt in via /profile scope … classes=… or speak as the class."
    : "";
  await ctx.reply(`Profile classes:\n${lines.join("\n")}${legend}`);
}

/** `<name> [confirm]`, the arguments of the class commands that can delete core-memory blocks. */
function parseConfirmable(args: ReadonlyArray<string>): { name: string; confirm: boolean } | null {
  const [name, flag, ...extra] = args;
  if (name === undefined || extra.length > 0) return null;
  if (flag === undefined) return { name, confirm: false };
  return flag === "confirm" ? { name, confirm: true } : null;
}

async function replyClassesSetRestricted(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string,
  restricted: boolean,
  confirm: boolean,
): Promise<void> {
  const res = await transport.profileClasses.setRestricted(handle, name, restricted, { confirm });
  if (res.isErr()) {
    await ctx.reply(
      res.error.code === "profile_class_has_blocks"
        ? `Class "${name}" has its own identity block, which unrestricting deletes; the class then reads the shared one. To go ahead: /classes unrestrict ${name} confirm`
        : errorMessage(res.error),
    );
    return;
  }
  if (restricted) {
    await ctx.reply(
      `Class "${name}" marked restricted. Readers without an explicit opt-in (or that don't speak as "${name}") won't see its memories.`,
    );
  } else {
    const deleted = res.value.overrideDeleted
      ? " Its own identity block was deleted, so it reads the shared one."
      : "";
    await ctx.reply(
      `Class "${name}" no longer restricted.${deleted} Recall returns to open-by-default for this class.`,
    );
  }
}

/**
 * Names that collide with `/profile class <name> …` parser sentinels —
 * any class named "clear" is creatable but unaddressable here because
 * `replyProfileClass` interprets `clear` as the clear-action. Reject
 * up front so the user sees an actionable error instead of creating
 * a class they can't assign via Telegram.
 *
 * The reserve lives at the Telegram boundary (not Transport / store)
 * because "clear" is a string-parser ambiguity specific to this
 * adapter — a future REST adapter taking `{className: null}` for the
 * clear case has no such conflict, and pushing the reserve down would
 * over-constrain it. A direct `Transport.profileClasses.create` caller
 * (Direct adapter, scripts) can still create a class named `clear`;
 * it just won't be addressable via `/profile class … clear` until the
 * Telegram parser learns a different sentinel.
 */
const RESERVED_CLASS_NAMES = new Set(["clear"]);

async function replyClassesAdd(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string,
  description: string,
): Promise<void> {
  if (RESERVED_CLASS_NAMES.has(name.toLowerCase())) {
    await ctx.reply(
      `"${name}" is reserved (used by /profile class <name> clear). Pick a different class name.`,
    );
    return;
  }
  const res = await transport.profileClasses.create(handle, { name, description });
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  await ctx.reply(
    `Registered class "${res.value.name}". Assign it with /profile class <profile> ${res.value.name}.`,
  );
}

async function replyClassesDelete(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string,
  confirm: boolean,
): Promise<void> {
  const res = await transport.profileClasses.delete(handle, name, { confirm });
  if (res.isErr()) {
    await ctx.reply(
      res.error.code === "profile_class_has_blocks"
        ? `Removing class "${name}" deletes its core-memory blocks: ${res.error.keys.join(", ")}. To go ahead: /classes rm ${name} confirm`
        : errorMessage(res.error),
    );
    return;
  }
  await ctx.reply(`Class "${name}" removed.`);
}
