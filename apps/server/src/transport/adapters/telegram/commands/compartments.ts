/** `/compartments`: the custom memory-compartment registry. */

import type { Transport } from "../../../transport.js";
import { CORE_LIST, errorMessage, type TelegramCommandContext } from "./reply.js";

const USAGE =
  "Usage: /compartments [list|add <name> <description>|rm <name>]\n" +
  "  /compartments                     → list registered custom compartments\n" +
  "  /compartments add dnd <desc>      → register a new compartment (description is read by the classifier LLM)\n" +
  "  /compartments rm dnd              → remove (forward-only: existing memory tags are kept)\n" +
  `  Core values (always available, not editable): ${CORE_LIST}`;

export async function handleCompartments(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const handle = String(ctx.from.id);
  const trimmed = (ctx.match ?? "").trim();
  if (!trimmed) {
    return replyCompartmentsList(transport, ctx, handle);
  }
  const [sub, ...rest] = trimmed.split(/\s+/).filter(Boolean);
  switch (sub) {
    case "list":
      return replyCompartmentsList(transport, ctx, handle);
    case "add": {
      const name = rest[0]?.trim();
      const description = rest.slice(1).join(" ").trim();
      if (!name || !description) {
        await ctx.reply(USAGE);
        return;
      }
      return replyCompartmentsAdd(transport, ctx, handle, name, description);
    }
    case "rm":
    case "remove":
    case "delete": {
      const name = rest.join(" ").trim();
      if (!name) {
        await ctx.reply(USAGE);
        return;
      }
      return replyCompartmentsDelete(transport, ctx, handle, name);
    }
    default:
      await ctx.reply(USAGE);
  }
}

async function replyCompartmentsList(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
): Promise<void> {
  const res = await transport.compartments.list(handle);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  if (res.value.length === 0) {
    await ctx.reply(
      `No custom compartments registered. Use /compartments add <name> <description> to create one.\n\nCore (always available): ${CORE_LIST}`,
    );
    return;
  }
  const lines = res.value.map((c) => `• ${c.name} — ${c.description}`);
  await ctx.reply(
    `Custom compartments:\n${lines.join("\n")}\n\nCore (always available): ${CORE_LIST}`,
  );
}

async function replyCompartmentsAdd(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string,
  description: string,
): Promise<void> {
  const res = await transport.compartments.create(handle, { name, description });
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  await ctx.reply(
    `Registered compartment "${res.value.name}". The description you wrote is the classifier's instruction sheet — the LLM reads it on every Observer fire to decide when to use this bucket. Takes effect on the next fire; facts picked for it will be tagged compartment:${res.value.name}.`,
  );
}

async function replyCompartmentsDelete(
  transport: Transport,
  ctx: TelegramCommandContext,
  handle: string,
  name: string,
): Promise<void> {
  const res = await transport.compartments.delete(handle, name);
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  await ctx.reply(
    `Compartment "${name}" removed. Forward-only — existing memories tagged compartment:${name} are kept; the classifier will stop picking this bucket for new facts.`,
  );
}
