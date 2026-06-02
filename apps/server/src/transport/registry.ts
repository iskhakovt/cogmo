import type { Inngest } from "inngest";
import type { JsonValue } from "type-fest";
import type { CodingStore } from "../agent/coding/store/index.js";
import type { CodingStreamingRegistry } from "../agent/coding/streaming-registry.js";
import type { TriggerReflectionResult } from "../agent/evolution/trigger-reflection.js";
import type { AgentStore } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import type { inboundArrived as InboundArrivedEvent } from "../inngest/events.js";
import { logger } from "../logger.js";
import type { McpRegistry } from "../mcp/registry.js";
import type { SecretsStore } from "../secrets/store/index.js";
import type { SkillRunner } from "../skills/runner.js";
import type { SkillStore } from "../skills/store/index.js";
import type { BoundaryConfig } from "./adapter-module.js";
import { adaptersByType } from "./adapters/index.js";
import type { WebStreamRegistry } from "./adapters/web/stream-registry.js";
import type { AttachmentStore } from "./attachment-store.js";
import type { AdapterEntry } from "./delivery-router.js";
import type { TransportStore } from "./store/index.js";
import { createTransport } from "./transport.js";
import type { Adapter, StreamingAdapter } from "./types.js";

export interface RegistryDeps {
  defaultUserId: string;
  defaultProfileId: string;
  runInTx: Transactor;
  transportStore: TransportStore;
  agentStore: AgentStore;
  /** Optional — when omitted, `repos.*` returns `sandbox_disabled`. */
  codingStore?: CodingStore;
  /** Optional — when omitted, adapters skip coding-progress wiring. */
  codingStreamingRegistry?: CodingStreamingRegistry;
  inngest: Inngest;
  inboundArrived: typeof InboundArrivedEvent;
  attachments: AttachmentStore;
  idleTimeoutMs: number;
  boundary: BoundaryConfig;
  /** Resolves secret references in channel credentials before passing to adapters. */
  secretsStore: SecretsStore;
  /** Host root for git clones registered via `/repo add`. */
  reposDir?: string;
  /**
   * Skills runner — wired into `transport.skills.{approveDeploy,denyDeploy}`
   * so the Telegram approve-tier callback handler can drive the registered
   * RPCs. Optional only because some test setups skip skills wiring.
   */
  skillRunner?: SkillRunner;
  /** Skills store — paired with `skillRunner` for the Transport identity check. */
  skillStore?: SkillStore;
  /**
   * MCP registry — wired into `transport.mcp.{addServer,approveServer,…}` so
   * the `/mcp` admin commands drive the same singleton handle-message uses
   * for `resolveTools`. Production bootstrap always supplies it; the
   * optionality exists to keep test setups from having to wire a real
   * registry when they don't exercise the `transport.mcp.*` surface. When
   * absent, every `transport.mcp.*` method returns `mcp_disabled`.
   */
  mcpRegistry?: McpRegistry;
  /**
   * Sync Observer driver for `/reflect`. Production bootstrap supplies it;
   * test setups that don't exercise `transport.evolution.triggerReflection`
   * may omit, in which case the read-side methods on the same namespace
   * stay available.
   */
  triggerReflection?: (conversationId: string) => Promise<TriggerReflectionResult>;
  /**
   * SSE stream registry — threaded to the web adapter's setup. Production
   * bootstrap supplies it; setups without a web channel omit it.
   */
  webStream?: WebStreamRegistry;
}

export interface RegistryResult {
  // biome-ignore lint/suspicious/noExplicitAny: Inngest function types vary by trigger
  functions: any[];
  adapters: Array<Adapter | StreamingAdapter>;
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
  const adapters: Array<Adapter | StreamingAdapter> = [];
  const adapterMap = new Map<string, AdapterEntry>();

  const channels = await deps.runInTx((tx) => transportStore.getAllChannels(tx));

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
      runInTx: deps.runInTx,
      transportStore,
      agentStore,
      ...(deps.codingStore && { codingStore: deps.codingStore }),
      secretsStore: deps.secretsStore,
      ...(deps.reposDir && { reposDir: deps.reposDir }),
      ...(deps.skillRunner && { skillRunner: deps.skillRunner }),
      ...(deps.skillStore && { skillStore: deps.skillStore }),
      ...(deps.mcpRegistry && { mcpRegistry: deps.mcpRegistry }),
      ...(deps.triggerReflection && { triggerReflection: deps.triggerReflection }),
      inngest: deps.inngest,
      inboundArrived: deps.inboundArrived,
      attachments: deps.attachments,
      idleTimeoutMs: deps.idleTimeoutMs,
    });

    // Resolve secret references in credentials before passing to adapter.
    // Credentials like { tokenSecretName: "telegram_bot_token" } are resolved
    // to { token: "actual-token-value" } so adapters never see secret names.
    const credentials = await resolveCredentialSecrets(
      channel.credentials,
      deps.secretsStore,
      deps.runInTx,
    );

    const result = await mod.setup({
      channelId: channel.id,
      credentials,
      transport,
      attachments: deps.attachments,
      boundary: deps.boundary,
      ...(deps.codingStore &&
        deps.codingStreamingRegistry && {
          codingProgress: {
            inngest: deps.inngest,
            runInTx: deps.runInTx,
            codingStore: deps.codingStore,
            transportStore: deps.transportStore,
            streamingRegistry: deps.codingStreamingRegistry,
          },
        }),
      ...(deps.skillStore && {
        skillsApproval: {
          inngest: deps.inngest,
          runInTx: deps.runInTx,
          skillStore: deps.skillStore,
          transportStore: deps.transportStore,
        },
      }),
      ...(deps.webStream && { webStream: deps.webStream }),
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
  runInTx: Transactor,
): Promise<JsonValue> {
  if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)) {
    return credentials;
  }

  const resolved: Record<string, JsonValue> = { ...(credentials as Record<string, JsonValue>) };

  for (const [key, value] of Object.entries(resolved)) {
    if (key.endsWith("SecretName") && typeof value === "string") {
      const baseKey = key.slice(0, -"SecretName".length);
      const secret = await runInTx((tx) => secretsStore.getSecret(tx, value));
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
