/**
 * Inngest wrapper for {@link refreshModelCatalog}: every six hours, and on
 * `model-catalog/refresh.requested` for an operator who wants a model that
 * shipped since the last tick.
 *
 * One step, so the body runs at most twice on a clean run and nothing outside
 * the step repeats. Installing the catalog in-process is a side effect of the
 * step body, which is what keeps it from repeating on the replay. A process
 * that didn't run the step installs the stored row at its next boot.
 */
import { type Inngest, NonRetriableError } from "inngest";
import { modelCatalogRefreshRequested } from "../../inngest/events.js";
import { logger } from "../../logger.js";
import { type RefreshModelCatalogDeps, refreshModelCatalog } from "./refresh-model-catalog.js";

const log = logger.child({ component: "model-catalog.refresh" });

/** Minute 17 keeps it off the top of the hour, where the other crons cluster. */
export const MODEL_CATALOG_REFRESH_CRON = "17 */6 * * *";

export function createModelCatalogRefresh(deps: RefreshModelCatalogDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "model-catalog-refresh",
      // Covers a network blip or a GitHub 5xx. A rejected registry throws
      // `NonRetriableError`, since refetching returns the same bytes.
      retries: 3,
      concurrency: { limit: 1 },
      triggers: [{ cron: MODEL_CATALOG_REFRESH_CRON }, modelCatalogRefreshRequested],
    },
    async ({ step }) =>
      step.run("refresh", async () => {
        const result = await refreshModelCatalog(deps);
        if (result.isErr()) {
          const { kind, message } = result.error;
          throw kind === "rejected" ? new NonRetriableError(message) : new Error(message);
        }
        log.info(result.value, "model catalog refreshed");
        return result.value;
      }),
  );
}
