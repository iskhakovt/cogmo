import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { z } from "zod";
import type { LiveCatalog } from "../../llm/litellm-data.js";
import { fakeRunInTx } from "../../test/factories.js";
import { loadModelCatalog } from "./load-model-catalog.js";
import type { ModelCatalogStore } from "./store/index.js";

function setup() {
  const store = mock<ModelCatalogStore>();
  const installed: LiveCatalog[] = [];
  const deps = {
    runInTx: fakeRunInTx,
    modelCatalogStore: store,
    installCatalog: (catalog: LiveCatalog) => installed.push(catalog),
  };
  return { deps, store, installed };
}

describe("loadModelCatalog", () => {
  it("installs the stored catalog with its fetch time", async () => {
    const { deps, store, installed } = setup();
    const entries = { "claude-sonnet-5-5": { contextWindow: 1_000_000, maxOutputTokens: 64_000 } };
    const createdAt = new Date("2026-09-28T06:17:00.000Z");
    store.latest.mockResolvedValue({ id: "c1", entries, createdAt });

    await loadModelCatalog(deps);

    expect(installed).toEqual([{ entries, fetchedAt: createdAt }]);
  });

  it("installs nothing before the first refresh", async () => {
    const { deps, store, installed } = setup();
    store.latest.mockResolvedValue(null);

    await loadModelCatalog(deps);

    expect(installed).toEqual([]);
  });

  it("boots on the bundled snapshot when the stored catalog no longer parses", async () => {
    const { deps, store, installed } = setup();
    store.latest.mockRejectedValue(new z.ZodError([]));

    await expect(loadModelCatalog(deps)).resolves.toBeUndefined();
    expect(installed).toEqual([]);
  });

  it("propagates any other failure", async () => {
    const { deps, store } = setup();
    store.latest.mockRejectedValue(new Error("connection refused"));

    await expect(loadModelCatalog(deps)).rejects.toThrow("connection refused");
  });
});
