/** `/model`: show or set the current profile's model. */

import type { Transport } from "../../../transport.js";
import { renderModelList } from "../sessions-ux.js";
import { errorMessage, type TelegramCommandContext } from "./reply.js";

export async function handleModel(
  transport: Transport,
  ctx: TelegramCommandContext,
): Promise<void> {
  const handle = String(ctx.from.id);
  const addr = String(ctx.chat.id);
  const pick = ctx.match?.trim();

  const current = await transport.conversations.getCurrent(handle, addr);
  if (current.isErr()) {
    await ctx.reply(errorMessage(current.error));
    return;
  }
  if (!current.value) {
    await ctx.reply("No active conversation yet — send a message first.");
    return;
  }

  if (!pick) {
    const models = await transport.models.list();
    const body = renderModelList(models, { currentModel: current.value.model });
    await ctx.reply(body);
    return;
  }

  // Pass `clearCooldownForConversation` so the model update and the
  // cooldown clear land in the same transaction — model switches end
  // any active cooldown by design (see design/agent-resilience.md →
  // Clear triggers).
  const res = await transport.profiles.update(
    handle,
    current.value.profileId,
    { model: pick },
    { clearCooldownForConversation: current.value.conversationId },
  );
  if (res.isErr()) {
    await ctx.reply(errorMessage(res.error));
    return;
  }
  await ctx.reply(
    `Model for "${current.value.profileName}" set to ${pick}. Takes effect next turn.`,
  );
}
