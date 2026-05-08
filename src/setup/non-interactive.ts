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
import {
  CLAUDE_CODE_OAUTH_TOKEN_SECRET,
  CLAUDE_CODE_OAUTH_TOKEN_SECRET_DESCRIPTION,
} from "../agent/coding/auth.js";
import type { AgentStore } from "../agent/store/index.js";
import type { ProviderAttrs } from "../agent/store/schema.js";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import {
  DEFAULT_GITHUB_IDENTITY_NAME,
  type GitHubIdentity,
  gitHubIdentitySecretName,
  serializeGitHubIdentity,
} from "../secrets/github.js";
import { generateSshKeyPair } from "../secrets/ssh-keygen.js";
import type { SecretsStore } from "../secrets/store/index.js";
import type { TransportStore } from "../transport/store/index.js";
import type { NonInteractiveAnswers } from "./env.js";
import { parseNonInteractiveEnv, SetupEnvError } from "./env.js";
import { PROVIDER_BASE_URLS, type ProviderType } from "./providers.js";
import { seedChannelRules, seedDefaults } from "./seed.js";
import {
  type ValidationResult,
  validateAnthropicKey,
  validateGitHubPat,
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
  githubPat: (pat: string) => Promise<ValidationResult>;
}

export const defaultValidators: Validators = {
  llmAnthropic: validateAnthropicKey,
  llmOpenAICompatible: validateOpenAICompatibleKey,
  telegram: validateTelegramToken,
  tavily: validateTavilyKey,
  githubPat: validateGitHubPat,
};

export interface PersistDeps {
  runInTx: Transactor;
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
  /** GitHub bot account login (from `GET /user`); `undefined` when no PAT was supplied. */
  githubLogin?: string;
  /** GitHub bot account numeric id, as a string. Pairs with `githubLogin`. */
  githubUserId?: string;
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
    ...(summary.githubLogin && { githubLogin: summary.githubLogin }),
    ...(summary.githubUserId && { githubUserId: summary.githubUserId }),
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
  const { answers, telegramBotUsername, githubLogin, githubUserId } = validated;

  const { userId } = await seedDefaults(deps.runInTx, deps.agentStore, deps.transportStore);

  await persistProvider(deps, answers);

  if (answers.telegramBotToken && answers.telegramAllowedUsers) {
    await persistTelegram(deps, userId, answers, telegramBotUsername);
  }

  if (answers.tavilyApiKey) {
    const tavilyApiKey = answers.tavilyApiKey;
    await deps.runInTx((tx) =>
      deps.secretsStore.putSecret(tx, {
        name: "tavily_api_key",
        plaintext: tavilyApiKey,
        description: "Tavily web search",
      }),
    );
    await deps.runInTx((tx) => deps.secretsStore.markValidated(tx, "tavily_api_key"));
  }

  if (answers.falApiKey) {
    const falApiKey = answers.falApiKey;
    await deps.runInTx((tx) =>
      deps.secretsStore.putSecret(tx, {
        name: "fal_api_key",
        plaintext: falApiKey,
        description: "fal.ai image generation",
      }),
    );
  }

  let generatedSshPublicKey: string | undefined;
  if (answers.githubPat) {
    generatedSshPublicKey = await persistGitHubIdentity(deps, answers, githubLogin, githubUserId);
  }

  if (answers.claudeCodeOauthToken) {
    const token = answers.claudeCodeOauthToken;
    await deps.runInTx((tx) =>
      deps.secretsStore.putSecret(tx, {
        name: CLAUDE_CODE_OAUTH_TOKEN_SECRET,
        plaintext: token,
        description: CLAUDE_CODE_OAUTH_TOKEN_SECRET_DESCRIPTION,
      }),
    );
  }

  logger.info(
    {
      provider: answers.llmProviderType,
      telegram: Boolean(answers.telegramBotToken),
      tavily: Boolean(answers.tavilyApiKey),
      fal: Boolean(answers.falApiKey),
      github: Boolean(answers.githubPat),
      githubGeneratedSshKey: Boolean(generatedSshPublicKey),
      claudeCodeOauth: Boolean(answers.claudeCodeOauthToken),
    },
    "non-interactive setup complete",
  );

  if (generatedSshPublicKey) {
    // Stdout (not the logger) so the operator's wrapper script can capture it.
    // Non-interactive runs typically log JSON; a clear delimiter makes parsing
    // unambiguous without forcing the operator to filter logger output.
    process.stdout.write(
      [
        "",
        "=== Cogmo: install the generated SSH signing key on github.com ===",
        "Add the following public key as a *signing key* (not authentication):",
        "  https://github.com/settings/ssh/new",
        "",
        generatedSshPublicKey,
        "===",
        "",
      ].join("\n"),
    );
  }
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
  githubLogin?: string;
  githubUserId?: string;
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

  // GitHub PAT (optional — required only when the operator is wiring up the
  // coding-delegation pipeline).
  let githubLogin: string | undefined;
  let githubUserId: string | undefined;
  if (answers.githubPat) {
    const gh = await validators.githubPat(answers.githubPat);
    if (!gh.valid) {
      failures.push(`GitHub PAT: ${gh.error ?? "invalid"}`);
    } else {
      githubLogin = gh.meta?.login;
      githubUserId = gh.meta?.id;
    }
  }
  // Reject `COGMO_GITHUB_SSH_PRIVATE_KEY` loudly — but only when GitHub
  // setup is actually enabled (PAT supplied). Silently substituting a
  // freshly-generated key for an operator-provided one would mean their
  // CI script believes its bundle is the persisted bundle when in fact
  // ours is, so when GitHub setup is on we want a hard validation error.
  // When GitHub setup is off (no PAT), the SSH-key var has no effect
  // anyway — ignore it so a stale leftover env var on a wrapper script
  // doesn't fail an otherwise valid non-GitHub setup.
  if (answers.githubSshPrivateKey && answers.githubPat) {
    failures.push(
      "COGMO_GITHUB_SSH_PRIVATE_KEY: importing pre-generated OpenSSH keys isn't supported yet. " +
        "Remove the variable and rerun setup; Cogmo will generate a fresh keypair and print the public key for you to install on github.com.",
    );
  }

  // fal.ai has no cheap ping endpoint — errors surface on first use.

  return {
    failures,
    ...(telegramBotUsername && { telegramBotUsername }),
    ...(githubLogin && { githubLogin }),
    ...(githubUserId && { githubUserId }),
  };
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
  const existing = await deps.runInTx((tx) => deps.agentStore.listProviders(tx));
  for (const prov of existing.filter((p) => p.name === providerName)) {
    await deps.runInTx((tx) => deps.agentStore.deleteProvider(tx, prov.id));
  }

  const { id: secretId } = await deps.runInTx((tx) =>
    deps.secretsStore.putSecret(tx, {
      name: `${providerName}_api_key`,
      plaintext: answers.llmApiKey,
      description: `API key for ${providerName}`,
    }),
  );
  await deps.runInTx((tx) => deps.secretsStore.markValidated(tx, `${providerName}_api_key`));

  const attrs: ProviderAttrs = {};
  if (answers.llmProviderType === "openrouter") {
    attrs.promptCaching = true;
  }

  const { id: providerId } = await deps.runInTx((tx) =>
    deps.agentStore.createProvider(tx, {
      name: providerName,
      type: adapterType,
      ...(baseUrl && { baseUrl }),
      secretId,
      attrs,
    }),
  );

  await deps.runInTx(async (tx) => {
    const defaultProfile = await deps.agentStore.getDefaultProfile(tx);
    if (!defaultProfile) return;
    const profile = await deps.agentStore.getProfile(tx, defaultProfile.id);
    if (!profile) return;
    const nextPosition = await deps.agentStore.getNextModelProviderPosition(tx, profile.model);
    await deps.agentStore.addModelProvider(tx, {
      model: profile.model,
      providerId,
      position: nextPosition,
      userSelectable: true,
    });
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

  const existing = await deps.runInTx((tx) => deps.transportStore.getChannelByType(tx, "telegram"));
  if (existing) {
    // Non-interactive replaces existing — the caller is expected to have
    // used --reset channels if they wanted a clean slate, but re-running
    // with the same config should still converge.
    await deps.runInTx((tx) => deps.transportStore.removeChannel(tx, existing.id));
  }

  const tokenSecretName = "telegram_bot_token";
  await deps.runInTx((tx) =>
    deps.secretsStore.putSecret(tx, {
      name: tokenSecretName,
      plaintext: token,
      description: botUsername ? `Telegram bot token (@${botUsername})` : "Telegram bot token",
    }),
  );
  await deps.runInTx((tx) => deps.secretsStore.markValidated(tx, tokenSecretName));

  const { id: channelId } = await deps.runInTx((tx) =>
    deps.transportStore.createChannel(tx, {
      type: "telegram",
      credentials: { tokenSecretName },
      identityMode: "mapped",
    }),
  );

  await seedChannelRules(deps.runInTx, deps.agentStore, "telegram");

  for (const telegramUserId of allowed) {
    await deps.runInTx((tx) =>
      deps.transportStore.createIdentity(tx, {
        userId,
        channelId,
        platformHandle: telegramUserId,
      }),
    );
  }
}

/**
 * Persist a GitHub identity bundle: the validated PAT plus a freshly
 * generated Ed25519 signing keypair. Returns the public key so the caller
 * can print it for the operator to install on github.com.
 *
 * Operator-supplied keys (`COGMO_GITHUB_SSH_PRIVATE_KEY`) are accepted but
 * trigger a warning and full regeneration — extracting the public key from
 * an arbitrary OpenSSH private blob without `ssh-keygen` on the host needs
 * a parser that isn't worth shipping in slice 4. Generation is reproducible
 * (the operator can re-run setup to get a different key) and the public key
 * has to be hand-installed on github.com either way.
 */
async function persistGitHubIdentity(
  deps: PersistDeps,
  answers: NonInteractiveAnswers,
  githubLogin: string | undefined,
  githubUserId: string | undefined,
): Promise<string> {
  if (!answers.githubPat) {
    throw new Error("persistGitHubIdentity called without a PAT");
  }
  if (!githubLogin || !githubUserId) {
    // `validateGitHubPat` returns valid:false when either field is missing,
    // so by here the validation gate guarantees both are set. Defensive
    // throw for the type-narrow.
    throw new Error("persistGitHubIdentity called without a validated login + id");
  }

  // `githubSshPrivateKey` is rejected at the validation phase — by the time
  // we get here, the field is guaranteed to be undefined (or the run already
  // aborted). Always generate.
  const keys = generateSshKeyPair(`cogmo-bot@${githubLogin}`);

  const identity: GitHubIdentity = {
    pat: answers.githubPat,
    sshPrivateKey: keys.privateKey,
    sshPublicKey: keys.publicKey,
    login: githubLogin,
    id: githubUserId,
  };

  const secretName = gitHubIdentitySecretName(DEFAULT_GITHUB_IDENTITY_NAME);
  await deps.runInTx((tx) =>
    deps.secretsStore.putSecret(tx, {
      name: secretName,
      plaintext: serializeGitHubIdentity(identity),
      description: `GitHub identity (@${githubLogin ?? "unknown"})`,
    }),
  );
  await deps.runInTx((tx) => deps.secretsStore.markValidated(tx, secretName));

  return keys.publicKey;
}

/** Re-export for consumers that want to surface env-parse errors separately. */
export { SetupEnvError };
