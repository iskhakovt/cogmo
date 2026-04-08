import type { Inngest } from "inngest";
import type { Service } from "../agent/service.js";
import type { AgentStore } from "../agent/store/index.js";
import type { inboundArrived as InboundArrivedEvent } from "../inngest/events.js";
import { logger } from "../logger.js";
import { adaptersByType } from "./adapters/index.js";
import type { TransportStore } from "./store/index.js";
import { createTransport } from "./transport.js";
import type { Adapter, StreamingAdapter } from "./types.js";

export interface RegistryDeps {
  defaultUserId: string;
  defaultProfileId: string;
  transportStore: TransportStore;
  agentStore: AgentStore;
  inngest: Inngest;
  inboundArrived: typeof InboundArrivedEvent;
  files: Service["files"];
}

export interface RegistryResult {
  // biome-ignore lint/suspicious/noExplicitAny: Inngest function types vary by trigger
  functions: any[];
  adapters: Adapter[];
  adapterMap: Map<string, Adapter | StreamingAdapter>;
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
  const adapterMap = new Map<string, Adapter | StreamingAdapter>();

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
      files: deps.files,
    });

    const result = await mod.setup({
      channelId: channel.id,
      credentials: channel.credentials,
      transport,
    });

    adapters.push(result.adapter);
    adapterMap.set(channel.id, result.adapter);
    functions.push(...result.functions);
  }

  logger.info({ count: channels.length }, "channel adapters started");
  return { functions, adapters, adapterMap };
}
