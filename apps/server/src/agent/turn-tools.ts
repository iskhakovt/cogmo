/**
 * A turn's tool table: frozen once in a durable step, bound to live handlers
 * on every invocation. Shared by `handle-message` and the pipeline stage turn.
 *
 * The catalogs a turn's tools come from — image models, skills, sub-agents,
 * MCP servers, the profile's `toolSet` — are live reads in the bare body, which
 * Inngest re-runs at every step boundary, so a later invocation of the same
 * turn can load a different list. The frozen table decides what the model is
 * offered and how the loop dispatches each call, so every request of the turn
 * carries the same `tools` and every invocation plans the same steps. The live
 * build only supplies handlers.
 */

import * as R from "remeda";
import { z } from "zod";
import type { JsonSchema } from "../llm/types.js";
import { type ToolHandler, ToolRegistry } from "./tools.js";

function isObjectJsonSchema(value: unknown): value is JsonSchema {
  return R.isPlainObject(value) && value.type === "object";
}

/**
 * The data half of a `ToolSpec`: the definition sent to the provider and
 * the policy the loop dispatches on (durability, grouping, the Class D flags).
 */
const FrozenToolSpecSchema = z.object({
  name: z.string(),
  description: z.string(),
  // Checked, not rebuilt: its key order is what the provider sees.
  inputSchema: z.custom<JsonSchema>(isObjectJsonSchema),
  durable: z.boolean().exactOptional(),
  parallelSafe: z.boolean().exactOptional(),
  sideEffectful: z.boolean().exactOptional(),
  invocationBudget: z.number().int().positive().exactOptional(),
});

const FROZEN_KEYS = FrozenToolSpecSchema.keyof().options;

/**
 * The tool table as the step returns it: JSON text. The Inngest server
 * re-encodes memoized step output with object keys sorted at every depth, so
 * an object would come back with every schema reordered, and the invocation
 * that ran the step would send different `tools` bytes from every later one.
 * A string comes back as it went in.
 */
export function freezeToolTable(registry: ToolRegistry): string {
  return JSON.stringify(registry.snapshot().map((spec) => R.pick(spec, FROZEN_KEYS)));
}

/**
 * The registry the turn runs on: the frozen specs, in frozen order, each with
 * its handler from `live`. Every invocation, the one that ran the step
 * included, parses the same `table`, so each builds identical definitions.
 *
 * A frozen tool missing from `live` keeps its definition and policy and gets a
 * handler that throws, which the loop reports as an `is_error` result. A
 * durable one whose step already ran replays that result and never reaches the
 * handler. A live tool the turn didn't freeze is not offered.
 */
export function bindFrozenTools(table: string, live: ToolRegistry): ToolRegistry {
  const registry = new ToolRegistry();
  for (const spec of z.array(FrozenToolSpecSchema).parse(JSON.parse(table))) {
    const liveSpec = live.get(spec.name);
    registry.register({
      ...spec,
      handler: liveSpec?.handler ?? unavailable(spec.name),
      ...(liveSpec?.normalizeInput !== undefined && { normalizeInput: liveSpec.normalizeInput }),
    });
  }
  return registry;
}

function unavailable(name: string): ToolHandler {
  return async () => {
    throw new Error(`the ${name} tool could not be loaded, so it did not run`);
  };
}
