/**
 * Wizard step: the models routed to an LLM provider — discovered through
 * `/v1/models` where the endpoint lists them, typed by hand where it doesn't.
 */

import * as p from "@clack/prompts";
import { addModelRouting } from "../../agent/provider/add-model-routing.js";
import { type DiscoveredModel, discoverModels } from "../../agent/provider/discover-models.js";
import type { ProviderType } from "../providers.js";
import { cancelGuard, WizardCancelled, type WizardDeps } from "./step.js";

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
export async function stepAddModelsForProvider(
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
export async function stepAddModelToExisting(
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
    const discovered = await discoverModels({
      type: ctx.adapterType,
      baseUrl: ctx.baseUrl || guessAnthropicUrl(ctx.adapterType),
      apiKey: ctx.apiKey,
    });
    if (discovered.isOk()) {
      const models = discovered.value;
      s.stop(`Found ${models.length} model${models.length === 1 ? "" : "s"}.`);
      return models;
    }
    s.stop(`Discovery failed: ${discovered.error.message}`);
    // No model list from this endpoint: fall back to text input.
    if (discovered.error.kind === "unavailable") return null;
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
