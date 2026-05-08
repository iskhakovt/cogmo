/**
 * Interactive setup wizard — guides the user through configuring cogmo.
 *
 * Re-runnable, idempotent, validates credentials against live providers.
 * Writes to DB only — never mutates .env or any file.
 *
 * See design/setup.md for the UX contract.
 */

import * as p from "@clack/prompts";
import type { AgentStore } from "../agent/store/index.js";
import type { ProviderAttrs } from "../agent/store/schema.js";
import { type Transactor, transactor } from "../db/transactor.js";
import { deriveMasterKey, parseMasterKey } from "../secrets/encryption.js";
import {
  DEFAULT_GITHUB_IDENTITY_NAME,
  type GitHubIdentity,
  gitHubIdentitySecretName,
  resolveGitHubIdentity,
  serializeGitHubIdentity,
} from "../secrets/github.js";
import { generateSshKeyPair } from "../secrets/ssh-keygen.js";
import { DrizzleSecretsStore, type SecretsStore } from "../secrets/store/index.js";
import type { TransportStore } from "../transport/store/index.js";
import { seedChannelRules, seedDefaults } from "./seed.js";
import {
  validateAnthropicKey,
  validateGitHubPat,
  validateHindsight,
  validateOpenAICompatibleKey,
  validateTavilyKey,
  validateTelegramToken,
} from "./validate.js";

/** Thrown when the user cancels a prompt. Caught by runSetup to exit cleanly. */
export class WizardCancelled extends Error {
  constructor() {
    super("Setup cancelled by user");
    this.name = "WizardCancelled";
  }
}

function cancelGuard<T>(value: T | symbol): T {
  if (p.isCancel(value)) throw new WizardCancelled();
  return value;
}

// --- Types ---

interface WizardDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  transportStore: TransportStore;
  secretsStore: SecretsStore;
}

// --- Provider UI metadata (canonical types/URLs come from providers.ts) ---

import { PROVIDER_BASE_URLS, type ProviderType } from "./providers.js";

const PROVIDER_OPTIONS: ReadonlyArray<{
  value: ProviderType;
  label: string;
  hint: string;
}> = [
  { value: "anthropic", label: "Anthropic (Claude)", hint: "direct API access" },
  {
    value: "openrouter",
    label: "OpenRouter",
    hint: "access Claude, GPT, and others via one key",
  },
  { value: "openai", label: "OpenAI (GPT)", hint: "direct API access" },
  {
    value: "custom",
    label: "Custom (OpenAI-compatible)",
    hint: "any endpoint with /v1/chat/completions",
  },
];

const PROVIDER_HELP: Partial<Record<ProviderType, { url: string; path: string; keyName: string }>> =
  {
    anthropic: {
      url: "https://console.anthropic.com/",
      path: "Settings → API Keys → Create Key",
      keyName: "cogmo",
    },
    openrouter: {
      url: "https://openrouter.ai/settings/keys",
      path: "Create Key",
      keyName: "cogmo",
    },
    openai: {
      url: "https://platform.openai.com/api-keys",
      path: "Create new secret key",
      keyName: "cogmo",
    },
  };

// --- Wizard steps ---

async function stepSeedDefaults(deps: WizardDeps): Promise<{ userId: string; profileId: string }> {
  const s = p.spinner();
  s.start("Checking default user and profile...");
  const result = await seedDefaults(deps.runInTx, deps.agentStore, deps.transportStore);
  s.stop("Default user and profile ready.");
  return result;
}

async function stepConfigureProvider(deps: WizardDeps): Promise<void> {
  const existing = await deps.runInTx((tx) => deps.agentStore.listProviders(tx));

  if (existing.length > 0) {
    const names = existing.map((p) => p.name).join(", ");
    const action = await p.select({
      message: `LLM provider configured: ${names}. What would you like to do?`,
      options: [
        { value: "keep", label: "Keep current configuration" },
        { value: "add", label: "Add another provider" },
        { value: "replace", label: "Replace existing provider" },
      ],
    });
    cancelGuard(action);
    if (action === "keep") return;
    if (action === "replace") {
      for (const prov of existing) {
        await deps.runInTx((tx) => deps.agentStore.deleteProvider(tx, prov.id));
      }
    }
  }

  const providerType = cancelGuard(
    await p.select({
      message: "Choose your LLM provider:",
      options: [...PROVIDER_OPTIONS],
    }),
  );

  const help = PROVIDER_HELP[providerType];
  if (help) {
    p.note(
      `Visit ${help.url}\n→ ${help.path}\nWe recommend naming it "${help.keyName}"`,
      "Where to get your API key",
    );
  }

  let baseUrl = PROVIDER_BASE_URLS[providerType];

  if (providerType === "custom") {
    baseUrl = cancelGuard(
      await p.text({
        message: "Base URL (e.g., https://api.example.com/v1):",
        validate: (v = "") => {
          if (!v.startsWith("http")) return "Must start with http:// or https://";
          return undefined;
        },
      }),
    );
  }

  const apiKey = cancelGuard(
    await p.password({
      message: "Paste your API key:",
      validate: (v) => {
        if (!v || v.length < 10) return "API key seems too short";
        return undefined;
      },
    }),
  );

  // Validate
  const s = p.spinner();
  s.start("Validating API key...");

  const adapterType = providerType === "anthropic" ? "anthropic" : "openai_compatible";

  let result: import("./validate.js").ValidationResult;
  if (adapterType === "anthropic") {
    result = await validateAnthropicKey(apiKey, baseUrl);
  } else {
    if (!baseUrl) throw new Error(`Base URL required for ${String(providerType)} but not set`);
    result = await validateOpenAICompatibleKey(apiKey, baseUrl);
  }

  if (!result.valid) {
    s.stop(`Validation failed: ${result.error}`);
    const retry = await p.confirm({ message: "Save anyway?" });
    if (!cancelGuard(retry)) return;
  } else {
    s.stop("API key validated.");
  }

  // Store
  const providerName = providerType as string;
  const { id: secretId } = await deps.secretsStore.putSecret({
    name: `${providerName}_api_key`,
    plaintext: apiKey,
    description: `API key for ${providerName}`,
  });
  if (result.valid) {
    await deps.secretsStore.markValidated(`${providerName}_api_key`);
  }

  const attrs: ProviderAttrs = {};
  if (providerType === "openrouter") {
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

  // Register this provider for the default profile's model.
  // Use next available position to avoid UNIQUE(model, position) collision.
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

  p.log.success(`Provider "${providerName}" configured for model routing.`);
}

async function stepConfigureTelegram(
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
  await deps.secretsStore.putSecret({
    name: tokenSecretName,
    plaintext: token,
    description: `Telegram bot token (@${result.meta?.botUsername})`,
  });
  await deps.secretsStore.markValidated(tokenSecretName);

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

async function stepConfigureOptionalTools(deps: WizardDeps): Promise<void> {
  const addTools = await p.confirm({
    message: "Configure optional tools? (Tavily search, fal.ai image generation, etc.)",
    initialValue: false,
  });
  if (!cancelGuard(addTools)) return;

  // Tavily
  const tavilyKey = cancelGuard(await p.password({ message: "Tavily API key (Enter to skip):" }));
  if (tavilyKey) {
    const s = p.spinner();
    s.start("Validating Tavily key...");
    const result = await validateTavilyKey(tavilyKey);
    if (result.valid) {
      await deps.secretsStore.putSecret({
        name: "tavily_api_key",
        plaintext: tavilyKey,
        description: "Tavily web search",
      });
      await deps.secretsStore.markValidated("tavily_api_key");
      s.stop("Tavily key validated and saved.");
    } else {
      s.stop(`Tavily validation failed: ${result.error}`);
    }
  }

  // fal.ai — image generation. No live validation in v0 (no cheap ping endpoint);
  // errors surface on first use.
  p.note("Get a key at https://fal.ai/dashboard/keys", "fal.ai image generation");
  const falKey = cancelGuard(await p.password({ message: "fal.ai API key (Enter to skip):" }));
  if (falKey) {
    await deps.secretsStore.putSecret({
      name: "fal_api_key",
      plaintext: falKey,
      description: "fal.ai image generation",
    });
    p.log.success("fal.ai key saved.");
  }
}

async function stepConfigureGitHubIdentity(deps: WizardDeps): Promise<void> {
  const existing = await resolveGitHubIdentity(deps.secretsStore, DEFAULT_GITHUB_IDENTITY_NAME);

  if (existing.isOk()) {
    const ident = existing.value;
    const action = await p.select({
      message: `GitHub identity '${DEFAULT_GITHUB_IDENTITY_NAME}' is already configured. What would you like to do?`,
      options: [
        { value: "keep", label: "Keep current configuration" },
        { value: "replace", label: "Replace PAT (re-uses existing signing key)" },
        { value: "regenerate", label: "Replace PAT and generate a new signing key" },
      ],
    });
    cancelGuard(action);
    if (action === "keep") return;
    if (action === "replace") {
      await collectAndStorePat(deps, ident);
      return;
    }
    // fall-through to full re-provision
  } else if (existing.error.code !== "missing") {
    // Stored identity exists but doesn't parse — most likely a hand-edited
    // secrets row. Confirm before overwriting; the operator may want to
    // bail out and inspect the row first rather than letting the wizard
    // silently replace it with a fresh PAT + keypair.
    p.log.warn(`Existing GitHub identity could not be parsed (${existing.error.code}).`);
    const proceed = await p.confirm({
      message: "Replace it with a fresh PAT + signing keypair?",
      initialValue: false,
    });
    if (!cancelGuard(proceed)) return;
  } else {
    const proceed = await p.confirm({
      message: "Configure a GitHub identity for the coding-delegation pipeline? (optional)",
      initialValue: false,
    });
    if (!cancelGuard(proceed)) return;
  }

  p.note(
    [
      "1. Create a fine-grained PAT at https://github.com/settings/personal-access-tokens/new",
      "2. Resource owner: pick the bot account or org that should author PRs.",
      "3. Repository access: select the repos you'll register with `/repo add`.",
      "4. Permissions: Contents (Read & write), Pull requests (Read & write), Metadata (Read).",
    ].join("\n"),
    "Where to get a GitHub PAT",
  );

  const pat = cancelGuard(
    await p.password({
      message: "Paste your GitHub PAT:",
      validate: (v) => {
        if (!v || v.length < 20) return "PAT looks too short";
        return undefined;
      },
    }),
  );

  const s = p.spinner();
  s.start("Validating GitHub PAT...");
  const result = await validateGitHubPat(pat);
  if (!result.valid) {
    s.stop(`Validation failed: ${result.error ?? "unknown error"}`);
    p.log.warn("Skipping GitHub identity. Re-run `cogmo setup` to try again.");
    return;
  }
  // login + id come from `GET /user`; both are required by the schema.
  // `validateGitHubPat` already short-circuits with `valid:false` when
  // either is absent, so by here we trust them.
  const login = result.meta?.login ?? "";
  const userId = result.meta?.id ?? "";
  if (!login || !userId) {
    s.stop("Validation succeeded but `login`/`id` were missing — aborting.");
    return;
  }
  s.stop(`PAT validated as @${login} (id ${userId}).`);

  const keys = generateSshKeyPair(`cogmo-bot@${login}`);

  const identity: GitHubIdentity = {
    pat,
    sshPrivateKey: keys.privateKey,
    sshPublicKey: keys.publicKey,
    login,
    id: userId,
  };

  await deps.secretsStore.putSecret({
    name: gitHubIdentitySecretName(DEFAULT_GITHUB_IDENTITY_NAME),
    plaintext: serializeGitHubIdentity(identity),
    description: `GitHub identity (@${login})`,
  });
  await deps.secretsStore.markValidated(gitHubIdentitySecretName(DEFAULT_GITHUB_IDENTITY_NAME));

  p.note(
    [
      "Add this as a *signing key* (not authentication) on the bot account:",
      "  https://github.com/settings/ssh/new",
      "",
      `Public key (${keys.fingerprint}):`,
      keys.publicKey,
    ].join("\n"),
    "Install the SSH signing key",
  );

  cancelGuard(
    await p.confirm({
      message: "Press Enter once you've installed the signing key on github.com.",
      initialValue: true,
    }),
  );

  p.log.success(`GitHub identity '${DEFAULT_GITHUB_IDENTITY_NAME}' stored.`);
}

async function collectAndStorePat(deps: WizardDeps, existing: GitHubIdentity): Promise<void> {
  const pat = cancelGuard(
    await p.password({
      message: "Paste the new GitHub PAT:",
      validate: (v) => {
        if (!v || v.length < 20) return "PAT looks too short";
        return undefined;
      },
    }),
  );

  const s = p.spinner();
  s.start("Validating GitHub PAT...");
  const result = await validateGitHubPat(pat);
  if (!result.valid) {
    s.stop(`Validation failed: ${result.error ?? "unknown error"}`);
    p.log.warn("Keeping the previous PAT.");
    return;
  }
  const login = result.meta?.login ?? "";
  const userId = result.meta?.id ?? "";
  if (!login || !userId) {
    s.stop("Validation succeeded but `login`/`id` were missing — keeping the previous PAT.");
    return;
  }
  // Reject a PAT that authenticates as a different account — the existing
  // signing key wouldn't match, so commit signatures would show "Unverified"
  // on github.com. The operator should pick "Regenerate" instead.
  if (existing.login !== login) {
    s.stop(
      `New PAT authenticates as @${login}, but the stored signing key is for @${existing.login}. Run "Regenerate" to rotate both together.`,
    );
    return;
  }
  s.stop(`PAT validated as @${login}.`);

  const identity: GitHubIdentity = {
    pat,
    sshPrivateKey: existing.sshPrivateKey,
    sshPublicKey: existing.sshPublicKey,
    login,
    id: userId,
  };

  await deps.secretsStore.putSecret({
    name: gitHubIdentitySecretName(DEFAULT_GITHUB_IDENTITY_NAME),
    plaintext: serializeGitHubIdentity(identity),
    description: `GitHub identity (@${login})`,
  });
  await deps.secretsStore.markValidated(gitHubIdentitySecretName(DEFAULT_GITHUB_IDENTITY_NAME));
  p.log.success("GitHub PAT rotated.");
}

async function stepValidateHindsight(): Promise<void> {
  const s = p.spinner();
  s.start("Checking Hindsight memory server...");
  // Use the env value or default
  const url = process.env.HINDSIGHT_URL ?? "http://localhost:8888";
  const result = await validateHindsight(url);
  if (result.valid) {
    s.stop(`Hindsight reachable at ${url}`);
  } else {
    s.stop(`Hindsight not reachable at ${url}: ${result.error}`);
    p.log.warn("Memory features will not work until Hindsight is available.");
  }
}

async function stepSummary(deps: WizardDeps, botUsername?: string): Promise<void> {
  const providers = await deps.runInTx((tx) => deps.agentStore.listProviders(tx));
  const secrets = await deps.secretsStore.listSecrets();
  const telegramChannel = await deps.runInTx((tx) =>
    deps.transportStore.getChannelByType(tx, "telegram"),
  );

  const lines: string[] = [];
  lines.push(`Providers: ${providers.map((p) => p.name).join(", ") || "none"}`);
  lines.push(`Secrets: ${secrets.length} stored`);
  lines.push(`Telegram: ${telegramChannel ? "configured" : "not configured"}`);

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

// --- Main wizard ---

export async function runWizard(deps: {
  db: import("../db/index.js").Database;
  agentStore: AgentStore;
  transportStore: TransportStore;
  masterKey: string;
}): Promise<void> {
  const encryptionKey = deriveMasterKey(parseMasterKey(deps.masterKey), "cogmo/secrets-at-rest/v1");
  const tx = transactor(deps.db);
  const secretsStore = new DrizzleSecretsStore(tx, encryptionKey);

  const wizardDeps: WizardDeps = {
    runInTx: tx,
    agentStore: deps.agentStore,
    transportStore: deps.transportStore,
    secretsStore,
  };

  p.intro("Cogmo Setup");

  // Step 1: Seed defaults
  const { userId } = await stepSeedDefaults(wizardDeps);

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

  // Step 4: Optional tools
  await stepConfigureOptionalTools(wizardDeps);

  // Step 5: GitHub identity for the coding-delegation pipeline (optional)
  await stepConfigureGitHubIdentity(wizardDeps);

  // Step 6: Hindsight check
  await stepValidateHindsight();

  // Step 7: Summary + next-steps
  await stepSummary(wizardDeps, botUsername);
}
