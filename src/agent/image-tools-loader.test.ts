/**
 * Hot-reload contract for `ImageToolsLoader` — the per-turn catalog loader
 * that replaces the boot-time `createImageTools` call. Three behaviours
 * under test: refresh-on-CRUD, adapter caching, eviction-on-delete.
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentStore, ImageModelWithProvider, ImageProviderRow } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import type { SecretsStore } from "../secrets/store/index.js";
import type { AttachmentStore } from "../transport/attachment-store.js";
import { ImageToolsLoader } from "./image-tools-loader.js";

// Mock buildImageProvider so the loader test doesn't need real SDK
// construction; tracks call count so we can assert the cache.
const mockBuildImageProvider = vi.fn();
vi.mock("../llm/image-providers.js", () => ({
  buildImageProvider: (...args: unknown[]) => mockBuildImageProvider(...args),
}));

// Mock createImageTools — the loader composes it, but the per-turn test
// only cares whether the loader passes the right (models, providers) tuple
// into the rebuild.
const mockCreateImageTools = vi.fn();
vi.mock("./image-tools.js", () => ({
  createImageTools: (...args: unknown[]) => mockCreateImageTools(...args),
}));

const FAKE_TX = { __mockTx: true } as never;
const fakeTransactor: Transactor = ((cb: (t: never) => Promise<unknown>) => cb(FAKE_TX)) as never;

function providerRow(overrides: Partial<ImageProviderRow> = {}): ImageProviderRow {
  return {
    id: "p-1",
    name: "fal",
    type: "fal",
    baseUrl: null,
    secretId: "sec-1",
    attrs: {},
    ...overrides,
  };
}

function modelRow(overrides: Partial<ImageModelWithProvider> = {}): ImageModelWithProvider {
  return {
    id: "m-1",
    providerId: "p-1",
    name: "fal/flux-dev",
    modelString: "fal-ai/flux/dev",
    description: "balanced",
    capabilities: { aspectRatios: ["1:1"], seed: true },
    userSelectable: true,
    provider: providerRow(),
    ...overrides,
  };
}

function makeStore(opts: {
  providers: ImageProviderRow[];
  models: ImageModelWithProvider[];
}): AgentStore {
  return {
    listImageProviders: vi.fn().mockImplementation(async () => opts.providers),
    listImageModelsWithProvider: vi.fn().mockImplementation(async () => opts.models),
  } as unknown as AgentStore;
}

function makeLoader(store: AgentStore): ImageToolsLoader {
  return new ImageToolsLoader({
    runInTx: fakeTransactor,
    agentStore: store,
    secretsStore: {} as unknown as SecretsStore,
    attachments: {} as unknown as AttachmentStore,
  });
}

describe("ImageToolsLoader", () => {
  it("caches adapter instances across calls — buildImageProvider runs once per provider", async () => {
    mockBuildImageProvider.mockReset();
    mockCreateImageTools.mockReset();
    mockBuildImageProvider.mockResolvedValue({
      kind: "fal",
      row: providerRow(),
      provider: {},
    });
    mockCreateImageTools.mockReturnValue([]);

    const store = makeStore({ providers: [providerRow()], models: [modelRow()] });
    const loader = makeLoader(store);
    await loader.getTools();
    await loader.getTools();
    await loader.getTools();
    expect(mockBuildImageProvider).toHaveBeenCalledTimes(1);
    // listImageProviders + listImageModelsWithProvider DO re-run each turn —
    // that's the freshness guarantee.
    expect(store.listImageProviders).toHaveBeenCalledTimes(3);
    expect(store.listImageModelsWithProvider).toHaveBeenCalledTimes(3);
  });

  it("builds a new adapter when a new provider row appears (CRUD add reflected immediately)", async () => {
    mockBuildImageProvider.mockReset();
    mockCreateImageTools.mockReset();
    mockBuildImageProvider.mockImplementation(async (row: ImageProviderRow) => ({
      kind: row.type === "fal" ? "fal" : "oai",
      row,
      provider: {},
    }));
    mockCreateImageTools.mockReturnValue([]);

    let providers: ImageProviderRow[] = [providerRow()];
    let models: ImageModelWithProvider[] = [modelRow()];
    const store = {
      listImageProviders: vi.fn().mockImplementation(async () => providers),
      listImageModelsWithProvider: vi.fn().mockImplementation(async () => models),
    } as unknown as AgentStore;
    const loader = makeLoader(store);

    await loader.getTools(); // initial
    expect(mockBuildImageProvider).toHaveBeenCalledTimes(1);

    // Simulate `cogmo image-provider add openai_compatible venice ...`
    const newProvider = providerRow({
      id: "p-2",
      name: "venice",
      type: "openai_compatible",
      baseUrl: "https://api.venice.ai/api/v1",
      secretId: "sec-2",
    });
    providers = [...providers, newProvider];
    models = [...models, modelRow({ id: "m-2", providerId: "p-2", name: "venice/flux" })];

    await loader.getTools(); // post-mutation
    expect(mockBuildImageProvider).toHaveBeenCalledTimes(2);
    const lastCallArg = mockBuildImageProvider.mock.calls.at(-1)?.[0];
    expect(lastCallArg?.id).toBe("p-2");
  });

  it("evicts cached adapters when their provider row is deleted", async () => {
    mockBuildImageProvider.mockReset();
    mockCreateImageTools.mockReset();
    mockBuildImageProvider.mockImplementation(async (row: ImageProviderRow) => ({
      kind: "fal",
      row,
      provider: { tag: row.id },
    }));
    mockCreateImageTools.mockImplementation((deps: { providers: Map<string, unknown> }) => {
      // Capture the providers Map snapshot the loader passes in.
      return [{ providersSnapshotIds: [...deps.providers.keys()] }];
    });

    let providers: ImageProviderRow[] = [providerRow()];
    const store = {
      listImageProviders: vi.fn().mockImplementation(async () => providers),
      listImageModelsWithProvider: vi.fn().mockResolvedValue([]),
    } as unknown as AgentStore;
    const loader = makeLoader(store);

    await loader.getTools();
    // Simulate `cogmo image-provider remove fal`
    providers = [];
    await loader.getTools();

    const lastReturn = mockCreateImageTools.mock.results.at(-1)?.value;
    expect(lastReturn?.[0]?.providersSnapshotIds).toEqual([]); // cache evicted
  });

  it("returns whatever createImageTools returns (empty when no models)", async () => {
    mockBuildImageProvider.mockReset();
    mockCreateImageTools.mockReset();
    mockCreateImageTools.mockReturnValue([]);
    const store = makeStore({ providers: [], models: [] });
    const loader = makeLoader(store);
    await expect(loader.getTools()).resolves.toEqual([]);
    expect(mockBuildImageProvider).not.toHaveBeenCalled();
  });
});
