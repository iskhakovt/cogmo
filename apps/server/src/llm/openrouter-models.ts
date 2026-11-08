/**
 * OpenRouter's model list (`/api/v1/models`) as a model catalog source. LiteLLM
 * publishes no `openrouter/*` keys, so OpenRouter's own list fills that
 * namespace for the live catalog and the bundled snapshot alike. The resolver
 * reaches it through `candidateKeys`, which tries `openrouter/<id>` for every
 * `<org>/<model>` id.
 *
 * The context window is the smaller of the model's and its top provider's,
 * the provider OpenRouter routes to by default. A model with no completion cap
 * gets the output budget its context window allows.
 */
import { err, ok, type Result } from "neverthrow";
import * as R from "remeda";
import { match } from "ts-pattern";
import { z } from "zod";
import {
  isOpenRouterKey,
  type LitellmCatalog,
  type LitellmEntry,
  OPENROUTER_NAMESPACE,
} from "./litellm-data.js";
import { budgetEntry, type PrunedRegistry } from "./litellm-upstream.js";

const ListSchema = z.object({ data: z.array(z.unknown()) });

const PositiveInt = z.number().int().positive();

const ModelSchema = z.object({
  id: z.string().min(1),
  context_length: PositiveInt,
  top_provider: z
    .object({
      context_length: PositiveInt.nullish(),
      max_completion_tokens: PositiveInt.nullish(),
    })
    .nullish(),
});

type PrunedModel =
  | { kind: "kept"; key: string; entry: LitellmEntry }
  | { kind: "no-token-data" }
  | { kind: "unusable" };

/** Fails only when `raw` is not a `{ data: [...] }` list; a malformed model is skipped. */
export function pruneOpenRouterModels(raw: unknown): Result<PrunedRegistry, string> {
  const list = ListSchema.safeParse(raw);
  if (!list.success) return err("the OpenRouter model list is not a { data: [...] } object");

  const pruned = list.data.data.map(pruneModel);
  const counts = R.countBy(pruned, (p) => p.kind);
  return ok({
    entries: Object.fromEntries(
      pruned.flatMap((p) => (p.kind === "kept" ? [[p.key, p.entry]] : [])),
    ),
    skippedNoTokenData: counts["no-token-data"] ?? 0,
    skippedUnusable: counts.unusable ?? 0,
  });
}

function pruneModel(value: unknown): PrunedModel {
  const model = ModelSchema.safeParse(value);
  if (!model.success) return { kind: "no-token-data" };
  const { id, context_length, top_provider } = model.data;
  const contextWindow = Math.min(context_length, top_provider?.context_length ?? context_length);
  const budget = budgetEntry(contextWindow, top_provider?.max_completion_tokens ?? contextWindow);
  return match(budget)
    .returnType<PrunedModel>()
    .with({ kind: "kept" }, ({ entry }) => ({
      kind: "kept",
      key: `${OPENROUTER_NAMESPACE}${id}`,
      entry,
    }))
    .with({ kind: "unusable" }, (unusable) => unusable)
    .exhaustive();
}

/**
 * One catalog from both sources: LiteLLM's entries outside the `openrouter/`
 * namespace, and OpenRouter's inside it.
 */
export function withOpenRouterNamespace(
  litellm: LitellmCatalog,
  openRouter: LitellmCatalog,
): Record<string, LitellmEntry> {
  return { ...R.omitBy(litellm, (_entry, key) => isOpenRouterKey(key)), ...openRouter };
}
