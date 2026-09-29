/**
 * Refresh the live model catalog from LiteLLM's upstream registry: fetch,
 * prune to the resolver's two fields, store as the newest `model_catalogs`
 * row, and install it in this process. A model upstream learns about reaches
 * the resolver at the next refresh, with no release in between.
 */
import { err, ok, type Result } from "neverthrow";
import type { Transactor } from "../../db/index.js";
import type { LitellmCatalog, LiveCatalog } from "../../llm/litellm-data.js";
import { pruneLitellmRegistry } from "../../llm/litellm-upstream.js";
import { describeError } from "../../util/describe-error.js";
import type { ModelCatalogStore } from "./store/index.js";

/** The upstream file is a few MB; this bounds a stalled connection. */
const FETCH_TIMEOUT_MS = 60_000;

/** How many new ids the result names. The count covers the rest. */
const ADDED_SAMPLE = 20;

export interface RefreshModelCatalogDeps {
  runInTx: Transactor;
  modelCatalogStore: ModelCatalogStore;
  /** Where LiteLLM's registry is fetched from. */
  url: string;
  fetch: typeof globalThis.fetch;
  installCatalog: (catalog: LiveCatalog) => void;
  /** The snapshot shipped with the release: the size floor, and the baseline for `added` before the first refresh. */
  bundled: LitellmCatalog;
}

/** JSON-serializable: it is an Inngest step result. */
export interface ModelCatalogRefreshed {
  models: number;
  fetchedAt: string;
  /** The first ids, sorted, that the previous catalog lacked. */
  added: string[];
  addedCount: number;
}

export type ModelCatalogRefreshError =
  /** The fetch failed or returned no JSON; a later attempt may succeed. */
  | { kind: "unavailable"; message: string }
  /** The registry arrived but is unusable; refetching returns the same bytes. */
  | { kind: "rejected"; message: string };

export async function refreshModelCatalog(
  deps: RefreshModelCatalogDeps,
): Promise<Result<ModelCatalogRefreshed, ModelCatalogRefreshError>> {
  const source = withoutQuery(deps.url);
  let raw: unknown;
  try {
    const res = await deps.fetch(deps.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel();
      return err({ kind: "unavailable", message: `${source} returned ${res.status}` });
    }
    raw = await res.json();
  } catch (e) {
    return err({ kind: "unavailable", message: `fetching ${source}: ${describeError(e)}` });
  }

  const pruned = pruneLitellmRegistry(raw);
  if (pruned.isErr()) return err({ kind: "rejected", message: pruned.error });
  const { entries } = pruned.value;

  // A truncated or reshaped upstream would still parse, and would replace a
  // good catalog with a sliver of one. The bundled snapshot still answers for
  // anything missing, but a live catalog that small has stopped tracking
  // upstream.
  const models = Object.keys(entries).length;
  const floor = Math.ceil(Object.keys(deps.bundled).length / 2);
  if (models < floor) {
    return err({
      kind: "rejected",
      message: `only ${models} usable entries, under the floor of ${floor} (half the bundled snapshot)`,
    });
  }

  const { previousIds, stored } = await deps.runInTx(async (tx) => ({
    previousIds: await deps.modelCatalogStore.latestModelIds(tx),
    stored: await deps.modelCatalogStore.replace(tx, entries),
  }));
  deps.installCatalog({ entries, fetchedAt: stored.createdAt });

  const baseline = new Set(previousIds ?? Object.keys(deps.bundled));
  const added = Object.keys(entries)
    .filter((id) => !baseline.has(id))
    .sort();
  return ok({
    models,
    fetchedAt: stored.createdAt.toISOString(),
    added: added.slice(0, ADDED_SAMPLE),
    addedCount: added.length,
  });
}

/** The URL minus any query string, which is where a mirror's token would sit. */
function withoutQuery(url: string): string {
  const { origin, pathname } = new URL(url);
  return `${origin}${pathname}`;
}
