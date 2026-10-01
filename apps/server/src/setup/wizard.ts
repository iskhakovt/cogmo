/**
 * Interactive setup wizard — guides the user through configuring cogmo.
 *
 * Re-runnable, idempotent, validates credentials against live providers.
 * Writes to DB only — never mutates .env or any file. Each step lives in
 * `./wizard/`; this module runs them in order.
 *
 * See design/setup.md for the UX contract.
 */

import * as p from "@clack/prompts";
import { stepConfigureClaudeCodeAuth } from "./wizard/claude-code-auth.js";
import { stepConfigureDaytona } from "./wizard/daytona.js";
import { stepConfigureGitHubIdentity } from "./wizard/github-identity.js";
import { stepValidateHindsight } from "./wizard/hindsight.js";
import { stepConfigureImageProviders } from "./wizard/image-providers.js";
import { stepConfigureProvider } from "./wizard/llm-provider.js";
import { stepConfigureOptionalTools } from "./wizard/optional-tools.js";
import { stepConfigureSkillsRemote } from "./wizard/skills-remote.js";
import type { WizardDeps } from "./wizard/step.js";
import { stepSummary } from "./wizard/summary.js";
import { stepConfigureTelegram } from "./wizard/telegram.js";
import { stepConfigureVoice } from "./wizard/voice.js";

export { WizardCancelled } from "./wizard/step.js";

export async function runWizard(
  deps: WizardDeps & {
    /** The default user `migrateAndSeed` seeded ahead of the wizard. */
    userId: string;
  },
): Promise<void> {
  const { userId, ...wizardDeps } = deps;

  p.intro("Cogmo Setup");

  // Step 1: defaults, seeded by `migrateAndSeed` before the wizard starts.
  p.log.success("Default user and profile ready.");

  // Step 2: LLM provider (required — loop until configured)
  let hasProvider = false;
  while (!hasProvider) {
    await stepConfigureProvider(wizardDeps);
    const providers = await wizardDeps.runInTx((tx) => wizardDeps.agentStore.listProviders(tx));
    hasProvider = providers.length > 0;
    if (!hasProvider) {
      p.log.warn("At least one LLM provider is required. Let's try again.");
    }
  }

  // Step 3: Telegram (optional)
  const { botUsername } = await stepConfigureTelegram(wizardDeps, userId);

  // Step 4: Optional tools (Tavily, fal.ai)
  await stepConfigureOptionalTools(wizardDeps);

  // Step 5: OpenAI-compatible image providers (Venice, OpenAI gpt-image, custom)
  await stepConfigureImageProviders(wizardDeps);

  // Step 6: Voice (TTS + STT) — paired with image providers as optional output modality
  await stepConfigureVoice(wizardDeps);

  // Step 7: GitHub identity for the coding-delegation pipeline (optional)
  await stepConfigureGitHubIdentity(wizardDeps);

  // Step 8: Claude Code subscription auth for the coding-delegation pipeline (optional)
  await stepConfigureClaudeCodeAuth(wizardDeps);

  // Step 9: Daytona managed sandbox (optional — required when SANDBOX_BACKEND=daytona)
  await stepConfigureDaytona(wizardDeps);

  // Step 10: Skills repo remote (required for `delegate_coding({repo:"skills"})`;
  // skippable — operator can re-run `cogmo migrate-skills-remote` later)
  await stepConfigureSkillsRemote(wizardDeps);

  // Step 11: Hindsight check
  await stepValidateHindsight();

  // Step 12: Summary + next-steps
  await stepSummary(wizardDeps, botUsername);
}
