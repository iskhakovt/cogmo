/**
 * The Inngest wiring around the catalog refresh: its triggers, and which
 * failures burn retries. `refresh-model-catalog.test.ts` pins the use case.
 */
import { InngestTestEngine } from "@inngest/test";
import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { inngest } from "../../inngest/client.js";
import { createModelCatalogRefresh, MODEL_CATALOG_REFRESH_CRON } from "./refresh-function.js";
import type { ModelCatalogRefreshed } from "./refresh-model-catalog.js";

const requested = { name: "model-catalog/refresh.requested", data: {} } as const;

const refreshed: ModelCatalogRefreshed = {
  models: 3_180,
  fetchedAt: "2026-09-28T06:17:00.000Z",
  added: ["claude-sonnet-5-5"],
  addedCount: 1,
};

describe("createModelCatalogRefresh", () => {
  it("runs on its cron and on an operator's request", () => {
    const fn = createModelCatalogRefresh(async () => ok(refreshed), inngest);
    expect(fn.opts.triggers).toEqual([
      { cron: MODEL_CATALOG_REFRESH_CRON },
      expect.objectContaining({ event: "model-catalog/refresh.requested" }),
    ]);
  });

  it("runs the refresh once and returns its summary", async () => {
    const refresh = vi.fn(async () => ok(refreshed));
    const fn = createModelCatalogRefresh(refresh, inngest);

    const { result } = await new InngestTestEngine({ function: fn, events: [requested] }).execute();

    expect(result).toEqual(refreshed);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("fails retriably when upstream is unavailable", async () => {
    const fn = createModelCatalogRefresh(
      async () => err({ kind: "unavailable", message: "https://registry.test returned 502" }),
      inngest,
    );

    const { error } = await new InngestTestEngine({ function: fn, events: [requested] }).execute();

    // The engine hands back the serialized error, so its class shows as `name`.
    expect(error).toMatchObject({ name: "Error", message: "https://registry.test returned 502" });
  });

  it("fails without retrying when upstream sends an unusable registry", async () => {
    const fn = createModelCatalogRefresh(
      async () => err({ kind: "rejected", message: "the LiteLLM registry is not a JSON object" }),
      inngest,
    );

    const { error } = await new InngestTestEngine({ function: fn, events: [requested] }).execute();

    expect(error).toMatchObject({ name: "NonRetriableError" });
  });
});
