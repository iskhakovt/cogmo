import type { Inngest } from "inngest";
import type { JsonValue } from "type-fest";
import type { AgentStore } from "../agent/store/index.js";
import type { inboundArrived as InboundArrivedEvent } from "../inngest/events.js";
import { logger } from "../logger.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { adaptersByType } from "./adapters/index.js";
import type { AttachmentStore } from "./attachment-store.js";
import type { AdapterEntry } from "./delivery-router.js";
import type { TransportStore } from "./store/index.js";
import { createTransport } from "./transport.js";
import type { Adapter } from "./types.js";

export interface RegistryDeps {
  defaultUserId: string;
  defaultProfileId: string;
  transportStore: TransportStore;
  agentStore: AgentStore;
  inngest: Inngest;
  inboundArrived: typeof InboundArrivedEvent;
  attachments: AttachmentStore;
  idleTimeoutMs: number;
  /** Resolves secret references in channel credentials before passing to adapters. */
  secretsStore: SecretsStore;
}

export interface RegistryResult {
  // biome-ignore lint/suspicious/noExplicitAny: Inngest function types vary by trigger
  functions: any[];
  adapters: Adapter[];
  adapterMap: Map<string, AdapterEntry>;
}

/**
 * Read channels from DB and start the appropriate adapters.
 *
 * Table-driven — matches channel.type to registered adapter modules.
 * Each adapter provides an Adapter instance + optional Inngest functions.
 * Returns an adapterMap for the DeliveryRouter.
 */
export async function startChannels(deps: RegistryDeps): Promise<RegistryResult> {
  const { transportStore, agentStore } = deps;
  // biome-ignore lint/suspicious/noExplicitAny: Inngest function types vary by trigger
  const functions: any[] = [];
  const adapters: Adapter[] = [];
  const adapterMap = new Map<string, AdapterEntry>();

  const channels = await transportStore.getAllChannels();

  for (const channel of channels) {
    const mod = adaptersByType.get(channel.type);
    if (!mod) {
      logger.warn({ type: channel.type, channelId: channel.id }, "unknown channel type");
      continue;
    }

    logger.info({ type: channel.type, channelId: channel.id }, "starting channel adapter");

    const transport = createTransport({
      channelId: channel.id,
      defaultUserId: deps.defaultUserId,
      defaultProfileId: deps.defaultProfileId,
      transportStore,
      agentStore,
      inngest: deps.inngest,
      inboundArrived: deps.inboundArrived,
      attachments: deps.attachments,
      idleTimeoutMs: deps.idleTimeoutMs,
    });

    // Resolve secret references in credentials before passing to adapter.
    // Credentials like { tokenSecretName: "telegram_bot_token" } are resolved
    // to { token: "actual-token-value" } so adapters never see secret names.
    const credentials = await resolveCredentialSecrets(channel.credentials, deps.secretsStore);

    const result = await mod.setup({
      channelId: channel.id,
      credentials,
      transport,
    });

    adapters.push(result.adapter);
    adapterMap.set(channel.id, {
      adapter: result.adapter,
      renderOutput: mod.renderOutput,
    });
    functions.push(...result.functions);
  }

  logger.info({ count: channels.length }, "channel adapters started");
  return { functions, adapters, adapterMap };
}

/**
 * Resolve secret references in channel credentials.
 *
 * Convention: any credential field ending in `SecretName` (e.g., `tokenSecretName`)
 * is resolved to its plaintext value under the base field name (e.g., `token`).
 * The `SecretName` field is removed from the result.
 *
 * If no secrets store is provided (tests, dev without master key), credentials
 * pass through unchanged — adapters must handle both resolved and raw formats.
 */
export async function resolveCredentialSecrets(
  credentials: JsonValue,
  secretsStore: SecretsStore,
): Promise<JsonValue> {
  if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)) {
    return credentials;
  }

  const resolved: Record<string, JsonValue> = { ...(credentials as Record<string, JsonValue>) };

  for (const [key, value] of Object.entries(resolved)) {
    if (key.endsWith("SecretName") && typeof value === "string") {
      const baseKey = key.slice(0, -"SecretName".length);
      const secret = await secretsStore.getSecret(value);
      if (!secret) {
        throw new Error(
          `Channel credential references secret "${value}" but it was not found. Re-run \`cogmo setup\` to reconfigure.`,
        );
      }
      resolved[baseKey] = secret;
      delete resolved[key];
    }
  }

  return resolved;
}
