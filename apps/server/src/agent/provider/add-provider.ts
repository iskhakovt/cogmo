/**
 * Add an LLM provider — domain use case shared by the setup wizard,
 * non-interactive setup and `cogmo provider add`.
 *
 * Validates the supplied API key against the provider's `/v1/models` (or
 * Anthropic's equivalent), persists the encrypted secret, and inserts the
 * `llm_providers` row. Returns the new provider id so the caller can chain
 * a model-routing add against it.
 *
 * Validation is best-effort — we save the credentials regardless and let
 * the caller surface a warning when the live check fails. This matches the
 * wizard's existing "save anyway?" semantics: a corporate gateway might
 * legitimately not respond to `/v1/models` while still serving chat
 * completions, and we don't want to lock operators out of those.
 *
 * An OpenAI-compatible row gets a cache dialect: the caller's, or the one
 * its base URL's host implies (`cacheDialectForBaseUrl`).
 */
import type { Transactor } from "../../db/index.js";
import { type CacheDialect, cacheDialectForBaseUrl } from "../../llm/cache-dialect.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import {
  type ValidationResult,
  validateAnthropicKey,
  validateOpenAICompatibleKey,
} from "../../setup/validate.js";
import type { AgentStore } from "../store/index.js";
import type { ProviderAttrs } from "../store/schema.js";

export type AdapterType = "anthropic" | "openai_compatible";

export interface AddProviderArgs {
  /** Display name (also used as the secret name `${name}_api_key`). */
  name: string;
  /** Adapter the resolver builds for this provider. */
  type: AdapterType;
  /** Required for `openai_compatible`; optional for `anthropic` (SDK default). */
  baseUrl?: string;
  apiKey: string;
  /**
   * Which caching hints an `openai_compatible` endpoint takes. Omitted, the
   * base URL's host decides — for an endpoint behind a proxy, say so here.
   */
  cacheDialect?: CacheDialect;
  /**
   * The key's validation, when the caller has already checked it —
   * non-interactive setup validates every credential before it writes
   * anything. Omitted, the key is checked live here.
   */
  validation?: ValidationResult;
}

export interface AddProviderDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  secretsStore: SecretsStore;
}

export interface AddProviderResult {
  providerId: string;
  secretId: string;
  /** The key's validation, the caller's or the live check's. `valid: false` doesn't block the save. */
  validation: ValidationResult;
}

export async function addProvider(
  deps: AddProviderDeps,
  args: AddProviderArgs,
): Promise<AddProviderResult> {
  const validation = args.validation ?? (await validateKey(args));
  const secretName = `${args.name}_api_key`;

  // One transaction wraps secret insert + validation mark + provider
  // insert. A failing `createProvider` (e.g. duplicate `name` UNIQUE
  // violation on a re-add) would otherwise leave the secret behind with
  // no owner — recoverable manually but ugly. With a single tx the
  // failure rolls everything back atomically.
  const { providerId, secretId } = await deps.runInTx(async (tx) => {
    const { id: sId } = await deps.secretsStore.putSecret(tx, {
      name: secretName,
      plaintext: args.apiKey,
      description: `API key for ${args.name}`,
    });
    if (validation.valid) {
      await deps.secretsStore.markValidated(tx, secretName);
    }
    const { id: pId } = await deps.agentStore.createProvider(tx, {
      name: args.name,
      type: args.type,
      ...(args.baseUrl && { baseUrl: args.baseUrl }),
      secretId: sId,
      attrs: providerAttrs(args),
    });
    return { providerId: pId, secretId: sId };
  });

  return { providerId, secretId, validation };
}

function providerAttrs(args: AddProviderArgs): ProviderAttrs {
  if (args.type === "anthropic") return {};
  if (args.cacheDialect) return { cacheDialect: args.cacheDialect };
  return { cacheDialect: args.baseUrl ? cacheDialectForBaseUrl(args.baseUrl) : "none" };
}

async function validateKey(args: AddProviderArgs): Promise<ValidationResult> {
  if (args.type === "anthropic") {
    return validateAnthropicKey(args.apiKey, args.baseUrl);
  }
  if (!args.baseUrl) {
    return { valid: false, error: "openai_compatible providers require a base URL" };
  }
  return validateOpenAICompatibleKey(args.apiKey, args.baseUrl);
}
