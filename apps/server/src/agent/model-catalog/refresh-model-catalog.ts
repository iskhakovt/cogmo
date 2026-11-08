/**
 * Refresh the live model catalog from its sources: fetch LiteLLM's registry and
 * OpenRouter's model list, prune each to the resolver's two fields, store the
 * union as the newest `model_catalogs` row, and install it in this process.
 * OpenRouter supplies the `openrouter/*` namespace, LiteLLM everything else. A
 * model either source learns about reaches the resolver at the next refresh,
 * with no release in between.
 *
 * LiteLLM's registry is required: when it fails, nothing is stored. OpenRouter's
 * list is not: when it fails, the refresh stores LiteLLM's entries with the
 * previous catalog's `openrouter/*` entries carried forward, so a failed list
 * leaves that namespace one refresh stale rather than empty. When it is off, the
 * catalog holds no `openrouter/*` entries.
 */
import { err, ok, type Result } from "neverthrow";
import * as R from "remeda";
import { z } from "zod";
import type { Transaction, Transactor } from "../../db/index.js";
import {
  isOpenRouterKey,
  type LitellmCatalog,
  type LitellmEntry,
  type LiveCatalog,
} from "../../llm/litellm-data.js";
import { type PrunedRegistry, pruneLitellmRegistry } from "../../llm/litellm-upstream.js";
import { pruneOpenRouterModels, withOpenRouterNamespace } from "../../llm/openrouter-models.js";
import { describeError } from "../../util/describe-error.js";
import type { ModelCatalogStore } from "./store/index.js";

/** LiteLLM's registry is a few MB; this bounds a stalled connection. */
export const FETCH_TIMEOUT_MS = 60_000;

/** How many new ids the result names. The count covers the rest. */
const ADDED_SAMPLE = 20;

export interface RefreshModelCatalogDeps {
  runInTx: Transactor;
  modelCatalogStore: ModelCatalogStore;
  /** Where LiteLLM's registry is fetched from. */
  url: string;
  /** Where OpenRouter's model list is fetched from; `null` refreshes LiteLLM's registry alone. */
  openRouterUrl: string | null;
  fetch: typeof globalThis.fetch;
  installCatalog: (catalog: LiveCatalog) => void;
  /** The snapshot shipped with the release: each source's size floor, and the baseline for `added` before the first refresh. */
  bundled: LitellmCatalog;
}

/** JSON-serializable: it is an Inngest step result. */
export interface ModelCatalogRefreshed {
  models: number;
  fetchedAt: string;
  /** The first ids, sorted, that the previous catalog lacked. */
  added: string[];
  addedCount: number;
  openRouter: OpenRouterOutcome;
}

/** What became of OpenRouter's model list in a refresh that stored a catalog. */
export type OpenRouterOutcome =
  | { kind: "off" }
  | { kind: "refreshed"; models: number }
  /** The previous catalog's `openrouter/*` entries, `carried` of them, stand in for the list. */
  | { kind: "failed"; error: ModelCatalogRefreshError; carried: number };

export type ModelCatalogRefreshError =
  /** A source's fetch failed or returned no JSON; a later attempt may succeed. */
  | { kind: "unavailable"; message: string }
  /** A source arrived but is unusable; refetching returns the same bytes. */
  | { kind: "rejected"; message: string };

export async function refreshModelCatalog(
  deps: RefreshModelCatalogDeps,
): Promise<Result<ModelCatalogRefreshed, ModelCatalogRefreshError>> {
  const [litellmRaw, openRouterRaw] = await Promise.all([
    fetchJson(deps.fetch, deps.url),
    deps.openRouterUrl === null ? null : fetchJson(deps.fetch, deps.openRouterUrl),
  ]);
  if (litellmRaw.isErr()) return err(litellmRaw.error);

  const litellm = pruneLitellmRegistry(litellmRaw.value);
  if (litellm.isErr()) return err({ kind: "rejected", message: litellm.error });
  const litellmFloor = belowFloor(
    "usable entries",
    litellm.value,
    deps.bundled,
    (key) => !isOpenRouterKey(key),
  );
  if (litellmFloor) return err({ kind: "rejected", message: litellmFloor });

  const openRouter = openRouterRaw === null ? null : openRouterEntries(openRouterRaw, deps.bundled);

  const { previousIds, stored, entries, carried } = await deps.runInTx(async (tx) => {
    const carried = openRouter?.isErr()
      ? await previousOpenRouterEntries(deps.modelCatalogStore, tx)
      : {};
    const entries = withOpenRouterNamespace(
      litellm.value.entries,
      openRouter?.unwrapOr(carried) ?? {},
    );
    return {
      previousIds: await deps.modelCatalogStore.latestModelIds(tx),
      stored: await deps.modelCatalogStore.replace(tx, entries),
      entries,
      carried: Object.keys(carried).length,
    };
  });
  deps.installCatalog({ entries, fetchedAt: stored.createdAt });

  const baseline = new Set(previousIds ?? Object.keys(deps.bundled));
  const added = Object.keys(entries)
    .filter((id) => !baseline.has(id))
    .sort();
  return ok({
    models: Object.keys(entries).length,
    fetchedAt: stored.createdAt.toISOString(),
    added: added.slice(0, ADDED_SAMPLE),
    addedCount: added.length,
    openRouter:
      openRouter === null
        ? { kind: "off" }
        : openRouter.match(
            (models) => ({ kind: "refreshed", models: Object.keys(models).length }),
            (error) => ({ kind: "failed", error, carried }),
          ),
  });
}

/**
 * The newest stored catalog's `openrouter/*` entries. A row an older
 * `LitellmCatalogSchema` wrote carries nothing; the bundled snapshot answers
 * for those ids until OpenRouter's list is back.
 */
async function previousOpenRouterEntries(
  store: ModelCatalogStore,
  tx: Transaction,
): Promise<Record<string, LitellmEntry>> {
  try {
    const previous = await store.latest(tx);
    return previous ? R.pickBy(previous.entries, (_entry, key) => isOpenRouterKey(key)) : {};
  } catch (e) {
    if (e instanceof z.ZodError) return {};
    throw e;
  }
}

/** OpenRouter's list pruned to the `openrouter/` namespace, held to its floor. */
function openRouterEntries(
  raw: Result<unknown, ModelCatalogRefreshError>,
  bundled: LitellmCatalog,
): Result<Record<string, LitellmEntry>, ModelCatalogRefreshError> {
  return raw.andThen((value): Result<Record<string, LitellmEntry>, ModelCatalogRefreshError> => {
    const pruned = pruneOpenRouterModels(value);
    if (pruned.isErr()) return err({ kind: "rejected", message: pruned.error });
    const floor = belowFloor("usable OpenRouter models", pruned.value, bundled, isOpenRouterKey);
    return floor ? err({ kind: "rejected", message: floor }) : ok(pruned.value.entries);
  });
}

export async function fetchJson(
  fetch: typeof globalThis.fetch,
  url: string,
): Promise<Result<unknown, ModelCatalogRefreshError>> {
  const source = withoutQuery(url);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel();
      return err({ kind: "unavailable", message: `${source} returned ${res.status}` });
    }
    return ok(await res.json());
  } catch (e) {
    return err({ kind: "unavailable", message: `fetching ${source}: ${describeError(e)}` });
  }
}

/**
 * Why a source's pruned entries are too few to replace a good catalog, or
 * `null` when they are enough. A truncated or reshaped upstream would still
 * parse, and would replace a good catalog with a sliver of one. The bundled
 * snapshot still answers for anything missing, but a live catalog that small
 * has stopped tracking upstream. The floor is half the bundled snapshot's
 * entries in the source's namespace, and at least one.
 */
export function belowFloor(
  what: string,
  pruned: PrunedRegistry,
  bundled: LitellmCatalog,
  inNamespace: (key: string) => boolean,
): string | null {
  const count = Object.keys(pruned.entries).filter(inNamespace).length;
  const floor = Math.max(1, Math.ceil(Object.keys(bundled).filter(inNamespace).length / 2));
  return count < floor
    ? `only ${count} ${what}, under the floor of ${floor} (half the bundled snapshot)`
    : null;
}

/** The URL minus any query string, which is where a mirror's token would sit. */
function withoutQuery(url: string): string {
  const { origin, pathname } = new URL(url);
  return `${origin}${pathname}`;
}
