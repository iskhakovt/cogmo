import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { bundledSnapshot, type LitellmCatalog, type LiveCatalog } from "../../llm/litellm-data.js";
import { fakeRunInTx } from "../../test/factories.js";
import { type RefreshModelCatalogDeps, refreshModelCatalog } from "./refresh-model-catalog.js";
import type { ModelCatalogStore } from "./store/index.js";

const URL = "https://registry.test/models.json";
const FETCHED_AT = new Date("2026-09-28T06:17:00.000Z");

/** An upstream registry: every bundled id, plus `extra` ids. */
function upstream(extra: ReadonlyArray<string> = []): Record<string, unknown> {
  const ids = [...Object.keys(bundledSnapshot()), ...extra];
  return Object.fromEntries(
    ids.map((id) => [id, { max_input_tokens: 200_000, max_output_tokens: 8_192 }]),
  );
}

function makeDeps(
  opts: { response?: Response | Error; previous?: LitellmCatalog | null } = {},
): RefreshModelCatalogDeps & {
  store: ReturnType<typeof mock<ModelCatalogStore>>;
  installed: LiveCatalog[];
} {
  const store = mock<ModelCatalogStore>();
  store.latest.mockResolvedValue(
    opts.previous ? { id: "old", entries: opts.previous, createdAt: new Date(0) } : null,
  );
  store.replace.mockResolvedValue({ id: "new", createdAt: FETCHED_AT });
  const installed: LiveCatalog[] = [];
  const response = opts.response ?? Response.json(upstream());
  return {
    runInTx: fakeRunInTx,
    modelCatalogStore: store,
    url: URL,
    fetch: vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    }),
    installCatalog: (catalog) => installed.push(catalog),
    store,
    installed,
  };
}

describe("refreshModelCatalog", () => {
  it("stores the pruned registry, installs it, and reports its size", async () => {
    const deps = makeDeps({ response: Response.json(upstream(["claude-next-6"])) });

    const result = (await refreshModelCatalog(deps))._unsafeUnwrap();

    const models = Object.keys(bundledSnapshot()).length + 1;
    expect(result.models).toBe(models);
    expect(result.fetchedAt).toBe(FETCHED_AT.toISOString());
    expect(deps.fetch).toHaveBeenCalledWith(URL, expect.anything());
    const stored = deps.store.replace.mock.calls[0]?.[1];
    expect(stored?.["claude-next-6"]).toEqual({ contextWindow: 200_000, maxOutputTokens: 8_192 });
    expect(deps.installed).toEqual([{ entries: stored, fetchedAt: FETCHED_AT }]);
  });

  it("names ids the bundled snapshot lacks on the first refresh", async () => {
    const deps = makeDeps({ response: Response.json(upstream(["claude-next-6", "a-new-model"])) });

    const result = (await refreshModelCatalog(deps))._unsafeUnwrap();

    expect(result.added).toEqual(["a-new-model", "claude-next-6"]);
    expect(result.addedCount).toBe(2);
  });

  it("names ids the previous catalog lacked on later refreshes", async () => {
    const previous = Object.fromEntries(
      [...Object.keys(bundledSnapshot()), "claude-next-6"].map((id) => [
        id,
        { contextWindow: 200_000, maxOutputTokens: 8_192 },
      ]),
    );
    const deps = makeDeps({
      response: Response.json(upstream(["claude-next-6", "claude-next-7"])),
      previous,
    });

    const result = (await refreshModelCatalog(deps))._unsafeUnwrap();

    expect(result.added).toEqual(["claude-next-7"]);
  });

  it("caps the named ids and counts the rest", async () => {
    const extra = Array.from({ length: 25 }, (_, i) => `new-model-${String(i).padStart(2, "0")}`);
    const deps = makeDeps({ response: Response.json(upstream(extra)) });

    const result = (await refreshModelCatalog(deps))._unsafeUnwrap();

    expect(result.added).toHaveLength(20);
    expect(result.addedCount).toBe(25);
  });

  it.each([
    ["a non-2xx status", new Response("rate limited", { status: 429 }), /returned 429/],
    ["a network failure", new Error("ECONNRESET"), /ECONNRESET/],
    ["a body that isn't JSON", new Response("<html>", { status: 200 }), /fetching/],
  ])(
    "reports %s as unavailable and keeps the stored catalog",
    async (_label, response, message) => {
      const deps = makeDeps({ response });

      const error = (await refreshModelCatalog(deps))._unsafeUnwrapErr();

      expect(error.kind).toBe("unavailable");
      expect(error.message).toMatch(message);
      expect(deps.store.replace).not.toHaveBeenCalled();
      expect(deps.installed).toEqual([]);
    },
  );

  it("rejects a registry that isn't an object", async () => {
    const deps = makeDeps({ response: Response.json([1, 2, 3]) });

    const error = (await refreshModelCatalog(deps))._unsafeUnwrapErr();

    expect(error.kind).toBe("rejected");
    expect(deps.store.replace).not.toHaveBeenCalled();
  });

  it("rejects a registry with under half the bundled snapshot's entries", async () => {
    const half = Object.keys(bundledSnapshot()).slice(0, 100);
    const small = Object.fromEntries(
      half.map((id) => [id, { max_input_tokens: 200_000, max_output_tokens: 8_192 }]),
    );
    const deps = makeDeps({ response: Response.json(small) });

    const error = (await refreshModelCatalog(deps))._unsafeUnwrapErr();

    expect(error).toMatchObject({ kind: "rejected", message: expect.stringMatching(/only 100/) });
    expect(deps.store.replace).not.toHaveBeenCalled();
    expect(deps.installed).toEqual([]);
  });
});
