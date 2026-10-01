/**
 * Wizard step: the LLM provider — type, base URL and API key, validated and
 * stored through the same `addProvider` as `cogmo provider add`.
 */

import * as p from "@clack/prompts";
import { addProvider } from "../../agent/provider/add-provider.js";
import { defaultCacheDialect, PROVIDER_BASE_URLS, type ProviderType } from "../providers.js";
import { stepAddModelsForProvider, stepAddModelToExisting } from "./llm-models.js";
import { cancelGuard, WizardCancelled, type WizardDeps } from "./step.js";

// --- Provider UI metadata (canonical types/URLs come from providers.ts) ---

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

export async function stepConfigureProvider(deps: WizardDeps): Promise<void> {
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

  const cacheDialect = defaultCacheDialect(providerType, undefined);
  const { providerId, validation } = await retryPrompt(
    () =>
      addProvider(deps, {
        name: providerType as string,
        type: adapterType,
        ...(baseUrl && { baseUrl }),
        apiKey,
        ...(cacheDialect && { cacheDialect }),
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
