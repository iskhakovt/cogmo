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
import { type ToolHandler, ToolRegistry, type ToolSpec } from "./tools.js";

const FROZEN_KEYS = [
  "name",
  "description",
  "inputSchema",
  "durable",
  "parallelSafe",
  "sideEffectful",
  "invocationBudget",
] as const;

/**
 * The data half of a {@link ToolSpec}: the definition sent to the provider and
 * the policy the loop dispatches on (durability, grouping, the Class D flags).
 * JSON-serializable, so it can be a step result.
 */
export type FrozenToolSpec = Pick<ToolSpec, (typeof FROZEN_KEYS)[number]>;

export function freezeToolSpecs(registry: ToolRegistry): FrozenToolSpec[] {
  return registry.snapshot().map((spec) => R.pick(spec, FROZEN_KEYS));
}

/**
 * The registry the turn runs on: the frozen specs, in frozen order, each with
 * its handler from `live`. A frozen tool missing from `live` keeps its
 * definition and policy, and its handler throws, which the loop reports as an
 * `is_error` tool result — or, for a durable tool whose step already ran,
 * never reaches, since the step replays its result. A live tool the turn
 * didn't freeze is not offered.
 */
export function bindFrozenTools(
  frozen: ReadonlyArray<FrozenToolSpec>,
  live: ToolRegistry,
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const spec of frozen) {
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
