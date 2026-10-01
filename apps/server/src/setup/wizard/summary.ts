/**
 * Wizard step: what is configured, and how to check the deployment answers.
 */

import * as p from "@clack/prompts";
import type { WizardDeps } from "./step.js";

export async function stepSummary(deps: WizardDeps, botUsername?: string): Promise<void> {
  const providers = await deps.runInTx((tx) => deps.agentStore.listProviders(tx));
  const secrets = await deps.runInTx((tx) => deps.secretsStore.listSecrets(tx));
  const telegramChannel = await deps.runInTx((tx) =>
    deps.transportStore.getChannelByType(tx, "telegram"),
  );
  const voiceConfig = await deps.runInTx((tx) => deps.agentStore.getVoiceConfig(tx));

  const lines: string[] = [];
  lines.push(`Providers: ${providers.map((p) => p.name).join(", ") || "none"}`);
  lines.push(`Secrets: ${secrets.length} stored`);
  lines.push(`Telegram: ${telegramChannel ? "configured" : "not configured"}`);
  lines.push(
    `Voice: ${voiceConfig ? `configured (${voiceConfig.ttsModel}/${voiceConfig.ttsVoice})` : "not configured"}`,
  );

  p.note(lines.join("\n"), "Setup complete");

  // Concrete next-steps block — answers "how do I know it's working?".
  // Only shown in interactive mode where a human is watching.
  const nextSteps: string[] = [];
  nextSteps.push("1. Start the server: cogmo serve");
  if (botUsername) {
    nextSteps.push(`2. Open Telegram and message @${botUsername}`);
    nextSteps.push("3. You should get a reply within a few seconds.");
  } else if (telegramChannel) {
    // Telegram configured on a previous run — we don't have the username here.
    nextSteps.push("2. Open Telegram and message your configured bot.");
    nextSteps.push("3. You should get a reply within a few seconds.");
  } else {
    nextSteps.push("2. Use `pnpm console` to send a message to the direct channel.");
    nextSteps.push("3. You should get a reply within a few seconds.");
  }
  nextSteps.push("");
  nextSteps.push("If something doesn't work, see DEPLOYMENT.md.");

  p.note(nextSteps.join("\n"), "Verify it's running");
  p.outro("Cogmo is ready.");
}
