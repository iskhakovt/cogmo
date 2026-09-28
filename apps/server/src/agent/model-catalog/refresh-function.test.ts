/**
 * The Inngest wiring around `refreshModelCatalog`: its triggers, and which
 * failures burn retries. `refresh-model-catalog.test.ts` pins the use case.
 */
import { InngestTestEngine } from "@inngest/test";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { inngest } from "../../inngest/client.js";
import { bundledSnapshot } from "../../llm/litellm-data.js";
import { fakeRunInTx } from "../../test/factories.js";
import { createModelCatalogRefresh, MODEL_CATALOG_REFRESH_CRON } from "./refresh-function.js";
import type { ModelCatalogStore } from "./store/index.js";

const FETCHED_AT = new Date("2026-09-28T06:17:00.000Z");
const requested = { name: "model-catalog/refresh.requested", data: {} } as const;

function makeFn(response: Response) {
  const store = mock<ModelCatalogStore>();
  store.latest.mockResolvedValue(null);
  store.replace.mockResolvedValue({ id: "new", createdAt: FETCHED_AT });
  const installCatalog = vi.fn();
  const fn = createModelCatalogRefresh(
    {
      runInTx: fakeRunInTx,
      modelCatalogStore: store,
      url: "https://registry.test/models.json",
      fetch: vi.fn(async () => response),
      installCatalog,
    },
    inngest,
  );
  return { fn, store, installCatalog };
}

function registry(): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(bundledSnapshot()).map((id) => [
      id,
      { max_input_tokens: 200_000, max_output_tokens: 8_192 },
    ]),
  );
}

describe("createModelCatalogRefresh", () => {
  it("runs on its cron and on an operator's request", () => {
    const { fn } = makeFn(Response.json(registry()));
    expect(fn.opts.triggers).toEqual([
      { cron: MODEL_CATALOG_REFRESH_CRON },
      expect.objectContaining({ event: "model-catalog/refresh.requested" }),
    ]);
  });

  it("returns the refresh summary and installs the catalog", async () => {
    const { fn, installCatalog } = makeFn(Response.json(registry()));

    const { result } = await new InngestTestEngine({ function: fn, events: [requested] }).execute();

    expect(result).toMatchObject({
      models: Object.keys(bundledSnapshot()).length,
      fetchedAt: FETCHED_AT.toISOString(),
      addedCount: 0,
    });
    expect(installCatalog).toHaveBeenCalledTimes(1);
  });

  it("fails retriably when upstream is unavailable", async () => {
    const { fn, store } = makeFn(new Response("bad gateway", { status: 502 }));

    const { error } = await new InngestTestEngine({ function: fn, events: [requested] }).execute();

    // The engine hands back the serialized error, so its class shows as `name`.
    expect(error).toMatchObject({ name: "Error", message: expect.stringMatching(/returned 502/) });
    expect(store.replace).not.toHaveBeenCalled();
  });

  it("fails without retrying when upstream sends an unusable registry", async () => {
    const { fn, store } = makeFn(Response.json({}));

    const { error } = await new InngestTestEngine({ function: fn, events: [requested] }).execute();

    expect(error).toMatchObject({ name: "NonRetriableError" });
    expect(store.replace).not.toHaveBeenCalled();
  });
});
