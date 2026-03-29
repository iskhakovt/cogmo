import type { JsonValue } from "type-fest";
import type { Transport } from "./transport.js";
import type { Adapter } from "./types.js";

/**
 * Dependencies available to adapter setup.
 */
export interface AdapterDeps {
  channelId: string;
  credentials: JsonValue;
  transport: Transport;
}

/**
 * Result of setting up an adapter for a channel.
 */
export interface AdapterSetupResult {
  /** Running adapter instance (deliver + stop). */
  adapter: Adapter;
  /** Inngest functions the adapter needs registered (e.g., event-driven inbound). */
  // biome-ignore lint/suspicious/noExplicitAny: Inngest function types vary by trigger
  functions: any[];
}

/**
 * Contract every adapter module must satisfy.
 *
 * The barrel (adapters/index.ts) enforces this via `satisfies`.
 * The registry uses channelType to match DB rows to adapter setup.
 */
export interface AdapterModule {
  channelType: string;
  setup: (deps: AdapterDeps) => Promise<AdapterSetupResult>;
}
