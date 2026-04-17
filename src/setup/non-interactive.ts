/**
 * Non-interactive setup — reads `COGMO_*` env vars, validates credentials,
 * writes provider/channel/identity rows. Used by CI, IaC, and Docker
 * entrypoint scripts where no human is watching.
 *
 * All external I/O (validator HTTP calls) is injected so tests can stub
 * without mocking modules. The DB side uses the same stores as the
 * interactive wizard; writes happen only after every validation passes.
 */

import { err, ok, type Result } from "neverthrow";
import type { JsonValue } from "type-fest";
import type { AgentStore } from "../agent/store/index.js";
import { logger } from "../logger.js";
import type { SecretsStore } from "../secrets/store/index.js";
import type { TransportStore } from "../transport/store/index.js";
import type { NonInteractiveAnswers } from "./env.js";
import { parseNonInteractiveEnv, SetupEnvError } from "./env.js";
import { PROVIDER_BASE_URLS, type ProviderType } from "./providers.js";
import { seedChannelRules, seedDefaults } from "./seed.js";
import {
  type ValidationResult,
  validateAnthropicKey,
  validateOpenAICompatibleKey,
  validateTavilyKey,
  validateTelegramToken,
} from "./validate.js";

/** Injectable validator set. Real implementations live in validate.ts. */
export interface Validators {
  llmAnthropic: (apiKey: string, baseUrl?: string) => Promise<ValidationResult>;
  llmOpenAICompatible: (apiKey: string, baseUrl: string) => Promise<ValidationResult>;
  telegram: (token: string) => Promise<ValidationResult>;
  tavily: (apiKey: string) => Promise<ValidationResult>;
}

export const defaultValidators: Validators = {
  llmAnthropic: validateAnthropicKey,
  llmOpenAICompatible: validateOpenAICompatibleKey,
  telegram: validateTelegramToken,
  tavily: validateTavilyKey,
};

export interface PersistDeps {
  agentStore: AgentStore;
  transportStore: TransportStore;
  secretsStore: SecretsStore;
}

export interface NonInteractiveDeps extends PersistDeps {
  env: Record<string, string | undefined>;
  validators?: Validators;
}

/** Output of `validateNonInteractive` — the answers and any meta from validators. */
export interface ValidatedNonInteractive {
  answers: NonInteractiveAnswers;
  telegramBotUsername?: string;
}

/** Thrown when one or more provider/channel validations fail. */
export class NonInteractiveValidationError extends Error {
  readonly failures: ReadonlyArray<string>;
  constructor(failures: ReadonlyArray<string>) {
    super(`Non-interactive setup validation failed:\n  - ${failures.join("\n  - ")}`);
    this.name = "NonInteractiveValidationError";
    this.failures = failures;
  }
}

/**
 * Validate non-interactive setup input without touching the database.
 *
 * Used by `runSetup` to fail fast before destructive actions like
 * `applyReset`, and by `runNonInteractive` as the first phase of its
 * end-to-end flow. Composing this separately means we never mutate
 * persistent state on bad input.
 */
export async function validateNonInteractive(
  env: Record<string, string | undefined>,
  validators: Validators = defaultValidators,
): Promise<Result<ValidatedNonInteractive, SetupEnvError | NonInteractiveValidationError>> {
  const parsed = parseNonInteractiveEnv(env);
  if (parsed.isErr()) return err(parsed.error);

  const summary = await validateAll(parsed.value, validators);
  if (summary.failures.length > 0) {
    return err(new NonInteractiveValidationError(summary.failures));
  }

  return ok({
    answers: parsed.value,
    ...(summary.telegramBotUsername && { telegramBotUsername: summary.telegramBotUsername }),
  });
}

/**
 * Persist a pre-validated non-interactive setup to the database.
 *
 * Caller must have validated via `validateNonInteractive` first.
 */
export async function persistNonInteractive(
  deps: PersistDeps,
  validated: ValidatedNonInteractive,
): Promise<void> {
  const { answers, telegramBotUsername } = validated;

  const { userId } = await seedDefaults(deps.agentStore, deps.transportStore);

  await persistProvider(deps, answers);

  if (answers.telegramBotToken && answers.telegramAllowedUsers) {
    await persistTelegram(deps, userId, answers, telegramBotUsername);
  }

  if (answers.tavilyApiKey) {
    await deps.secretsStore.putSecret({
      name: "tavily_api_key",
      plaintext: answers.tavilyApiKey,
      description: "Tavily web search",
    });
    await deps.secretsStore.markValidated("tavily_api_key");
  }

  if (answers.falApiKey) {
    await deps.secretsStore.putSecret({
      name: "fal_api_key",
      plaintext: answers.falApiKey,
      description: "fal.ai image generation",
    });
  }

  logger.info(
    {
      provider: answers.llmProviderType,
      telegram: Boolean(answers.telegramBotToken),
      tavily: Boolean(answers.tavilyApiKey),
      fal: Boolean(answers.falApiKey),
    },
    "non-interactive setup complete",
  );
}

/**
 * Run non-interactive setup end-to-end.
 *
 * Flow:
 *  1. Parse env (fail fast on missing/malformed).
 *  2. Validate every credential against live APIs (fail fast on invalid).
 *  3. Seed defaults (user + profile + direct channel).
 *  4. Persist provider, model_providers, channel, identities, secrets.
 *
 * Any failure in steps 1-2 aborts before any writes happen.
 */
export async function runNonInteractive(deps: NonInteractiveDeps): Promise<void> {
  const validated = await validateNonInteractive(deps.env, deps.validators ?? defaultValidators);
  if (validated.isErr()) throw validated.error;
  await persistNonInteractive(deps, validated.value);
}

interface ValidationSummary {
  failures: string[];
  telegramBotUsername?: string;
}

async function validateAll(
  answers: NonInteractiveAnswers,
  validators: Validators,
): Promise<ValidationSummary> {
  const failures: string[] = [];
  let telegramBotUsername: string | undefined;

  // LLM provider
  const adapterType = adapterTypeFor(answers.llmProviderType);
  const baseUrl = answers.llmBaseUrl ?? PROVIDER_BASE_URLS[answers.llmProviderType];
  const llm =
    adapterType === "anthropic"
      ? await validators.llmAnthropic(answers.llmApiKey, baseUrl)
      : await validators.llmOpenAICompatible(
          answers.llmApiKey,
          baseUrl ?? "", // superRefine already guarantees baseUrl for custom
        );
  if (!llm.valid) {
    failures.push(`LLM provider (${answers.llmProviderType}): ${llm.error ?? "invalid"}`);
  }

  // Telegram (optional)
  if (answers.telegramBotToken) {
    const tg = await validators.telegram(answers.telegramBotToken);
    if (!tg.valid) {
      failures.push(`Telegram bot token: ${tg.error ?? "invalid"}`);
    } else {
      telegramBotUsername = tg.meta?.botUsername;
    }
  }

  // Tavily (optional)
  if (answers.tavilyApiKey) {
    const tv = await validators.tavily(answers.tavilyApiKey);
    if (!tv.valid) {
      failures.push(`Tavily API key: ${tv.error ?? "invalid"}`);
    }
  }

  // fal.ai has no cheap ping endpoint — errors surface on first use.

  return { failures, ...(telegramBotUsername && { telegramBotUsername }) };
}

/** Translate the wizard's provider label to the adapter type stored in `llm_providers.type`. */
function adapterTypeFor(providerType: ProviderType): "anthropic" | "openai_compatible" {
  return providerType === "anthropic" ? "anthropic" : "openai_compatible";
}

async function persistProvider(deps: PersistDeps, answers: NonInteractiveAnswers): Promise<void> {
  const adapterType = adapterTypeFor(answers.llmProviderType);
  const baseUrl = answers.llmBaseUrl ?? PROVIDER_BASE_URLS[answers.llmProviderType];
  const providerName = answers.llmProviderType;

  // Idempotent: re-running with the same provider name replaces the old row.
  // Model_providers cascade-deletes via the FK. The interactive wizard lets
  // the user choose Keep/Add/Replace; non-interactive converges by replacing.
  const existing = await deps.agentStore.listProviders();
  for (const prov of existing.filter((p) => p.name === providerName)) {
    await deps.agentStore.deleteProvider(prov.id);
  }

  const { id: secretId } = await deps.secretsStore.putSecret({
    name: `${providerName}_api_key`,
    plaintext: answers.llmApiKey,
    description: `API key for ${providerName}`,
  });
  await deps.secretsStore.markValidated(`${providerName}_api_key`);

  const attrs: Record<string, boolean> = {};
  if (answers.llmProviderType === "openrouter") {
    attrs.promptCaching = true;
  }

  const { id: providerId } = await deps.agentStore.createProvider({
    name: providerName,
    type: adapterType,
    ...(baseUrl && { baseUrl }),
    secretId,
    attrs: attrs as JsonValue,
  });

  const defaultProfile = await deps.agentStore.getDefaultProfile();
  if (!defaultProfile) return;
  const profile = await deps.agentStore.getProfile(defaultProfile.id);
  if (!profile) return;
  const nextPosition = await deps.agentStore.getNextModelProviderPosition(profile.model);
  await deps.agentStore.addModelProvider({
    model: profile.model,
    providerId,
    position: nextPosition,
    userSelectable: true,
  });
}

async function persistTelegram(
  deps: PersistDeps,
  userId: string,
  answers: NonInteractiveAnswers,
  botUsername: string | undefined,
): Promise<void> {
  // telegramBotToken + telegramAllowedUsers are guaranteed by the caller
  const token = answers.telegramBotToken;
  const allowed = answers.telegramAllowedUsers;
  if (!token || !allowed) {
    throw new Error("persistTelegram called without token + allowedUsers");
  }

  const existing = await deps.transportStore.getChannelByType("telegram");
  if (existing) {
    // Non-interactive replaces existing — the caller is expected to have
    // used --reset channels if they wanted a clean slate, but re-running
    // with the same config should still converge.
    await deps.transportStore.removeChannel(existing.id);
  }

  const tokenSecretName = "telegram_bot_token";
  await deps.secretsStore.putSecret({
    name: tokenSecretName,
    plaintext: token,
    description: botUsername ? `Telegram bot token (@${botUsername})` : "Telegram bot token",
  });
  await deps.secretsStore.markValidated(tokenSecretName);

  const { id: channelId } = await deps.transportStore.createChannel({
    type: "telegram",
    credentials: { tokenSecretName },
    identityMode: "mapped",
  });

  await seedChannelRules(deps.agentStore, "telegram");

  for (const telegramUserId of allowed) {
    await deps.transportStore.createIdentity({
      userId,
      channelId,
      platformHandle: telegramUserId,
    });
  }
}

/** Re-export for consumers that want to surface env-parse errors separately. */
export { SetupEnvError };
