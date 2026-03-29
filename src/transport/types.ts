import type { JsonValue } from "type-fest";
import type { Transport } from "./transport.js";

/**
 * Running adapter instance — handles platform-specific delivery.
 */
export interface Adapter {
  stop(): Promise<void>;
  deliver(platformAddress: string, content: JsonValue): Promise<void>;
}

/**
 * Factory — connect to platform, return a ready-to-use adapter.
 * The runtime calls this once per channel row in the DB.
 */
export type StartAdapter<T extends Adapter = Adapter> = (
  transport: Transport,
  credentials: JsonValue,
) => Promise<T>;
