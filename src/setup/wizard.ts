/**
 * Interactive setup wizard — guides the user through configuring cogmo.
 *
 * Re-runnable, idempotent, validates credentials against live providers.
 * Writes to DB only — never mutates .env or any file.
 *
 * See design/setup.md for the UX contract.
 */

import * as p from "@clack/prompts";
import {
  CLAUDE_CODE_OAUTH_TOKEN_SECRET,
  CLAUDE_CODE_OAUTH_TOKEN_SECRET_DESCRIPTION,
} from "../agent/coding/auth.js";
import { addModelRouting } from "../agent/provider/add-model-routing.js";
import { addProvider } from "../agent/provider/add-provider.js";
import {
  type DiscoveredModel,
  DiscoveryUnavailable,
  discoverModels,
} from "../agent/provider/discover-models.js";
import type { AgentStore } from "../agent/store/index.js";
import type { ProviderAttrs } from "../agent/store/schema.js";
import { type Transactor, transactor } from "../db/transactor.js";
import {
  DAYTONA_API_KEY_SECRET,
  DAYTONA_API_KEY_SECRET_DESCRIPTION,
} from "../sandbox/daytona/auth.js";
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
  type DaytonaProbeOpts,
  validateClaudeCodeOauthToken,
  validateDaytonaApiKey,
  validateGitHubPat,
  validateHindsight,
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
        { value: "add-model", label: "Add a model to an existing provider" },
        { value: "replace", label: "Replace existing provider" },
      ],
    });
    cancelGuard(action);
    if (action === "keep") return;
    if (action === "add-model") {
      await stepAddModelToExisting(deps, existing);
      return;
    }
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

  const adapterType = providerType === "anthropic" ? "anthropic" : "openai_compatible";
  if (adapterType === "openai_compatible" && !baseUrl) {
    throw new Error(`Base URL required for ${String(providerType)} but not set`);
  }

  // Validate + persist via the shared domain function, so this code path is
  // identical to `cogmo provider add`.
  const s = p.spinner();
  s.start("Validating API key...");
  const attrs: ProviderAttrs = {};
  if (providerType === "openrouter") attrs.promptCaching = true;

  const { providerId, validation } = await retryPrompt(
    () =>
      addProvider(deps, {
        name: providerType as string,
        type: adapterType,
        ...(baseUrl && { baseUrl }),
        apiKey,
        attrs,
      }),
    `add provider "${String(providerType)}"`,
  );

  if (!validation.valid) {
    s.stop(`Validation warning: ${validation.error ?? "unknown"}`);
    const proceed = await p.confirm({ message: "Save anyway and continue with model setup?" });
    if (!cancelGuard(proceed)) return;
  } else {
    s.stop("API key validated.");
  }

  // Pick + register at least one model for this provider. Loops so the
  // operator can add multiple models in one wizard pass; CLI covers the
  // post-setup case.
  await stepAddModelsForProvider(deps, {
    providerType,
    adapterType,
    baseUrl: baseUrl ?? "",
    apiKey,
    providerId,
    providerLabel: providerType as string,
  });

  p.log.success(`Provider "${String(providerType)}" configured.`);
}

interface ProviderRegistrationContext {
  providerType: ProviderType;
  adapterType: "anthropic" | "openai_compatible";
  baseUrl: string;
  apiKey: string;
  providerId: string;
  providerLabel: string;
}

/**
 * Pick + register one or more models for a freshly-added provider. Loops
 * until the user declines "add another for this provider?" so a single
 * wizard pass can wire up Sonnet + Haiku on the same Anthropic key, or
 * three different Grok variants on the same OpenRouter key, without
 * dropping into the CLI.
 */
async function stepAddModelsForProvider(
  deps: WizardDeps,
  ctx: ProviderRegistrationContext,
): Promise<void> {
  const discovered = await retryDiscovery(ctx);
  for (let i = 0; ; i++) {
    const picked = await pickModelInteractive(discovered);
    if (picked === null) break; // user opted out of adding a model

    await registerModelForProvider(deps, ctx, picked);

    if (i === 0) {
      // First model is required for the wizard to be useful. Default-no
      // beyond that — bulk additions are still possible via the CLI.
      const another = await p.confirm({
        message: `Add another model for "${ctx.providerLabel}"?`,
        initialValue: false,
      });
      if (!cancelGuard(another)) break;
    } else {
      const another = await p.confirm({
        message: "Add another?",
        initialValue: false,
      });
      if (!cancelGuard(another)) break;
    }
  }
}

/**
 * Add a model to an already-registered provider (the wizard's "add a
 * model to an existing provider" branch). Shares the picker + registration
 * flow with `stepAddModelsForProvider`.
 */
async function stepAddModelToExisting(
  deps: WizardDeps,
  existing: ReadonlyArray<{ id: string; name: string; type: string }>,
): Promise<void> {
  const provider = await p.select({
    message: "Which provider?",
    options: existing.map((p) => ({ value: p.id, label: p.name })),
  });
  cancelGuard(provider);
  const row = existing.find((p) => p.id === provider);
  if (!row) return;

  // Re-fetch the full provider row to recover its base URL + decrypted
  // secret so discovery can run with the original credentials. Skip the
  // wizard's discovery step entirely when the provider type doesn't
  // support model discovery (Anthropic direct still works; custom-with-no-
  // `/v1/models` falls back to free-form input).
  const full = await deps.runInTx((tx) => deps.agentStore.getProvider(tx, row.id));
  if (!full) {
    p.log.error(`Provider "${row.name}" disappeared mid-flight. Aborting.`);
    return;
  }
  const apiKey = await deps.runInTx((tx) => deps.secretsStore.getSecretById(tx, full.secretId));
  if (!apiKey) {
    p.log.error(`Secret for provider "${row.name}" not found. Re-run setup.`);
    return;
  }
  const adapterType = (full.type === "anthropic" ? "anthropic" : "openai_compatible") as
    | "anthropic"
    | "openai_compatible";
  const baseUrl = full.baseUrl ?? "";
  await stepAddModelsForProvider(deps, {
    providerType: "custom",
    adapterType,
    baseUrl,
    apiKey,
    providerId: row.id,
    providerLabel: row.name,
  });
}

/**
 * Run `/v1/models` discovery with retry-on-failure prompts. Returns
 * `null` when the endpoint doesn't expose model listing — caller falls
 * back to free-form text input.
 */
async function retryDiscovery(ctx: ProviderRegistrationContext): Promise<DiscoveredModel[] | null> {
  for (;;) {
    const s = p.spinner();
    s.start("Discovering available models...");
    try {
      const models = await discoverModels({
        type: ctx.adapterType,
        baseUrl: ctx.baseUrl || guessAnthropicUrl(ctx.adapterType),
        apiKey: ctx.apiKey,
      });
      s.stop(`Found ${models.length} model${models.length === 1 ? "" : "s"}.`);
      return models;
    } catch (err) {
      s.stop(`Discovery failed: ${(err as Error).message}`);
      if (err instanceof DiscoveryUnavailable) {
        // Provider doesn't expose /v1/models. Fine — text input fallback.
        return null;
      }
      const next = await p.select({
        message: "Discovery failed. What would you like to do?",
        options: [
          { value: "retry", label: "Retry" },
          { value: "skip", label: "Skip — type the model id by hand" },
          { value: "abort", label: "Abort this provider" },
        ],
      });
      cancelGuard(next);
      if (next === "retry") continue;
      if (next === "skip") return null;
      throw new WizardCancelled();
    }
  }
}

function guessAnthropicUrl(adapter: "anthropic" | "openai_compatible"): string {
  return adapter === "anthropic" ? "https://api.anthropic.com" : "";
}

/**
 * Show a searchable picker over the discovered list, or fall back to a
 * free-form text input when discovery returned null. Returns `null` when
 * the user opts out of adding a model.
 */
async function pickModelInteractive(
  discovered: DiscoveredModel[] | null,
): Promise<DiscoveredModel | null> {
  if (discovered === null || discovered.length === 0) {
    const id = await p.text({
      message: "Enter the model id (no model list available from this provider):",
      validate: (v = "") => (v.trim().length === 0 ? "Required" : undefined),
    });
    const value = cancelGuard(id).trim();
    if (!value) return null;
    return { id: value };
  }

  const choice = await p.autocomplete({
    message: "Pick a model (type to filter):",
    options: discovered.map((m) => ({
      value: m.id,
      label: m.id,
      // exactOptionalPropertyTypes is on — only include `hint` when it has
      // a value, otherwise the entry shape doesn't match clack's type.
      ...(m.name && { hint: m.name }),
    })),
    initialUserInput: "",
  });
  const picked = cancelGuard(choice);
  const match = discovered.find((m) => m.id === picked);
  return match ?? null;
}

/**
 * Resolve limits for a picked model and insert the routing row. Prompts
 * for explicit limits only when discovery didn't include them — the
 * resolver still has the LiteLLM bundled snapshot to fall through to, and
 * the operator can leave the prompts at their defaults if they don't
 * care.
 */
async function registerModelForProvider(
  deps: WizardDeps,
  ctx: ProviderRegistrationContext,
  picked: DiscoveredModel,
): Promise<void> {
  // Inline OpenRouter-style limits go straight into the row override.
  // For everything else we leave both columns null so the resolver
  // falls through to LiteLLM → conservative default. Operators who want
  // to pin can do so via `cogmo model add --context N --max-output N`.
  await addModelRouting(deps, {
    model: picked.id,
    providerId: ctx.providerId,
    userSelectable: true,
    ...(picked.contextWindow != null && { contextWindow: picked.contextWindow }),
    ...(picked.maxOutputTokens != null && { maxOutputTokens: picked.maxOutputTokens }),
  });
  p.log.success(`Registered "${picked.id}" on "${ctx.providerLabel}".`);
}

/**
 * Wrap an external-API call with `retry / skip / abort` prompts on
 * failure. `skip` returns the failure as a rejected promise so the
 * caller's catch handler can decide what to do; most call sites should
 * abort entirely on skip (treat the operator's "skip" as "this provider
 * isn't ready").
 */
async function retryPrompt<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      p.log.error(`Failed to ${label}: ${(err as Error).message}`);
      const next = await p.select({
        message: "What would you like to do?",
        options: [
          { value: "retry", label: "Retry" },
          { value: "abort", label: "Abort" },
        ],
      });
      cancelGuard(next);
      if (next === "retry") continue;
      throw new WizardCancelled();
    }
  }
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
  await deps.runInTx((tx) =>
    deps.secretsStore.putSecret(tx, {
      name: tokenSecretName,
      plaintext: token,
      description: `Telegram bot token (@${result.meta?.botUsername})`,
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
      await deps.runInTx((tx) =>
        deps.secretsStore.putSecret(tx, {
          name: "tavily_api_key",
          plaintext: tavilyKey,
          description: "Tavily web search",
        }),
      );
      await deps.runInTx((tx) => deps.secretsStore.markValidated(tx, "tavily_api_key"));
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
    await deps.runInTx((tx) =>
      deps.secretsStore.putSecret(tx, {
        name: "fal_api_key",
        plaintext: falKey,
        description: "fal.ai image generation",
      }),
    );
    p.log.success("fal.ai key saved.");
  }
}

/**
 * Configure OpenAI-compatible image providers (Venice, OpenAI gpt-image, custom).
 * Fal is handled in `stepConfigureOptionalTools` via the `fal_api_key` prompt —
 * the boot-time `ensureFalImageDefaults` seed wires the canonical 9-model
 * catalog automatically. This step covers the other half: providers that
 * speak `POST /v1/images/generations` and require per-model registration.
 */
async function stepConfigureImageProviders(deps: WizardDeps): Promise<void> {
  const allExisting = await deps.runInTx((tx) => deps.agentStore.listImageProviders(tx));
  const oaiExisting = allExisting.filter((p) => p.type === "openai_compatible");

  if (oaiExisting.length === 0) {
    const add = await p.confirm({
      message:
        "Configure an OpenAI-compatible image provider? (Venice, OpenAI gpt-image, custom — fal handled separately) (optional)",
      initialValue: false,
    });
    if (!cancelGuard(add)) return;
  } else {
    const names = oaiExisting.map((p) => p.name).join(", ");
    const action = await p.select({
      message: `OpenAI-compatible image provider(s) configured: ${names}. What would you like to do?`,
      options: [
        { value: "keep", label: "Keep current configuration" },
        { value: "add", label: "Add another image provider" },
        { value: "add-model", label: "Add a model to an existing provider" },
      ],
    });
    cancelGuard(action);
    if (action === "keep") return;
    if (action === "add-model") {
      await stepAddImageModelToExisting(deps, oaiExisting);
      return;
    }
  }

  await addOaiImageProvider(deps);
}

const IMAGE_PROVIDER_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const IMAGE_ALLOWED_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9", "9:21"] as const;
type ImageAllowedRatio = (typeof IMAGE_ALLOWED_RATIOS)[number];

async function addOaiImageProvider(deps: WizardDeps): Promise<void> {
  p.note(
    [
      "Venice: https://venice.ai/settings/api → Create API Key",
      "OpenAI: https://platform.openai.com/api-keys",
      "Custom: any endpoint that speaks `POST /v1/images/generations`",
    ].join("\n"),
    "Where to get an API key",
  );

  const name = cancelGuard(
    await p.text({
      message: "Provider name (e.g. venice, openai):",
      validate: (v = "") => {
        if (!IMAGE_PROVIDER_NAME_RE.test(v)) {
          return "Lowercase letters, digits, hyphens, or underscores; must start with a letter; ≤32 chars";
        }
        return undefined;
      },
    }),
  );

  const baseUrl = cancelGuard(
    await p.text({
      message: "Base URL (e.g. https://api.venice.ai/api/v1):",
      validate: (v = "") => {
        if (!v.startsWith("https://")) return "Must start with https://";
        if (v.endsWith("/")) return "Drop the trailing slash";
        return undefined;
      },
    }),
  );

  const apiKey = cancelGuard(
    await p.password({
      message: "API key:",
      validate: (v) => (v && v.length >= 8 ? undefined : "Key seems too short"),
    }),
  );

  const secretName = `${name}_api_key`;
  const s = p.spinner();
  s.start("Saving image provider...");
  try {
    await deps.runInTx(async (tx) => {
      const { id: secretId } = await deps.secretsStore.putSecret(tx, {
        name: secretName,
        plaintext: apiKey,
        description: `openai_compatible image provider key (${name})`,
      });
      return deps.agentStore.createImageProvider(tx, {
        name,
        type: "openai_compatible",
        baseUrl,
        secretId,
        attrs: {},
      });
    });
    s.stop(`Added image provider "${name}".`);
  } catch (err) {
    s.stop(`Failed to add image provider: ${(err as Error).message}`);
    return;
  }

  await promptAddImageModels(deps, name);
}

async function stepAddImageModelToExisting(
  deps: WizardDeps,
  existing: ReadonlyArray<{ name: string; type: string }>,
): Promise<void> {
  const choice = await p.select({
    message: "Which provider?",
    options: existing.map((row) => ({
      value: row.name,
      label: `${row.name} (${row.type})`,
    })),
  });
  await promptAddImageModels(deps, cancelGuard(choice));
}

/**
 * Loop "add a model?" for an already-saved image provider. Each iteration
 * collects name, model-string, description, capabilities, then calls
 * `agentStore.createImageModel`. The same domain function backs
 * `cogmo image-model add` — no behaviour drift between wizard and CLI.
 */
async function promptAddImageModels(deps: WizardDeps, providerName: string): Promise<void> {
  for (let i = 0; ; i++) {
    const prompt =
      i === 0 ? `Add a model for "${providerName}"?` : `Add another model for "${providerName}"?`;
    const add = await p.confirm({ message: prompt, initialValue: i === 0 });
    if (!cancelGuard(add)) break;

    const modelName = cancelGuard(
      await p.text({
        message: "Model name (LLM-facing, e.g. venice/flux-uncensored):",
        validate: (v = "") => (v.trim() ? undefined : "Required"),
      }),
    );
    const modelString = cancelGuard(
      await p.text({
        message: "Model string (provider API id, e.g. flux-dev):",
        validate: (v = "") => (v.trim() ? undefined : "Required"),
      }),
    );
    const description = cancelGuard(
      await p.text({
        message: "Description (one line, read by the LLM at every turn):",
        validate: (v = "") => (v.trim() ? undefined : "Required"),
      }),
    );

    const ratiosInput = cancelGuard(
      await p.text({
        message: "Aspect ratios (comma-separated; Enter to skip — fixed-size model):",
        placeholder: IMAGE_ALLOWED_RATIOS.join(","),
      }),
    );
    const ratios = parseWizardRatios(ratiosInput);
    if (ratios === "invalid") {
      p.log.warn(
        `Some ratios didn't match the allowed set (${IMAGE_ALLOWED_RATIOS.join(", ")}); skipping this model.`,
      );
      continue;
    }

    const seed = cancelGuard(
      await p.confirm({
        message: "Does this model honor a `seed` parameter?",
        initialValue: false,
      }),
    );

    const imageInputChoice = cancelGuard(
      await p.select({
        message: "Reference-image support?",
        options: [
          { value: "none", label: "None — text-to-image only" },
          { value: "optional", label: "Optional" },
          { value: "required", label: "Required (image-editing model)" },
        ],
        initialValue: "none",
      }),
    );

    const provider = await deps.runInTx((tx) =>
      deps.agentStore.findImageProviderByName(tx, providerName),
    );
    if (!provider) {
      p.log.error(`Provider "${providerName}" disappeared mid-flight; aborting.`);
      return;
    }

    const capabilities = {
      ...(ratios && { aspectRatios: [...ratios] }),
      ...(seed && { seed: true }),
      ...(imageInputChoice !== "none" && {
        imageInput: imageInputChoice as "required" | "optional",
      }),
    };

    try {
      await deps.runInTx((tx) =>
        deps.agentStore.createImageModel(tx, {
          providerId: provider.id,
          name: modelName,
          modelString,
          description,
          capabilities,
          userSelectable: true,
        }),
      );
      p.log.success(`Added image model "${modelName}".`);
    } catch (err) {
      p.log.error(`Failed to add model: ${(err as Error).message}`);
    }
  }
}

function parseWizardRatios(raw: string): ReadonlyArray<ImageAllowedRatio> | undefined | "invalid" {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parts = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const validated: ImageAllowedRatio[] = [];
  for (const part of parts) {
    const match = IMAGE_ALLOWED_RATIOS.find((r) => r === part);
    if (!match) return "invalid";
    validated.push(match);
  }
  return validated.length > 0 ? validated : undefined;
}

async function stepConfigureGitHubIdentity(deps: WizardDeps): Promise<void> {
  const existing = await deps.runInTx((tx) =>
    resolveGitHubIdentity(tx, deps.secretsStore, DEFAULT_GITHUB_IDENTITY_NAME),
  );

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

  await deps.runInTx((tx) =>
    deps.secretsStore.putSecret(tx, {
      name: gitHubIdentitySecretName(DEFAULT_GITHUB_IDENTITY_NAME),
      plaintext: serializeGitHubIdentity(identity),
      description: `GitHub identity (@${login})`,
    }),
  );
  await deps.runInTx((tx) =>
    deps.secretsStore.markValidated(tx, gitHubIdentitySecretName(DEFAULT_GITHUB_IDENTITY_NAME)),
  );

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

  await deps.runInTx((tx) =>
    deps.secretsStore.putSecret(tx, {
      name: gitHubIdentitySecretName(DEFAULT_GITHUB_IDENTITY_NAME),
      plaintext: serializeGitHubIdentity(identity),
      description: `GitHub identity (@${login})`,
    }),
  );
  await deps.runInTx((tx) =>
    deps.secretsStore.markValidated(tx, gitHubIdentitySecretName(DEFAULT_GITHUB_IDENTITY_NAME)),
  );
  p.log.success("GitHub PAT rotated.");
}

async function stepConfigureClaudeCodeAuth(deps: WizardDeps): Promise<void> {
  const existing = await deps.runInTx((tx) =>
    deps.secretsStore.getSecretMeta(tx, CLAUDE_CODE_OAUTH_TOKEN_SECRET),
  );

  if (existing) {
    const action = await p.select({
      message: "Claude Code subscription token is already configured. What would you like to do?",
      options: [
        { value: "keep", label: "Keep current token" },
        { value: "replace", label: "Replace (rotate)" },
      ],
    });
    cancelGuard(action);
    if (action === "keep") return;
  } else {
    const proceed = await p.confirm({
      message: "Configure Claude Code subscription auth for the coding-delegation pipeline?",
      initialValue: false,
    });
    if (!cancelGuard(proceed)) return;
  }

  p.note(
    [
      "1. On a machine with a browser, run: claude setup-token",
      "2. Complete the OAuth flow when the browser opens.",
      "3. Copy the token printed to the terminal (valid for 1 year).",
      "",
      "Requires a Claude Pro, Max, Team, or Enterprise plan.",
    ].join("\n"),
    "Where to get a Claude Code OAuth token",
  );

  const rawToken = cancelGuard(
    await p.password({
      message: "Paste your Claude Code OAuth token:",
      validate: (v) => {
        if (!v || v.trim().length < 20) return "Token looks too short";
        return undefined;
      },
    }),
  );
  // Trim — clipboard pastes routinely carry a trailing newline that would
  // corrupt the env var when injected into the sandbox.
  const token = rawToken.trim();

  const s = p.spinner();
  s.start("Validating Claude Code OAuth token...");
  const result = await validateClaudeCodeOauthToken(token);
  if (result.valid) {
    s.stop("Token validated.");
  } else {
    s.stop(`Validation failed: ${result.error}`);
    const saveAnyway = await p.confirm({ message: "Save anyway?", initialValue: false });
    if (!cancelGuard(saveAnyway)) return;
  }

  await deps.runInTx((tx) =>
    deps.secretsStore.putSecret(tx, {
      name: CLAUDE_CODE_OAUTH_TOKEN_SECRET,
      plaintext: token,
      description: CLAUDE_CODE_OAUTH_TOKEN_SECRET_DESCRIPTION,
    }),
  );
  if (result.valid) {
    await deps.runInTx((tx) => deps.secretsStore.markValidated(tx, CLAUDE_CODE_OAUTH_TOKEN_SECRET));
  }

  p.log.success("Claude Code OAuth token stored.");
}

async function stepConfigureDaytona(deps: WizardDeps): Promise<void> {
  const existing = await deps.runInTx((tx) =>
    deps.secretsStore.getSecretMeta(tx, DAYTONA_API_KEY_SECRET),
  );

  if (existing) {
    const action = await p.select({
      message: "Daytona API key is already configured. What would you like to do?",
      options: [
        { value: "keep", label: "Keep current key" },
        { value: "replace", label: "Replace (rotate)" },
      ],
    });
    cancelGuard(action);
    if (action === "keep") return;
  } else {
    const proceed = await p.confirm({
      message:
        "Configure Daytona managed sandbox? (optional — required only when SANDBOX_BACKEND=daytona)",
      initialValue: false,
    });
    if (!cancelGuard(proceed)) return;
  }

  p.note(
    [
      "1. Sign in at https://app.daytona.io",
      "2. Open Settings → API Keys → Create",
      "3. Copy the key. Paste below.",
      "",
      "For self-hosted Daytona or a non-default org, set DAYTONA_API_URL /",
      "DAYTONA_ORGANIZATION_ID in the runtime env before continuing — the",
      "wizard validates the key against whichever endpoint those point at.",
    ].join("\n"),
    "Where to get a Daytona API key",
  );

  const rawKey = cancelGuard(
    await p.password({
      message: "Paste your Daytona API key:",
      validate: (v) => {
        if (!v || v.trim().length < 20) return "API key looks too short";
        return undefined;
      },
    }),
  );
  const apiKey = rawKey.trim();

  const probeOpts: DaytonaProbeOpts = {};
  if (process.env.DAYTONA_API_URL) probeOpts.apiUrl = process.env.DAYTONA_API_URL;
  if (process.env.DAYTONA_ORGANIZATION_ID) {
    probeOpts.organizationId = process.env.DAYTONA_ORGANIZATION_ID;
  }

  const s = p.spinner();
  s.start("Validating Daytona API key...");
  const result = await validateDaytonaApiKey(apiKey, probeOpts);
  if (result.valid) {
    s.stop("API key validated.");
  } else {
    s.stop(`Validation failed: ${result.error}`);
    const saveAnyway = await p.confirm({ message: "Save anyway?", initialValue: false });
    if (!cancelGuard(saveAnyway)) return;
  }

  await deps.runInTx((tx) =>
    deps.secretsStore.putSecret(tx, {
      name: DAYTONA_API_KEY_SECRET,
      plaintext: apiKey,
      description: DAYTONA_API_KEY_SECRET_DESCRIPTION,
    }),
  );
  if (result.valid) {
    await deps.runInTx((tx) => deps.secretsStore.markValidated(tx, DAYTONA_API_KEY_SECRET));
  }

  p.log.success("Daytona API key stored.");
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
  const secrets = await deps.runInTx((tx) => deps.secretsStore.listSecrets(tx));
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
  const secretsStore = new DrizzleSecretsStore(encryptionKey);

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

  // Step 4: Optional tools (Tavily, fal.ai)
  await stepConfigureOptionalTools(wizardDeps);

  // Step 5: OpenAI-compatible image providers (Venice, OpenAI gpt-image, custom)
  await stepConfigureImageProviders(wizardDeps);

  // Step 6: GitHub identity for the coding-delegation pipeline (optional)
  await stepConfigureGitHubIdentity(wizardDeps);

  // Step 7: Claude Code subscription auth for the coding-delegation pipeline (optional)
  await stepConfigureClaudeCodeAuth(wizardDeps);

  // Step 8: Daytona managed sandbox (optional — required when SANDBOX_BACKEND=daytona)
  await stepConfigureDaytona(wizardDeps);

  // Step 9: Hindsight check
  await stepValidateHindsight();

  // Step 10: Summary + next-steps
  await stepSummary(wizardDeps, botUsername);
}
