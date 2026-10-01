/**
 * Wizard step: non-fal image providers and the models registered on them.
 */

import * as p from "@clack/prompts";
import { describeImageCatalogError } from "../../agent/store/errors.js";
import { IMAGE_ALLOWED_ASPECT_RATIOS, type ImageAspectRatio } from "../../agent/store/schema.js";
import { commitIfOk } from "../../db/transactor.js";
import { cancelGuard, type WizardDeps } from "./step.js";

/**
 * Configure non-fal image providers — `openai_compatible` (OpenAI dall-e,
 * custom inference servers) and `venice` (Venice.ai native API,
 * supports `safe_mode` / `negative_prompt`). Fal is handled in
 * `stepConfigureOptionalTools` via the `fal_api_key` prompt — the boot-time
 * `ensureFalImageDefaults` seed wires the canonical 9-model catalog
 * automatically. This step covers the other half: providers that require
 * per-model registration.
 */
export async function stepConfigureImageProviders(deps: WizardDeps): Promise<void> {
  const allExisting = await deps.runInTx((tx) => deps.agentStore.listImageProviders(tx));
  // Both non-fal provider types share the same wizard flow (name + base
  // URL + key + per-model loop); the type discriminator picks venice's
  // extra `safe_mode` default prompt at the end.
  const nonFalExisting = allExisting.filter(
    (p) => p.type === "openai_compatible" || p.type === "venice",
  );

  if (nonFalExisting.length === 0) {
    const add = await p.confirm({
      message:
        "Configure an OpenAI-compatible or Venice image provider? (Venice, OpenAI gpt-image, custom — fal handled separately) (optional)",
      initialValue: false,
    });
    if (!cancelGuard(add)) return;
  } else {
    const names = nonFalExisting.map((p) => `${p.name} (${p.type})`).join(", ");
    const action = await p.select({
      message: `Image provider(s) configured: ${names}. What would you like to do?`,
      options: [
        { value: "keep", label: "Keep current configuration" },
        { value: "add", label: "Add another image provider" },
        { value: "add-model", label: "Add a model to an existing provider" },
      ],
    });
    cancelGuard(action);
    if (action === "keep") return;
    if (action === "add-model") {
      await stepAddImageModelToExisting(deps, nonFalExisting);
      return;
    }
  }

  await addNonFalImageProvider(deps);
}

const IMAGE_PROVIDER_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

async function addNonFalImageProvider(deps: WizardDeps): Promise<void> {
  p.note(
    [
      "venice — Venice.ai native API (supports safe_mode + negative_prompt)",
      "  https://venice.ai/settings/api → Create API Key",
      "openai_compatible — OpenAI dall-e, custom inference servers (no Venice extras)",
      "  https://platform.openai.com/api-keys",
      "  Custom: any endpoint that speaks `POST /v1/images/generations`",
    ].join("\n"),
    "Provider types",
  );

  const providerType = cancelGuard(
    await p.select<"venice" | "openai_compatible">({
      message: "Provider type?",
      options: [
        { value: "venice", label: "venice — Venice.ai native API" },
        {
          value: "openai_compatible",
          label: "openai_compatible — OpenAI dall-e / custom OpenAI-shaped endpoint",
        },
      ],
      initialValue: "venice",
    }),
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

  const defaultBaseUrl =
    providerType === "venice" ? "https://api.venice.ai/api/v1" : "https://api.openai.com/v1";
  const baseUrl = cancelGuard(
    await p.text({
      message: `Base URL (default ${defaultBaseUrl}):`,
      placeholder: defaultBaseUrl,
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

  // Venice-specific provider-level defaults. `safe_mode` is the only one we
  // prompt for in the wizard today; the other knobs (`cfg_scale`,
  // `hide_watermark`, `style_preset`) are available through `cogmo
  // image-provider` for operators who want finer control without cluttering
  // the wizard.
  let safeMode: boolean | undefined;
  if (providerType === "venice") {
    const safeModeChoice = cancelGuard(
      await p.confirm({
        message: "Venice safe_mode default? (true applies a blur; false disables blur)",
        initialValue: true,
      }),
    );
    safeMode = safeModeChoice;
  }
  const attrs = safeMode !== undefined ? { imageGenerationDefaults: { safe_mode: safeMode } } : {};

  const secretName = `${name}_api_key`;
  const s = p.spinner();
  s.start("Saving image provider...");
  // The secret rolls back with a rejected provider.
  const created = await commitIfOk(deps.runInTx, async (tx) => {
    const { id: secretId } = await deps.secretsStore.putSecret(tx, {
      name: secretName,
      plaintext: apiKey,
      description: `${providerType} image provider key (${name})`,
    });
    return deps.agentStore.createImageProvider(tx, {
      name,
      type: providerType,
      baseUrl,
      secretId,
      attrs,
    });
  });
  if (created.isErr()) {
    s.stop(`Failed to add image provider: ${describeImageCatalogError(created.error)}`);
    return;
  }
  const providerId = created.value.id;
  s.stop(`Added image provider "${name}".`);

  // No credential probe here — unlike the LLM-provider step we can't ping
  // `/v1/models` without a model id we haven't collected yet, and an unsolicited
  // 1×1 test gen would surprise-bill the operator. Surface that loud and clear
  // so a typo'd key isn't a silent failure waiting for the first generation.
  p.log.warn(
    `API key saved as "${secretName}" without live validation. ` +
      "Errors (bad key, wrong URL) surface on the first image generation.",
  );

  await promptAddImageModels(deps, name, providerId, providerType);
}

async function stepAddImageModelToExisting(
  deps: WizardDeps,
  existing: ReadonlyArray<{ id: string; name: string; type: string }>,
): Promise<void> {
  const choice = await p.select({
    message: "Which provider?",
    options: existing.map((row) => ({
      value: row.id,
      label: `${row.name} (${row.type})`,
    })),
  });
  const providerId = cancelGuard(choice);
  const row = existing.find((r) => r.id === providerId);
  if (!row) return; // unreachable — the select only offered known ids
  // Narrow the runtime `type` string back to the typed enum the inner
  // prompt loop branches on. Anything outside the non-fal subset is
  // already filtered upstream — the caller restricts `existing` to those
  // types before opening the select.
  const typedKind: "venice" | "openai_compatible" =
    row.type === "venice" ? "venice" : "openai_compatible";
  await promptAddImageModels(deps, row.name, row.id, typedKind);
}

/**
 * Loop "add a model?" for an already-saved image provider. Each iteration
 * collects name, model-string, description, capabilities, then calls
 * `agentStore.createImageModel`. The same domain function backs
 * `cogmo image-model add` — no behaviour drift between wizard and CLI.
 *
 * Caller passes `providerId` (known from the createImageProvider return or
 * the "add-model-to-existing" select) so we don't re-look-up by name on
 * every iteration.
 */
async function promptAddImageModels(
  deps: WizardDeps,
  providerName: string,
  providerId: string,
  providerType: "venice" | "openai_compatible",
): Promise<void> {
  for (let i = 0; ; i++) {
    const prompt =
      i === 0 ? `Add a model for "${providerName}"?` : `Add another model for "${providerName}"?`;
    const add = await p.confirm({ message: prompt, initialValue: i === 0 });
    if (!cancelGuard(add)) break;

    const modelName = cancelGuard(
      await p.text({
        message: "Model name (LLM-facing, e.g. venice/flux-dev):",
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
        placeholder: IMAGE_ALLOWED_ASPECT_RATIOS.join(","),
        // Inline validate so a typo doesn't blow away the name/model-string/
        // description the user already typed — they edit-fix the ratios prompt
        // and continue. The parser does the work; we discard the parse result
        // here and re-call after to keep types clean.
        validate: (v = "") => {
          if (parseWizardRatios(v) === "invalid") {
            return `Allowed: ${IMAGE_ALLOWED_ASPECT_RATIOS.join(", ")}`;
          }
          return undefined;
        },
      }),
    );
    const ratios = parseWizardRatios(ratiosInput);
    // Validator above guarantees this is never "invalid" by the time we get
    // here — the prompt won't accept the value. Narrow accordingly.
    if (ratios === "invalid") continue;

    const seed = cancelGuard(
      await p.confirm({
        message: "Does this model honor a `seed` parameter?",
        initialValue: false,
      }),
    );

    const imageInputChoice = cancelGuard(
      await p.select<"none" | "optional" | "required">({
        message: "Reference-image support?",
        options: [
          { value: "none", label: "None — text-to-image only" },
          { value: "optional", label: "Optional" },
          { value: "required", label: "Required (image-editing model)" },
        ],
        initialValue: "none",
      }),
    );

    // Venice models accept `negative_prompt` natively. Canonical OpenAI
    // images (`/v1/images/generations`) rejects it with HTTP 400 because
    // DALL-E / gpt-image-* don't model the concept. But "openai_compatible"
    // is a broader category — some OpenAI-shaped servers (Together,
    // Replicate's shim, custom inference) accept extra body fields the
    // handler can forward via `providerOptions[providerName]`. Default the
    // toggle accordingly; keep it user-overridable.
    const negativePrompt = cancelGuard(
      await p.confirm({
        message: "Does this model accept a negative prompt (`negativePrompt` tool field)?",
        initialValue: providerType === "venice",
      }),
    );

    const capabilities = {
      ...(ratios && { aspectRatios: [...ratios] }),
      ...(seed && { seed: true }),
      ...(imageInputChoice !== "none" && {
        imageInput: imageInputChoice,
      }),
      ...(negativePrompt && { negativePrompt: true }),
    };

    const created = await deps.runInTx((tx) =>
      deps.agentStore.createImageModel(tx, {
        providerId,
        name: modelName,
        modelString,
        description,
        capabilities,
        userSelectable: true,
      }),
    );
    if (created.isOk()) p.log.success(`Added image model "${modelName}".`);
    else p.log.error(`Failed to add model: ${describeImageCatalogError(created.error)}`);
  }
}

function parseWizardRatios(raw: string): ReadonlyArray<ImageAspectRatio> | undefined | "invalid" {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parts = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const validated: ImageAspectRatio[] = [];
  for (const part of parts) {
    const match = IMAGE_ALLOWED_ASPECT_RATIOS.find((r) => r === part);
    if (!match) return "invalid";
    validated.push(match);
  }
  return validated.length > 0 ? validated : undefined;
}
