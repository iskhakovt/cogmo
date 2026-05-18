/**
 * `cogmo image-provider <command>` — manage `image_providers` rows post-setup.
 *
 * Mirrors `cogmo provider` (LLM providers) but for image generation. The
 * setup wizard handles fal-only configuration via the existing API-key
 * prompt; this CLI is the surface for adding `openai_compatible` providers
 * (Venice, OpenAI's `/images/generations`, custom inference servers) and
 * any post-setup edits.
 *
 * Image providers have no `model_providers`-style routing chain — one
 * model = one provider. Deletion cascades to `image_models`.
 */

import { InvalidProviderConfigError } from "../agent/store/errors.js";
import type { AgentStore } from "../agent/store/index.js";
import type { ImageProviderTypeValue } from "../agent/store/schema.js";
import type { Transactor } from "../db/index.js";
import type { SecretsStore } from "../secrets/store/index.js";

/**
 * Provider names round-trip into `secrets.name` as `<name>_api_key`, so the
 * shape needs to be conservative enough that whitespace, shell
 * metacharacters, or Unicode can't propagate there. Same shape as
 * `CANONICAL_NAME_RE` used for compartments / profile classes
 * (`src/agent/store/index.ts`).
 */
const PROVIDER_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

const USAGE = `Usage: cogmo image-provider <command> [args]

Commands:
  add <type> <name> <api-key> [base-url]
                          Register an image provider. \`type\` is one of:
                          fal, openai_compatible, venice. base-url is
                          REQUIRED for openai_compatible (e.g.
                          https://api.openai.com/v1) and venice
                          (https://api.venice.ai/api/v1), and FORBIDDEN
                          for fal.

                          Venice extras (all venice-only; all optional;
                          stored in image_providers.attrs.imageGenerationDefaults):
                            --safe-mode true|false    blur flagged content
                                                      (Venice default true; pass
                                                      false to opt out — the
                                                      adapter then treats a
                                                      returned x-venice-is-blurred
                                                      response as a failed
                                                      generation).
                            --cfg-scale 0-20          prompt-adherence dial
                                                      (higher = stricter).
                            --hide-watermark true|false
                                                      strip Venice's watermark.
                            --style-preset <name>     server-side style preset
                                                      (e.g. "Photographic").
  list                    Show registered image providers (name | type | base url).
  remove <name>           Delete a provider (cascades to its image_models rows).
`;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const CONSOLE_IO: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export interface ImageProviderCliDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  secretsStore: SecretsStore;
}

export async function runImageProviderCli(
  argv: readonly string[],
  deps: ImageProviderCliDeps,
  io: CliIo = CONSOLE_IO,
): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.out(USAGE);
        return 0;
      case "list":
        return await listProviders(deps, io);
      case "add":
        return await addProviderCmd(rest, deps, io);
      case "remove":
        return await removeProvider(rest, deps, io);
      default:
        io.err(`Unknown command: ${command}\n`);
        io.err(USAGE);
        return 1;
    }
  } catch (err) {
    io.err(`Error: ${(err as Error).message}`);
    return 2;
  }
}

async function listProviders(deps: ImageProviderCliDeps, io: CliIo): Promise<number> {
  const rows = await deps.runInTx((tx) => deps.agentStore.listImageProviders(tx));
  if (rows.length === 0) {
    io.out("(no image providers registered)");
    return 0;
  }
  io.out("name\ttype\tbase_url");
  for (const r of rows) {
    io.out(`${r.name}\t${r.type}\t${r.baseUrl ?? "-"}`);
  }
  return 0;
}

async function addProviderCmd(
  args: readonly string[],
  deps: ImageProviderCliDeps,
  io: CliIo,
): Promise<number> {
  // Split positional args from named flags so venice extras can appear in
  // any order after the type/name/api-key triple. Order doesn't matter for
  // the flags, but the positional triple must come first to preserve the
  // existing CLI contract.
  const positional: string[] = [];
  let safeModeFlag: boolean | undefined;
  let cfgScaleFlag: number | undefined;
  let hideWatermarkFlag: boolean | undefined;
  let stylePresetFlag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--safe-mode") {
      const value = args[i + 1];
      if (value !== "true" && value !== "false") {
        io.err(`--safe-mode requires "true" or "false" (got "${value ?? ""}")`);
        return 2;
      }
      safeModeFlag = value === "true";
      i++;
    } else if (arg === "--cfg-scale") {
      const value = args[i + 1];
      const parsed = value === undefined ? Number.NaN : Number(value);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 20) {
        io.err(`--cfg-scale requires a number 0–20 (got "${value ?? ""}")`);
        return 2;
      }
      cfgScaleFlag = parsed;
      i++;
    } else if (arg === "--hide-watermark") {
      const value = args[i + 1];
      if (value !== "true" && value !== "false") {
        io.err(`--hide-watermark requires "true" or "false" (got "${value ?? ""}")`);
        return 2;
      }
      hideWatermarkFlag = value === "true";
      i++;
    } else if (arg === "--style-preset") {
      const value = args[i + 1];
      if (value === undefined || value.length === 0) {
        io.err(`--style-preset requires a non-empty string`);
        return 2;
      }
      stylePresetFlag = value;
      i++;
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  const [typeArg, name, apiKey, baseUrlArg] = positional;
  if (!typeArg || !name || !apiKey) {
    io.err(
      "Usage: cogmo image-provider add <type> <name> <api-key> [base-url] " +
        "[--safe-mode true|false] [--cfg-scale 0-20] [--hide-watermark true|false] " +
        "[--style-preset <name>]",
    );
    return 2;
  }
  if (typeArg !== "fal" && typeArg !== "openai_compatible" && typeArg !== "venice") {
    io.err(`Invalid type "${typeArg}" — expected fal|openai_compatible|venice`);
    return 2;
  }
  if (!PROVIDER_NAME_RE.test(name)) {
    io.err(
      `Invalid name "${name}": must start with a lowercase letter and contain only ` +
        `lowercase letters, digits, hyphens, or underscores (≤32 chars). ` +
        `This shape is reused as the secret name (\`<name>_api_key\`) — looser ` +
        `values would let whitespace or shell metacharacters land in \`secrets.name\`.`,
    );
    return 2;
  }
  // All four extras live in `imageGenerationDefaults` and are venice-only
  // today (the only provider that consumes `safe_mode` / `cfg_scale` /
  // `hide_watermark` / `style_preset` body fields). Reject up front so
  // operators don't end up with a fal or openai_compatible row carrying
  // dead JSONB the runtime won't read.
  const veniceExtras = {
    ...(safeModeFlag !== undefined && { safe_mode: safeModeFlag }),
    ...(cfgScaleFlag !== undefined && { cfg_scale: cfgScaleFlag }),
    ...(hideWatermarkFlag !== undefined && { hide_watermark: hideWatermarkFlag }),
    ...(stylePresetFlag !== undefined && { style_preset: stylePresetFlag }),
  };
  if (Object.keys(veniceExtras).length > 0 && typeArg !== "venice") {
    io.err(
      `--safe-mode / --cfg-scale / --hide-watermark / --style-preset are venice-only ` +
        `(got type=${typeArg})`,
    );
    return 2;
  }
  const providerType: ImageProviderTypeValue = typeArg;
  const baseUrl = baseUrlArg ?? null;
  // Empty `imageGenerationDefaults` would round-trip as `{}` in the row,
  // which is harmless but noisy in CRUD output — only include it when the
  // operator actually opted into at least one default.
  const attrs =
    Object.keys(veniceExtras).length > 0 ? { imageGenerationDefaults: veniceExtras } : {};

  // Materialize the API key into a secret named `<provider-name>_api_key` —
  // consistent with the canonical `fal_api_key` slot the wizard uses, just
  // namespaced for arbitrary providers (`venice_api_key`, etc.). One secret
  // per provider keeps key rotation straightforward.
  const secretName = `${name}_api_key`;
  try {
    const { id: providerId } = await deps.runInTx(async (tx) => {
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
    io.out(`Added image provider "${name}" (id=${providerId}, secret=${secretName}).`);
    io.out(`Next: cogmo image-model add <model-name> --provider ${name} --model-string <id>`);
    return 0;
  } catch (err) {
    if (err instanceof InvalidProviderConfigError) {
      io.err(`Invalid config: ${err.reason}`);
      return 2;
    }
    io.err(`Failed to add image provider: ${(err as Error).message}`);
    return 1;
  }
}

async function removeProvider(
  args: readonly string[],
  deps: ImageProviderCliDeps,
  io: CliIo,
): Promise<number> {
  const [name] = args;
  if (!name) {
    io.err("Usage: cogmo image-provider remove <name>");
    return 2;
  }
  const provider = await deps.runInTx((tx) => deps.agentStore.findImageProviderByName(tx, name));
  if (!provider) {
    io.err(`No image provider named "${name}".`);
    return 1;
  }
  await deps.runInTx((tx) => deps.agentStore.deleteImageProvider(tx, provider.id));
  io.out(`Removed image provider "${name}". Its image_models rows cascade-deleted.`);
  return 0;
}
