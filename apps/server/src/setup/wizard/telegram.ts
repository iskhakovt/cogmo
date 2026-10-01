/**
 * Wizard step: the Telegram channel — bot token, the channel row, and the
 * allowlist of Telegram user ids mapped to the owner.
 */

import * as p from "@clack/prompts";
import { seedChannelRules } from "../seed.js";
import { validateTelegramToken } from "../validate.js";
import { cancelGuard, storeSecret, type WizardDeps } from "./step.js";

export async function stepConfigureTelegram(
  deps: WizardDeps,
  userId: string,
): Promise<{ botUsername?: string }> {
  const existing = await deps.runInTx((tx) => deps.transportStore.getChannelByType(tx, "telegram"));

  if (existing) {
    const action = await p.select({
      message: "Telegram channel is already configured. What would you like to do?",
      options: [
        { value: "keep", label: "Keep current configuration" },
        { value: "replace", label: "Reconfigure" },
      ],
    });
    cancelGuard(action);
    if (action === "keep") {
      await seedChannelRules(deps.runInTx, deps.agentStore, "telegram");
      return {};
    }
    await deps.runInTx((tx) => deps.transportStore.removeChannel(tx, existing.id));
  } else {
    const add = await p.confirm({ message: "Add a Telegram channel? (optional)" });
    if (!cancelGuard(add)) return {};
  }

  p.note(
    "Message @BotFather on Telegram → /newbot → follow prompts\nThe token looks like: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
    "How to get a Telegram bot token",
  );

  const token = cancelGuard(
    await p.password({
      message: "Paste your bot token:",
      validate: (v) => {
        if (!v?.includes(":")) return "Token should contain a colon (e.g., 123:ABC)";
        return undefined;
      },
    }),
  );

  const s = p.spinner();
  s.start("Validating bot token...");
  const result = await validateTelegramToken(token);

  if (!result.valid) {
    s.stop(`Validation failed: ${result.error}`);
    p.log.warn("Skipping Telegram channel. Re-run `cogmo setup` to try again.");
    return {};
  }
  s.stop(`Connected as @${result.meta?.botUsername}`);
  const botUsername = result.meta?.botUsername;

  // Store bot token as an encrypted secret, reference by name in channel credentials.
  // The adapter resolves the secret at startup via the secrets store.
  const tokenSecretName = "telegram_bot_token";
  await storeSecret(
    deps,
    {
      name: tokenSecretName,
      plaintext: token,
      description: `Telegram bot token (@${result.meta?.botUsername})`,
    },
    true,
  );

  const { id: channelId } = await deps.runInTx((tx) =>
    deps.transportStore.createChannel(tx, {
      type: "telegram",
      credentials: { tokenSecretName },
      identityMode: "mapped",
    }),
  );

  // Seed default channel-scoped steering rules (idempotent)
  await seedChannelRules(deps.runInTx, deps.agentStore, "telegram");

  // Allowlist
  p.note(
    "Message @userinfobot on Telegram — it replies with your numeric ID",
    "How to get your Telegram user ID",
  );

  const allowlist = cancelGuard(
    await p.text({
      message: "Telegram user IDs to allow (comma-separated):",
      validate: (v) => {
        if (!v) return "At least one user ID is required";
        const ids = v.split(",").map((s: string) => s.trim());
        for (const id of ids) {
          if (!/^\d+$/.test(id)) return `"${id}" is not a valid numeric user ID`;
        }
        return undefined;
      },
    }),
  );

  const userIds = allowlist
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const telegramUserId of userIds) {
    await deps.runInTx((tx) =>
      deps.transportStore.createIdentity(tx, {
        userId,
        channelId,
        platformHandle: telegramUserId,
      }),
    );
  }

  p.log.success(
    `Telegram channel created with ${userIds.length} allowed user${userIds.length === 1 ? "" : "s"}.`,
  );
  return botUsername ? { botUsername } : {};
}
