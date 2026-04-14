import type { AdapterModule } from "../adapter-module.js";
import direct from "./direct.js";
import { telegramModule } from "./telegram/index.js";

/**
 * Adapter module registry — compile-time enforced via satisfies.
 *
 * Add an adapter: create the file, add an import + entry here.
 * Forget channelType or setup → compile error.
 */
export const adapterModules: ReadonlyArray<AdapterModule> = [
  direct satisfies AdapterModule,
  telegramModule satisfies AdapterModule,
];

/** Lookup by channel type. */
export const adaptersByType = new Map(adapterModules.map((m) => [m.channelType, m]));
