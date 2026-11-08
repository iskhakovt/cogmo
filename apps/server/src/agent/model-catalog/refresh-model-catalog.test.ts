import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { z } from "zod";
import type { LitellmCatalog, LiveCatalog } from "../../llm/litellm-data.js";
import { fakeRunInTx } from "../../test/factories.js";
import { type RefreshModelCatalogDeps, refreshModelCatalog } from "./refresh-model-catalog.js";
import type { ModelCatalogStore } from "./store/index.js";

const URL = "https://registry.test/models.json";
const OPENROUTER_URL = "https://openrouter.test/api/v1/models";
const FETCHED_AT = new Date("2026-09-28T06:17:00.000Z");
const LIMITS = { contextWindow: 200_000, maxOutputTokens: 8_192 };

/** A four-model bundled snapshot, so the refresh's floor is two entries. */
const BUNDLED: LitellmCatalog = Object.fromEntries(
  ["model-a", "model-b", "model-c", "model-d"].map((id) => [id, LIMITS]),
);

/** An upstream registry holding `ids`. */
function upstream(ids: ReadonlyArray<string>): Record<string, unknown> {
  return Object.fromEntries(
    ids.map((id) => [id, { max_input_tokens: 200_000, max_output_tokens: 8_192 }]),
  );
}

/** An OpenRouter model list holding `ids`, each served with {@link LIMITS}. */
function openRouterList(ids: ReadonlyArray<string>): Record<string, unknown> {
  return {
    data: ids.map((id) => ({
      id,
      context_length: 200_000,
      top_provider: { context_length: 200_000, max_completion_tokens: 8_192 },
    })),
  };
}

function makeDeps(
  opts: {
    response?: Response | Error;
    openRouter?: Response | Error | null;
    previousIds?: string[] | null;
    previous?: LitellmCatalog | Error;
    url?: string;
    bundled?: LitellmCatalog;
  } = {},
): RefreshModelCatalogDeps & {
  store: ReturnType<typeof mock<ModelCatalogStore>>;
  installed: LiveCatalog[];
} {
  const store = mock<ModelCatalogStore>();
  store.latestModelIds.mockResolvedValue(opts.previousIds ?? null);
  if (opts.previous instanceof Error) store.latest.mockRejectedValue(opts.previous);
  else
    store.latest.mockResolvedValue(
      opts.previous ? { id: "old", entries: opts.previous, createdAt: FETCHED_AT } : null,
    );
  store.replace.mockResolvedValue({ id: "new", createdAt: FETCHED_AT });
  const installed: LiveCatalog[] = [];
  const bundled = opts.bundled ?? BUNDLED;
  const url = opts.url ?? URL;
  const responses = new Map<string, Response | Error>([
    [url, opts.response ?? Response.json(upstream(Object.keys(bundled)))],
  ]);
  if (opts.openRouter) responses.set(OPENROUTER_URL, opts.openRouter);
  return {
    runInTx: fakeRunInTx,
    modelCatalogStore: store,
    url,
    openRouterUrl: opts.openRouter ? OPENROUTER_URL : null,
    fetch: vi.fn(async (input: string | URL | Request) => {
      const response = responses.get(String(input));
      if (response === undefined) throw new Error(`unexpected fetch of ${String(input)}`);
      if (response instanceof Error) throw response;
      return response;
    }),
    installCatalog: (catalog) => installed.push(catalog),
    bundled,
    store,
    installed,
  };
}

describe("refreshModelCatalog", () => {
  it("stores the pruned registry, installs it, and reports its size", async () => {
    const deps = makeDeps({ response: Response.json(upstream(["model-a", "model-b", "next"])) });

    const result = (await refreshModelCatalog(deps))._unsafeUnwrap();

    expect(result.models).toBe(3);
    expect(result.fetchedAt).toBe(FETCHED_AT.toISOString());
    expect(deps.fetch).toHaveBeenCalledWith(URL, expect.anything());
    const stored = deps.store.replace.mock.calls[0]?.[1];
    expect(stored).toEqual({ "model-a": LIMITS, "model-b": LIMITS, next: LIMITS });
    expect(deps.installed).toEqual([{ entries: stored, fetchedAt: FETCHED_AT }]);
  });

  it("names ids the bundled snapshot lacks on the first refresh", async () => {
    const deps = makeDeps({
      response: Response.json(upstream([...Object.keys(BUNDLED), "next", "a-new-model"])),
    });

    const result = (await refreshModelCatalog(deps))._unsafeUnwrap();

    expect(result.added).toEqual(["a-new-model", "next"]);
    expect(result.addedCount).toBe(2);
  });

  it("names ids the previous catalog lacked on later refreshes", async () => {
    const deps = makeDeps({
      response: Response.json(upstream([...Object.keys(BUNDLED), "next", "after-next"])),
      previousIds: [...Object.keys(BUNDLED), "next"],
    });

    const result = (await refreshModelCatalog(deps))._unsafeUnwrap();

    expect(result.added).toEqual(["after-next"]);
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

  it("leaves the URL's query string, where a mirror's token would sit, out of its errors", async () => {
    const deps = makeDeps({
      url: "https://mirror.test/models.json?token=s3cret",
      response: new Response("nope", { status: 403 }),
    });

    const error = (await refreshModelCatalog(deps))._unsafeUnwrapErr();

    expect(error.message).toBe("https://mirror.test/models.json returned 403");
  });

  it("rejects a registry that isn't an object", async () => {
    const deps = makeDeps({ response: Response.json([1, 2, 3]) });

    const error = (await refreshModelCatalog(deps))._unsafeUnwrapErr();

    expect(error.kind).toBe("rejected");
    expect(deps.store.replace).not.toHaveBeenCalled();
  });

  it("rejects a registry with under half the bundled snapshot's entries", async () => {
    const deps = makeDeps({ response: Response.json(upstream(["model-a"])) });

    const error = (await refreshModelCatalog(deps))._unsafeUnwrapErr();

    expect(error).toMatchObject({ kind: "rejected", message: expect.stringMatching(/only 1 /) });
    expect(deps.store.replace).not.toHaveBeenCalled();
    expect(deps.installed).toEqual([]);
  });

  describe("with OpenRouter's model list", () => {
    it("fills the openrouter/ namespace from it and LiteLLM's registry fills the rest", async () => {
      const deps = makeDeps({
        response: Response.json(upstream([...Object.keys(BUNDLED), "openrouter/retired/model"])),
        openRouter: Response.json({
          data: [
            {
              id: "x-ai/grok-9",
              context_length: 256_000,
              top_provider: { context_length: 200_000, max_completion_tokens: 16_000 },
            },
          ],
        }),
      });

      const result = (await refreshModelCatalog(deps))._unsafeUnwrap();

      expect(deps.fetch).toHaveBeenCalledWith(URL, expect.anything());
      expect(deps.fetch).toHaveBeenCalledWith(OPENROUTER_URL, expect.anything());
      const stored = deps.store.replace.mock.calls[0]?.[1];
      expect(stored).toEqual({
        ...BUNDLED,
        "openrouter/x-ai/grok-9": { contextWindow: 200_000, maxOutputTokens: 16_000 },
      });
      expect(deps.installed).toEqual([{ entries: stored, fetchedAt: FETCHED_AT }]);
      expect(result).toMatchObject({
        models: 5,
        added: ["openrouter/x-ai/grok-9"],
        openRouter: { kind: "refreshed", models: 1 },
      });
    });

    it("stores no openrouter/ entries when the source is off", async () => {
      const deps = makeDeps({
        response: Response.json(upstream([...Object.keys(BUNDLED), "openrouter/legacy/model"])),
      });

      const result = (await refreshModelCatalog(deps))._unsafeUnwrap();

      expect(deps.fetch).toHaveBeenCalledTimes(1);
      expect(deps.store.replace.mock.calls[0]?.[1]).toEqual(BUNDLED);
      expect(result.openRouter).toEqual({ kind: "off" });
    });

    it.each([
      [
        "a non-2xx status",
        new Response("rate limited", { status: 429 }),
        { kind: "unavailable", message: "https://openrouter.test/api/v1/models returned 429" },
      ],
      [
        "a network failure",
        new Error("ECONNRESET"),
        {
          kind: "unavailable",
          message: expect.stringMatching(/^fetching https:\/\/openrouter\.test.*ECONNRESET/),
        },
      ],
      [
        "a list that isn't a { data: [...] } object",
        Response.json(upstream(["x-ai/grok-9"])),
        { kind: "rejected", message: expect.stringMatching(/not a \{ data/) },
      ],
      [
        "an empty list, even with no openrouter/ entries in the bundled snapshot",
        Response.json(openRouterList([])),
        { kind: "rejected", message: expect.stringMatching(/only 0 usable OpenRouter models/) },
      ],
    ])(
      "stores LiteLLM's entries, with nothing before to carry forward, and reports %s",
      async (_label, openRouter, error) => {
        const deps = makeDeps({
          response: Response.json(upstream([...Object.keys(BUNDLED), "openrouter/legacy/model"])),
          openRouter,
        });

        const result = (await refreshModelCatalog(deps))._unsafeUnwrap();

        expect(deps.store.replace.mock.calls[0]?.[1]).toEqual(BUNDLED);
        expect(deps.installed).toHaveLength(1);
        expect(result.openRouter).toEqual({ kind: "failed", error, carried: 0 });
      },
    );

    it("holds a list to half the bundled snapshot's openrouter/ entries", async () => {
      const bundled: LitellmCatalog = {
        ...BUNDLED,
        ...Object.fromEntries(
          ["a/1", "a/2", "a/3", "a/4"].map((id) => [`openrouter/${id}`, LIMITS]),
        ),
      };
      const deps = makeDeps({ bundled, openRouter: Response.json(openRouterList(["a/1"])) });

      const result = (await refreshModelCatalog(deps))._unsafeUnwrap();

      expect(result.openRouter).toEqual({
        kind: "failed",
        carried: 0,
        error: {
          kind: "rejected",
          message:
            "only 1 usable OpenRouter models, under the floor of 2 (half the bundled snapshot)",
        },
      });
      expect(deps.store.replace.mock.calls[0]?.[1]).toEqual(BUNDLED);
    });

    it("carries the previous catalog's openrouter/ entries forward when the list fails", async () => {
      const grok = { contextWindow: 256_000, maxOutputTokens: 16_000 };
      const deps = makeDeps({
        previous: { "model-a": LIMITS, "openrouter/x-ai/grok-9": grok },
        previousIds: ["model-a", "openrouter/x-ai/grok-9"],
        openRouter: new Response("unavailable", { status: 503 }),
      });

      const result = (await refreshModelCatalog(deps))._unsafeUnwrap();

      expect(deps.store.replace.mock.calls[0]?.[1]).toEqual({
        ...BUNDLED,
        "openrouter/x-ai/grok-9": grok,
      });
      expect(result.openRouter).toMatchObject({ kind: "failed", carried: 1 });
      expect(result.added).toEqual(["model-b", "model-c", "model-d"]);
    });

    it("carries nothing from a previous catalog that no longer parses", async () => {
      const deps = makeDeps({
        previous: new z.ZodError([]),
        openRouter: new Response("unavailable", { status: 503 }),
      });

      const result = (await refreshModelCatalog(deps))._unsafeUnwrap();

      expect(deps.store.replace.mock.calls[0]?.[1]).toEqual(BUNDLED);
      expect(result.openRouter).toMatchObject({ kind: "failed", carried: 0 });
    });

    it("leaves the previous catalog unread when the list arrives", async () => {
      const deps = makeDeps({ openRouter: Response.json(openRouterList(["x-ai/grok-9"])) });

      await refreshModelCatalog(deps);

      expect(deps.store.latest).not.toHaveBeenCalled();
    });

    it("stores nothing when LiteLLM's registry fails, whatever OpenRouter sends", async () => {
      const deps = makeDeps({
        response: new Response("unavailable", { status: 503 }),
        openRouter: Response.json(openRouterList(["x-ai/grok-9"])),
      });

      const error = (await refreshModelCatalog(deps))._unsafeUnwrapErr();

      expect(error.kind).toBe("unavailable");
      expect(deps.store.replace).not.toHaveBeenCalled();
      expect(deps.installed).toEqual([]);
    });

    it("counts LiteLLM's floor outside the openrouter/ namespace", async () => {
      const bundled: LitellmCatalog = {
        ...BUNDLED,
        ...Object.fromEntries(
          ["a/1", "a/2", "a/3", "a/4"].map((id) => [`openrouter/${id}`, LIMITS]),
        ),
      };
      const deps = makeDeps({
        bundled,
        response: Response.json(upstream(["model-a", "openrouter/a/1", "openrouter/a/2"])),
        openRouter: Response.json(openRouterList(["a/1", "a/2", "a/3", "a/4"])),
      });

      const error = (await refreshModelCatalog(deps))._unsafeUnwrapErr();

      expect(error).toMatchObject({
        kind: "rejected",
        message: expect.stringMatching(/only 1 usable entries/),
      });
    });
  });
});
