/**
 * Interactive setup wizard — guides the user through configuring cogmo.
 *
 * Re-runnable, idempotent, validates credentials against live providers.
 * Writes to DB only — never mutates .env or any file.
 *
 * See design/setup.md for the UX contract.
 */

import * as p from "@clack/prompts";
import type { JsonValue } from "type-fest";
import type { AgentStore } from "../agent/store/index.js";
import { deriveMasterKey, parseMasterKey } from "../secrets/encryption.js";
import { DrizzleSecretsStore, type SecretsStore } from "../secrets/store/index.js";
import type { TransportStore } from "../transport/store/index.js";
import { seedDefaults } from "./seed.js";
import {
  validateAnthropicKey,
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
  agentStore: AgentStore;
  transportStore: TransportStore;
  secretsStore: SecretsStore;
}

// --- Provider types for the wizard ---

const PROVIDER_TYPES = [
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
] as const;

const PROVIDER_HELP: Record<string, { url: string; path: string; keyName: string }> = {
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

const PROVIDER_BASE_URLS: Record<string, string | undefined> = {
  anthropic: undefined, // SDK default
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
};

// --- Wizard steps ---

async function stepSeedDefaults(deps: WizardDeps): Promise<{ userId: string; profileId: string }> {
  const s = p.spinner();
  s.start("Checking default user and profile...");
  const result = await seedDefaults(deps.agentStore, deps.transportStore);
  s.stop("Default user and profile ready.");
  return result;
}

async function stepConfigureProvider(deps: WizardDeps): Promise<void> {
  const existing = await deps.agentStore.listProviders();

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
        await deps.agentStore.deleteProvider(prov.id);
      }
    }
  }

  const providerType = await p.select({
    message: "Choose your LLM provider:",
    options: [...PROVIDER_TYPES],
  });
  cancelGuard(providerType);

  const help = PROVIDER_HELP[providerType as string];
  if (help) {
    p.note(
      `Visit ${help.url}\n→ ${help.path}\nWe recommend naming it "${help.keyName}"`,
      "Where to get your API key",
    );
  }

  let baseUrl = PROVIDER_BASE_URLS[providerType as string];

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

  const attrs: Record<string, boolean> = {};
  if (providerType === "openrouter") {
    attrs.promptCaching = true;
  }

  const { id: providerId } = await deps.agentStore.createProvider({
    name: providerName,
    type: adapterType,
    ...(baseUrl && { baseUrl }),
    secretId,
    attrs: attrs as JsonValue,
  });

  // Register this provider for the default profile's model.
  // Use next available position to avoid UNIQUE(model, position) collision.
  const defaultProfile = await deps.agentStore.getDefaultProfile();
  if (defaultProfile) {
    const profile = await deps.agentStore.getProfile(defaultProfile.id);
    if (profile) {
      const nextPosition = await deps.agentStore.getNextModelProviderPosition(profile.model);
      await deps.agentStore.addModelProvider({
        model: profile.model,
        providerId,
        position: nextPosition,
      });
    }
  }

  p.log.success(`Provider "${providerName}" configured for model routing.`);
}

async function stepConfigureTelegram(deps: WizardDeps, userId: string): Promise<void> {
  const existing = await deps.transportStore.getChannelByType("telegram");

  if (existing) {
    const action = await p.select({
      message: "Telegram channel is already configured. What would you like to do?",
      options: [
        { value: "keep", label: "Keep current configuration" },
        { value: "replace", label: "Reconfigure" },
      ],
    });
    cancelGuard(action);
    if (action === "keep") return;
    await deps.transportStore.removeChannel(existing.id);
  } else {
    const add = await p.confirm({ message: "Add a Telegram channel? (optional)" });
    if (!cancelGuard(add)) return;
  }

  p.note(
    "Message @BotFather on Telegram → /newbot → follow prompts\nThe token looks like: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
    "How to get a Telegram bot token",
  );

  const token = cancelGuard(
    await p.password({
      message: "Paste your bot token:",
      validate: (v) => {
        if (!v || !v.includes(":")) return "Token should contain a colon (e.g., 123:ABC)";
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
    return;
  }
  s.stop(`Connected as @${result.meta?.botUsername}`);

  // Store bot token as an encrypted secret, reference by name in channel credentials.
  // The adapter resolves the secret at startup via the secrets store.
  const tokenSecretName = "telegram_bot_token";
  await deps.secretsStore.putSecret({
    name: tokenSecretName,
    plaintext: token,
    description: `Telegram bot token (@${result.meta?.botUsername})`,
  });
  await deps.secretsStore.markValidated(tokenSecretName);

  const { id: channelId } = await deps.transportStore.createChannel({
    type: "telegram",
    credentials: { tokenSecretName },
    identityMode: "mapped",
  });

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
    await deps.transportStore.createIdentity({
      userId,
      channelId,
      platformHandle: telegramUserId,
    });
  }

  p.log.success(
    `Telegram channel created with ${userIds.length} allowed user${userIds.length === 1 ? "" : "s"}.`,
  );
}

async function stepConfigureOptionalTools(deps: WizardDeps): Promise<void> {
  const addTools = await p.confirm({
    message: "Configure optional web tools? (Tavily search, etc.)",
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

async function stepSummary(deps: WizardDeps): Promise<void> {
  const providers = await deps.agentStore.listProviders();
  const secrets = await deps.secretsStore.listSecrets();
  const telegramChannel = await deps.transportStore.getChannelByType("telegram");

  const lines: string[] = [];
  lines.push(`Providers: ${providers.map((p) => p.name).join(", ") || "none"}`);
  lines.push(`Secrets: ${secrets.length} stored`);
  lines.push(`Telegram: ${telegramChannel ? "configured" : "not configured"}`);

  p.note(lines.join("\n"), "Setup complete");
  p.outro("Cogmo is ready. Start with `cogmo serve` and send a message.");
}

// --- Main wizard ---

export async function runWizard(deps: {
  db: import("../db/index.js").Database;
  agentStore: AgentStore;
  transportStore: TransportStore;
  masterKey: string;
}): Promise<void> {
  const encryptionKey = deriveMasterKey(parseMasterKey(deps.masterKey), "cogmo/secrets-at-rest/v1");
  const secretsStore = new DrizzleSecretsStore(deps.db, encryptionKey);

  const wizardDeps: WizardDeps = {
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
    const providers = await wizardDeps.agentStore.listProviders();
    hasProvider = providers.length > 0;
    if (!hasProvider) {
      p.log.warn("At least one LLM provider is required. Let's try again.");
    }
  }

  // Step 3: Telegram (optional)
  await stepConfigureTelegram(wizardDeps, userId);

  // Step 4: Optional tools
  await stepConfigureOptionalTools(wizardDeps);

  // Step 5: Hindsight check
  await stepValidateHindsight();

  // Step 6: Summary
  await stepSummary(wizardDeps);
}
