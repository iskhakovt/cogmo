import { afterEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { ImageProviderRow } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { buildImageProvider } from "./image-providers.js";

/**
 * `buildImageProvider` is a thin dispatch over `image_providers.type`. The
 * SDK adapter calls (`createFal`, `createOpenAICompatible`) are mocked at
 * the module level so we test the dispatch and the option assembly without
 * paying for real HTTP construction. Tests assert that the constructor is
 * called with the right arguments shape.
 */

const mockCreateFal = vi.fn();
const mockCreateOpenAICompatible = vi.fn();

vi.mock("@ai-sdk/fal", () => ({
  createFal: (...args: unknown[]) => mockCreateFal(...args),
}));
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: (...args: unknown[]) => mockCreateOpenAICompatible(...args),
}));

afterEach(() => {
  mockCreateFal.mockReset();
  mockCreateOpenAICompatible.mockReset();
});

function fakeFalSdk() {
  return { image: vi.fn() } as unknown as object;
}
function fakeOaiSdk() {
  return { imageModel: vi.fn() } as unknown as object;
}

const TX: Transactor = async (cb) => cb({} as never);

function row(overrides: Partial<ImageProviderRow>): ImageProviderRow {
  return {
    id: "provider-1",
    name: "fal",
    type: "fal",
    baseUrl: null,
    secretId: "secret-1",
    attrs: {},
    ...overrides,
  };
}

describe("buildImageProvider", () => {
  it("builds a fal provider with the decrypted API key", async () => {
    const sdkInstance = fakeFalSdk();
    mockCreateFal.mockReturnValueOnce(sdkInstance);
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecretById.mockResolvedValueOnce("sk-fal-real");

    const provider = await buildImageProvider(row({ type: "fal" }), {
      runInTx: TX,
      secretsStore,
    });

    expect(provider.kind).toBe("fal");
    expect(mockCreateFal).toHaveBeenCalledWith({ apiKey: "sk-fal-real" });
    expect(provider.provider).toBe(sdkInstance);
  });

  it("forwards the fal fetch override when provided", async () => {
    mockCreateFal.mockReturnValueOnce(fakeFalSdk());
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecretById.mockResolvedValueOnce("sk-fal-real");
    const fakeFetch = vi.fn() as unknown as typeof fetch;

    await buildImageProvider(row({ type: "fal" }), {
      runInTx: TX,
      secretsStore,
      fetchOverrides: { fal: fakeFetch },
    });

    expect(mockCreateFal).toHaveBeenCalledWith({
      apiKey: "sk-fal-real",
      fetch: fakeFetch,
    });
  });

  it("builds an openai_compatible provider with name/baseURL/apiKey", async () => {
    const sdkInstance = fakeOaiSdk();
    mockCreateOpenAICompatible.mockReturnValueOnce(sdkInstance);
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecretById.mockResolvedValueOnce("sk-venice-real");

    const provider = await buildImageProvider(
      row({
        name: "venice",
        type: "openai_compatible",
        baseUrl: "https://api.venice.ai/api/v1",
      }),
      { runInTx: TX, secretsStore },
    );

    expect(provider.kind).toBe("oai");
    expect(mockCreateOpenAICompatible).toHaveBeenCalledWith({
      name: "venice",
      apiKey: "sk-venice-real",
      baseURL: "https://api.venice.ai/api/v1",
    });
    expect(provider.provider).toBe(sdkInstance);
  });

  it("passes through attrs.headers when set", async () => {
    mockCreateOpenAICompatible.mockReturnValueOnce(fakeOaiSdk());
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecretById.mockResolvedValueOnce("sk");

    await buildImageProvider(
      row({
        name: "venice",
        type: "openai_compatible",
        baseUrl: "https://api.venice.ai/api/v1",
        attrs: { headers: { "X-Cogmo-Source": "test" } },
      }),
      { runInTx: TX, secretsStore },
    );

    expect(mockCreateOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { "X-Cogmo-Source": "test" },
      }),
    );
  });

  it("forwards the openai-compatible fetch override when provided", async () => {
    mockCreateOpenAICompatible.mockReturnValueOnce(fakeOaiSdk());
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecretById.mockResolvedValueOnce("sk");
    const fakeFetch = vi.fn() as unknown as typeof fetch;

    await buildImageProvider(
      row({
        name: "venice",
        type: "openai_compatible",
        baseUrl: "https://api.venice.ai/api/v1",
      }),
      {
        runInTx: TX,
        secretsStore,
        fetchOverrides: { openai_compatible: fakeFetch },
      },
    );

    expect(mockCreateOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({ fetch: fakeFetch }),
    );
  });

  it("throws when the secret is missing (key rotation lost the row)", async () => {
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecretById.mockResolvedValueOnce(undefined);

    await expect(
      buildImageProvider(row({ type: "fal" }), { runInTx: TX, secretsStore }),
    ).rejects.toThrow(/missing secret_id/);
  });

  it("rejects an openai_compatible row whose base_url is somehow null", async () => {
    // The DB CHECK + store guard make this unreachable in practice, but the
    // builder's defensive guard ensures we surface a useful error if a
    // future code path bypasses both layers.
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecretById.mockResolvedValueOnce("sk");

    await expect(
      buildImageProvider(row({ type: "openai_compatible", baseUrl: null }), {
        runInTx: TX,
        secretsStore,
      }),
    ).rejects.toThrow(/openai_compatible.*no base_url/);
  });

  it("builds a venice provider with the decrypted key and base URL", async () => {
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecretById.mockResolvedValueOnce("sk-venice");

    const provider = await buildImageProvider(
      row({
        name: "venice",
        type: "venice",
        baseUrl: "https://api.venice.ai/api/v1",
      }),
      { runInTx: TX, secretsStore },
    );

    expect(provider.kind).toBe("venice");
    // The adapter is hand-rolled (not an SDK constructor), so the assertion
    // shape is "the right thing got built" rather than "the SDK was called
    // with these args." The unit tests in venice.test.ts pin behaviour.
    expect(provider.row.name).toBe("venice");
    expect(provider.row.baseUrl).toBe("https://api.venice.ai/api/v1");
  });

  it("forwards the venice fetch override into the adapter", async () => {
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecretById.mockResolvedValueOnce("sk-venice");
    // Stub fetch returns a minimal valid Venice response so we can assert
    // the adapter actually used the injected fetch (not globalThis.fetch).
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ images: ["aGVsbG8="] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const provider = await buildImageProvider(
      row({
        name: "venice",
        type: "venice",
        baseUrl: "https://api.venice.ai/api/v1",
      }),
      { runInTx: TX, secretsStore, fetchOverrides: { venice: fakeFetch } },
    );
    if (provider.kind !== "venice") throw new Error("expected venice provider");

    await provider.provider.generate({ model: "flux", prompt: "hi" });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("threads attrs.imageGenerationDefaults into the venice adapter", async () => {
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecretById.mockResolvedValueOnce("sk-venice");

    // Stub fetch captures the body so we can confirm safe_mode lands on the
    // wire. The adapter's own unit tests pin the merge logic; here we just
    // verify the construction path threads `attrs` through.
    let capturedBody: Record<string, unknown> = {};
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({ images: ["aGVsbG8="] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const provider = await buildImageProvider(
      row({
        name: "venice",
        type: "venice",
        baseUrl: "https://api.venice.ai/api/v1",
        attrs: { imageGenerationDefaults: { safe_mode: false } },
      }),
      { runInTx: TX, secretsStore, fetchOverrides: { venice: fakeFetch } },
    );
    if (provider.kind !== "venice") throw new Error("expected venice provider");
    await provider.provider.generate({ model: "flux", prompt: "hi" });
    expect(capturedBody.safe_mode).toBe(false);
  });

  it("rejects a venice row whose base_url is somehow null", async () => {
    const secretsStore = mock<SecretsStore>();
    secretsStore.getSecretById.mockResolvedValueOnce("sk");

    await expect(
      buildImageProvider(row({ type: "venice", baseUrl: null }), {
        runInTx: TX,
        secretsStore,
      }),
    ).rejects.toThrow(/venice.*no base_url/);
  });
});
